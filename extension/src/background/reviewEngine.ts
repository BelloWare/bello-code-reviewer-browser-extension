import type {
  BgRequest,
  BgResponse,
  ModelFinding,
  ModelTestResult,
  ReviewRequest,
  ReviewResult,
  TokenEstimate,
  TokenEstimateBreakdown,
  AnalyticsEventPayload
} from "../types";
import { getClientId, getModelConfig } from "../shared/storage";
import { logDebug } from "../shared/debugReporter";
import { loadReviewFilesForPR } from "./githubDiff";
import { filterFilesForReview } from "../lib/fileFilter";

type ProviderId = "openai" | "anthropic" | "gemini" | "openrouter" | "mock";

type ModelConfig = {
  provider: ProviderId;
  model: string;
  alias?: string;
  apiKey?: string;
  endpoint?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  extraJson?: string;
};

type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };
type LlmResponse = {
  summary: string;
  findings: ModelFinding[];
  usage: TokenUsage;
  error?: string;
  modelId?: string;
  parseError?: boolean;
};

const GA_MEASUREMENT_ID = "G-E4S6TDZPRM";
const GA_API_SECRET = "KmM7ixNKS6-IGT9g9LJQWw";
const GA_ENDPOINT = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
  GA_MEASUREMENT_ID
)}&api_secret=${encodeURIComponent(GA_API_SECRET)}`;

let analyticsWarned = false;

function normalizeEventName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+/, "");
  return cleaned.slice(0, 40);
}

function sanitizeParams(params?: Record<string, unknown>): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!params) return safe;
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    const paramKey = key.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 40);
    if (!paramKey) return;
    if (typeof value === "string") safe[paramKey] = value.slice(0, 100);
    else if (typeof value === "number" && Number.isFinite(value)) safe[paramKey] = value;
    else if (typeof value === "boolean") safe[paramKey] = value;
  });
  return safe;
}

async function sendAnalyticsEvent(event: AnalyticsEventPayload): Promise<void> {
  const name = normalizeEventName(event.name ?? "");
  if (!name) return;
  try {
    const clientId = await getClientId();
    const params = sanitizeParams(event.params);
    const body = {
      client_id: clientId,
      events: [{ name, params: Object.keys(params).length ? params : undefined }]
    };
    await fetch(GA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // no-cors avoids CORS preflight blocks in extension contexts
      mode: "no-cors"
    }).catch((err) => {
      if (!analyticsWarned) {
        console.debug("[bello] analytics send failed", err);
        analyticsWarned = true;
      }
    });
  } catch (err) {
    if (!analyticsWarned) {
      console.debug("[bello] analytics error", err);
      analyticsWarned = true;
    }
  }
}

const normalizeNumber = (val: unknown): number | undefined => {
  const num = typeof val === "string" && val.trim() !== "" ? Number(val) : val;
  return typeof num === "number" && Number.isFinite(num) ? num : undefined;
};

const parseExtraJson = (model: ModelConfig): Record<string, unknown> | null => {
  const raw = model.extraJson;
  if (!raw || !String(raw).trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (err) {
    void logDebug("background", "warn", "Failed to parse extraJson", {
      model: model.model,
      provider: model.provider,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  return null;
};

const REVIEW_JSON_SCHEMA: Record<string, any> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          side: { type: "string", enum: ["left", "right"] },
          line: { type: "integer", minimum: 1 },
          category: { type: "string", enum: ["bug", "typo"] },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          title: { type: "string" },
          description: { type: "string" },
          suggestionCode: { type: "string" },
          suggestionExplanation: { type: "string" }
        },
        required: ["filePath", "side", "line", "category", "severity", "confidence", "title", "description"],
        additionalProperties: false
      }
    }
  },
  required: ["summary", "findings"],
  additionalProperties: false
};

const toModelConfig = (cfg: {
  provider: ProviderId;
  model: string;
  alias?: string;
  apiKey?: string;
  endpoint?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  extraJson?: string;
}): ModelConfig => ({
  provider: cfg.provider as ProviderId,
  model: cfg.model,
  alias: cfg.alias,
  endpoint: cfg.endpoint,
  apiKey: cfg.apiKey,
  maxTokens: normalizeNumber(cfg.maxTokens),
  temperature: normalizeNumber(cfg.temperature),
  seed: normalizeNumber(cfg.seed),
  extraJson: cfg.extraJson
});

type LoadedModels = {
  mode: "single" | "ensemble";
  reviewers: ModelConfig[];
  arbiter?: ModelConfig;
};

const inMemoryReviewCache = new Map<string, ReviewResult>();

const cacheKey = (pr: ReviewRequest["pr"]): string =>
  `${pr.platform}:${pr.host}:${pr.repo}#${pr.number}`;

async function loadModels(): Promise<LoadedModels> {
  const stored = await getModelConfig();
  if (!stored || !stored.reviewers.length) {
    return { mode: "single", reviewers: [] };
  }
  const reviewers = stored.reviewers.map((r) => toModelConfig(r));
  const arbiter = stored.arbiter ? toModelConfig(stored.arbiter) : undefined;
  const mode = stored.mode ?? (reviewers.length > 1 ? "ensemble" : "single");
  return {
    mode: reviewers.length > 1 ? "ensemble" : mode,
    reviewers,
    arbiter
  };
}

export async function handleMessage(message: BgRequest): Promise<BgResponse> {
  if (message.type === "PING") return { type: "PONG" };
  if (message.type === "TRACK_EVENT") {
    void sendAnalyticsEvent(message.payload);
    return { type: "ANALYTICS_OK" };
  }
  if (message.type === "CANCEL_REVIEW") return { type: "REVIEW_ERROR", payload: { message: "cancel not implemented" } };
  if (message.type === "GET_LAST_REVIEW") {
    const cached = inMemoryReviewCache.get(cacheKey(message.payload.pr));
    if (cached) {
      void logDebug("background", "info", "GET_LAST_REVIEW hit", {
        repo: message.payload.pr.repo,
        number: message.payload.pr.number,
        platform: message.payload.pr.platform
      });
      return { type: "LAST_REVIEW_RESULT", payload: cached };
    }
    return { type: "REVIEW_ERROR", payload: { message: "No cached review found for this PR or cache expired." } };
  }

  if (message.type === "FETCH_PR_DIFF") {
    void logDebug("background", "info", "FETCH_PR_DIFF start", {
      repo: message.payload.pr.repo,
      number: message.payload.pr.number,
      platform: message.payload.pr.platform,
      paths: message.payload.paths?.length ?? 0
    });
    if (message.payload.pr.platform !== "github" && message.payload.pr.platform !== "gitlab") {
      return { type: "REVIEW_ERROR", payload: { message: `Unsupported platform: ${message.payload.pr.platform}. Only GitHub and GitLab PRs/MRs are supported.` } };
    }
    try {
      const { files, skipped } = await loadReviewFilesForPR(message.payload.pr, {
        onlyPaths: message.payload.paths?.length ? new Set(message.payload.paths) : undefined,
        skip: message.payload.skip
      });
      void logDebug("background", "info", "FETCH_PR_DIFF done", {
        repo: message.payload.pr.repo,
        number: message.payload.pr.number,
        platform: message.payload.pr.platform,
        files: files.length,
        skipped: skipped.length
      });
      return { type: "DIFF_RESULT", payload: { files, skippedFiles: skipped } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      void logDebug("background", "error", "FETCH_PR_DIFF failed", {
        repo: message.payload.pr.repo,
        number: message.payload.pr.number,
        platform: message.payload.pr.platform,
        err: error
      });
      return { type: "REVIEW_ERROR", payload: { message: error } };
    }
  }

  if (message.type === "TEST_MODEL_SINGLE") {
    const raw = message.payload.model;
    const model = toModelConfig(raw);
    const forcedFailure = model.model.startsWith("mock://fail") || model.endpoint?.startsWith("mock://fail");
    const failEndpoint = model.endpoint?.includes("/fail");
    const pingResult = !model.model?.trim()
      ? { ok: false, error: "No model configured." }
      : forcedFailure
        ? { ok: false, error: "Model test failed (mock fail endpoint)" }
        : failEndpoint
          ? { ok: false, error: "Model test failed (fail endpoint)" }
          : await pingModel(model).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

    const result: ModelTestResult = {
      target: message.payload.target,
      index: message.payload.index,
      model: model.model,
      provider: model.provider,
      status: pingResult.ok ? "passed" : "failed",
      error: pingResult.error,
      detail: pingResult.detail
    };

    return {
      type: "TEST_MODEL_RESULT",
      payload: {
        ok: pingResult.ok,
        error: pingResult.ok ? undefined : pingResult.error ?? "Model test failed",
        results: [result]
      }
    };
  }

  if (message.type === "TEST_MODEL") {
    const reviewers = (message.payload.reviewers ?? []).filter((r) => r.model?.trim().length > 0);
    const first = reviewers[0];
    if (!first) return { type: "TEST_MODEL_RESULT", payload: { ok: false, error: "No reviewer configured." } };
    if (reviewers.some((r) => r.endpoint?.startsWith("mock://"))) {
      console.log("[bello][TEST_MODEL mock]", JSON.stringify(message.payload));
    }
    const needsArbiter = message.payload.mode === "ensemble" || reviewers.length > 1;
    if (needsArbiter && !message.payload.arbiter) {
      return { type: "TEST_MODEL_RESULT", payload: { ok: false, error: "Consolidation model is required for ensembles." } };
    }
    const modelsToTest: Array<{ model: ModelConfig; target: ModelTestResult["target"]; index: number }> = reviewers.map((rev, idx) => ({
      model: toModelConfig(rev),
      target: "reviewer",
      index: idx
    }));
    if (needsArbiter && message.payload.arbiter) {
      modelsToTest.push({ model: toModelConfig(message.payload.arbiter), target: "arbiter", index: 0 });
    }

    const results = await Promise.all(
      modelsToTest.map(async ({ model, target, index }) => {
        const forcedFailure = model.model.startsWith("mock://fail") || model.endpoint?.startsWith("mock://fail");
        const failEndpoint = model.endpoint?.includes("/fail");
        const pingResult = forcedFailure
          ? { ok: false, error: "Model test failed (mock fail endpoint)" }
          : failEndpoint
            ? { ok: false, error: "Model test failed (fail endpoint)" }
            : await pingModel(model).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));

        return {
          target,
          index,
          model: model.model,
          provider: model.provider,
          status: pingResult.ok ? "passed" : "failed",
          error: pingResult.error,
          detail: pingResult.detail
        };
      })
    );

    const firstFailure = results.find((r) => r.status === "failed");
    if (firstFailure) {
      return { type: "TEST_MODEL_RESULT", payload: { ok: false, error: firstFailure.error ?? "Model test failed", results } };
    }

    return { type: "TEST_MODEL_RESULT", payload: { ok: true, results } };
  }

  if (message.type === "ESTIMATE_REVIEW") {
    const { mode, reviewers, arbiter } = await loadModels();
    if (!reviewers.length) {
      return { type: "REVIEW_ERROR", payload: { message: "Please configure a model/provider in settings before running Bello." } };
    }
    const modelsForEstimate = mode === "ensemble" && arbiter ? [...reviewers, arbiter] : reviewers;
    const prepared = await prepareDiffFiles(message.payload);
    const estimate = estimateTokens({ ...message.payload, diffFiles: prepared.diffFiles }, modelsForEstimate);
    return { type: "ESTIMATE_RESULT", payload: { estimate, skippedFiles: prepared.skippedFiles } };
  }

  if (message.type === "RUN_REVIEW") {
    void logDebug("background", "info", "RUN_REVIEW received", {
      repo: message.payload.pr.repo,
      number: message.payload.pr.number,
      platform: message.payload.pr.platform,
      incomingFiles: message.payload.diffFiles.length
    });
    const baseReq = message.payload;
    const prepared = await prepareDiffFiles(baseReq);
    const req: ReviewRequest = { ...baseReq, diffFiles: prepared.diffFiles };
    if (!req.diffFiles.length) {
      const message =
        prepared.skippedFiles.length > 0 ? "All files were skipped by the current review rules." : "No diff files found for this pull request.";
      return { type: "REVIEW_ERROR", payload: { message } };
    }
    void logDebug("background", "info", "RUN_REVIEW start", {
      repo: req.pr.repo,
      number: req.pr.number,
      platform: req.pr.platform,
      files: req.diffFiles.length
    });
    const { mode, reviewers, arbiter } = await loadModels();
    if (!reviewers.length) {
      return { type: "REVIEW_ERROR", payload: { message: "Please configure a model/provider in settings before running Bello." } };
    }
    const modelsForEstimate = mode === "ensemble" && arbiter ? [...reviewers, arbiter] : reviewers;
    const results = await Promise.all(
      reviewers.map(async (model) => {
        try {
          const resp = await runModelReview(req, model);
          return { ...resp, modelId: model.model };
        } catch (err) {
          return {
            summary: "",
            findings: [],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            error: err instanceof Error ? err.message : String(err),
            modelId: model.model
          };
        }
      })
    );

    const errors = results.filter((r) => r.error);
    if (errors.length) {
      void logDebug("background", "warn", "Some reviewer calls failed", {
        total: results.length,
        errors: errors.map((e) => e.error)
      });
    }
    const successes = results.filter((r) => !r.error);
    if (errors.length === reviewers.length) {
      const message = errors.map((e) => e.error).filter(Boolean).join("; ") || "Unknown LLM error";
      return { type: "REVIEW_ERROR", payload: { message: `LLM call failed: ${message}` } };
    }

    const rawFindings = successes.flatMap((r) => r.findings);
    const ruleMerged = mergeFindings(rawFindings);
    let finalFindings = ruleMerged;
    let summary = successes.map((r) => r.summary).find(Boolean) ?? generateSummaryFromFindings(ruleMerged);

    if (mode === "ensemble" && arbiter && successes.length > 1 && rawFindings.length > 0) {
      try {
        const arbiterResult = await runArbiterConsolidation(
          req,
          ruleMerged,
          successes.map((r) => ({ modelId: r.modelId ?? "unknown", findings: r.findings })),
          arbiter
        );
        if (arbiterResult.findings.length) {
          finalFindings = arbiterResult.findings;
          if (arbiterResult.summary?.trim()) {
            summary = arbiterResult.summary.trim();
          }
        }
      } catch (err) {
        void logDebug("background", "warn", "Arbiter consolidation failed", {
          error: err instanceof Error ? err.message : String(err)
        });
        void sendAnalyticsEvent({ name: "review_error", params: { platform: req.pr.platform, stage: "merge" } });
      }
    }

    const estimate = estimateTokens(req, modelsForEstimate);
    const variants: ReviewResult["variants"] = [
      {
        id: "consolidated",
        label: "Consolidated",
        type: "consolidated",
        summary,
        findings: finalFindings
      }
    ];

    if (reviewers.length > 1) {
      results.forEach((r, idx) => {
        const reviewerModel = reviewers[idx];
        const label = reviewerModel?.alias?.trim() || reviewerModel?.model || `Model ${idx + 1}`;
        const reviewerSummary = r.summary?.trim().length ? r.summary : generateSummaryFromFindings(r.findings);
        variants.push({
          id: `reviewer-${idx}`,
          label,
          type: "reviewer",
          modelId: r.modelId,
          summary: reviewerSummary,
          findings: r.findings,
          error: r.error
        });
      });
    }

    const result: ReviewResult = {
      summary,
      findings: finalFindings,
      skippedFiles: prepared.skippedFiles,
      usageEstimate: estimate,
      variants
    };
    inMemoryReviewCache.set(cacheKey(req.pr), result);
    void logDebug("background", "info", "RUN_REVIEW done", {
      findings: finalFindings.length,
      totalTokens: estimate.totalTokens
    });
    void sendAnalyticsEvent({ name: "review_completed", params: { platform: req.pr.platform, reviewer_count: reviewers.length } });
    return { type: "REVIEW_DONE", payload: result };
  }

  return { type: "ERROR", error: "Unsupported message" };
}

async function prepareDiffFiles(
  request: ReviewRequest
): Promise<{ diffFiles: ReviewRequest["diffFiles"]; skippedFiles: Array<{ path: string; reason: string }> }> {
  const applyFileFilter = (
    files: ReviewRequest["diffFiles"],
    skipped: Array<{ path: string; reason: string }> = []
  ): { diffFiles: ReviewRequest["diffFiles"]; skippedFiles: Array<{ path: string; reason: string }> } => {
    const { included, skipped: autoSkipped } = filterFilesForReview(files);
    return { diffFiles: included, skippedFiles: [...skipped, ...autoSkipped] };
  };

  const supportedPlatform = request.pr.platform === "github" || request.pr.platform === "gitlab";
  if (supportedPlatform) {
    const selected = new Set(request.diffFiles.map((f) => f.path));
    try {
      const { files, skipped } = await loadReviewFilesForPR(request.pr, {
        onlyPaths: selected.size ? selected : undefined,
        skip: request.policy.skipPatterns
      });
      if (!files.length && !skipped.length) {
        void logDebug("background", "warn", "Diff fetch returned no files", {
          repo: request.pr.repo,
          number: request.pr.number,
          platform: request.pr.platform
        });
        return applyFileFilter(request.diffFiles, skipped);
      }
      void logDebug("background", "info", "Diff prepared", {
        repo: request.pr.repo,
        number: request.pr.number,
        platform: request.pr.platform,
        selected: selected.size,
        fetched: files.length,
        skipped: skipped.length
      });
      return applyFileFilter(files, skipped);
    } catch (err) {
      void logDebug("background", "error", "Failed to fetch diff from platform", {
        repo: request.pr.repo,
        number: request.pr.number,
        platform: request.pr.platform,
        err: err instanceof Error ? err.message : String(err)
      });
      void sendAnalyticsEvent({ name: "review_error", params: { platform: request.pr.platform, stage: "diff_fetch" } });
      return applyFileFilter(request.diffFiles);
    }
  }
  return applyFileFilter(request.diffFiles);
}

async function runModelReview(request: ReviewRequest, model: ModelConfig): Promise<LlmResponse> {
  if (model.endpoint?.startsWith("mock://")) {
    const shouldFail = model.endpoint.includes("fail");
    if (shouldFail) {
      return {
        summary: "",
        findings: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        error: "Mock endpoint failure",
        modelId: model.model,
        parseError: false
      };
    }
    const mock = mockModelResponse(request, model);
    return { ...mock, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, error: undefined, modelId: model.model, parseError: false };
  }

  void logDebug("background", "info", "LLM request", {
    provider: model.provider,
    model: model.model,
    endpoint: model.endpoint,
    files: request.diffFiles.length
  });

  if (model.provider === "mock") {
    const result = { ...mockModelResponse(request, model), usage: { promptTokens: 500, completionTokens: 200, totalTokens: 700 }, error: undefined };
    void logDebug("background", "info", "LLM response (mock)", {
      provider: model.provider,
      model: model.model,
      findings: result.findings.length,
      usage: result.usage.totalTokens
    });
    return { ...result, modelId: model.model, parseError: false };
  }

  const prompt = buildReviewPrompt(request, model);

  let resp: LlmResponse = { summary: "", findings: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, error: undefined, parseError: false };
  let trackedLlmError = false;
  try {
    switch (model.provider) {
      case "openai":
        resp = await callOpenAI(prompt, model);
        break;
      case "openrouter":
        resp = await callOpenRouter(prompt, model);
        break;
      case "anthropic":
        resp = await callAnthropic(prompt, model);
        break;
      case "gemini":
        resp = await callGemini(prompt, model);
        break;
      default:
        resp = { summary: "", findings: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, error: "Unsupported provider" };
        break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    void logDebug("background", "error", "LLM call failed", { provider: model.provider, model: model.model, err: error });
    void sendAnalyticsEvent({ name: "review_error", params: { platform: request.pr.platform, stage: "llm_call" } });
    trackedLlmError = true;
    resp = { summary: "", findings: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, error };
  }

  resp = { ...resp, findings: filterFindingsToDiff(resp.findings, request.diffFiles) };

  void logDebug("background", "info", "LLM response", {
    provider: model.provider,
    model: model.model,
    findings: resp.findings.length,
    usage: resp.usage.totalTokens,
    error: resp.error
  });
  if (resp.error && !trackedLlmError) {
    void sendAnalyticsEvent({ name: "review_error", params: { platform: request.pr.platform, stage: "llm_call" } });
  }
  if (resp.parseError) {
    void sendAnalyticsEvent({ name: "review_error", params: { platform: request.pr.platform, stage: "parse_llm" } });
  }
  return { ...resp, modelId: resp.modelId ?? model.model };
}

function mockModelResponse(request: ReviewRequest, model: ModelConfig): { summary: string; findings: ModelFinding[] } {
  const res: ModelFinding[] = [];
  request.diffFiles.forEach((file) => {
    file.hunks.forEach((hunk) => {
      hunk.newLines.forEach((line, idx) => {
        if (/console\.log/.test(line)) {
          res.push({
            id: `${file.path}-${hunk.startLineNew + idx}-console`,
            modelId: model.model,
            filePath: file.path,
            startLine: hunk.startLineNew + idx,
            endLine: hunk.startLineNew + idx,
            side: "right",
            category: "bug",
            severity: "major",
            confidence: 0.6,
            title: "Debug logging left in code",
            description: "console.log remains in the diff; remove before merge.",
            suggestionCode: line.replace(/console\.log.*$/, "// remove debug logging"),
            suggestionExplanation: "Debug logging should be removed in production code."
          });
        }
        if (/TODO|FIXME/i.test(line)) {
          res.push({
            id: `${file.path}-${hunk.startLineNew + idx}-todo`,
            modelId: model.model,
            filePath: file.path,
            startLine: hunk.startLineNew + idx,
            endLine: hunk.startLineNew + idx,
            side: "right",
            category: "bug",
            severity: "major",
            confidence: 0.5,
            title: "TODO present",
            description: "Found TODO/FIXME; ensure task is completed or tracked.",
            suggestionExplanation: "Address TODO or create a follow-up issue."
          });
        }
      });
    });
  });
  const findings = res;
  const files = new Set(findings.map((f) => f.filePath)).size;
  const summary = findings.length
    ? `Mock review flagged ${findings.length} issue${findings.length === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}.`
    : "Mock review found no issues.";
  return { summary, findings };
}

function mergeFindings(findings: ModelFinding[]): ReviewResult["findings"] {
  const groups = new Map<string, ModelFinding[]>();
  findings.forEach((f) => {
    const start = Number.isFinite(f.startLine) ? Math.max(1, f.startLine) : 0;
    const end = Number.isFinite(f.endLine) ? Math.max(start, f.endLine) : start;
    if (!f.filePath || start <= 0) return;
    const side: ModelFinding["side"] = f.side === "left" ? "left" : "right";
    const normalized: ModelFinding = { ...f, startLine: start, endLine: end, side };
    const key = `${normalized.filePath}:${side}:${normalized.startLine}-${normalized.endLine}:${normalized.category}`;
    const existing = groups.get(key) ?? [];
    existing.push(normalized);
    groups.set(key, existing);
  });

  const merged: ReviewResult["findings"] = [];
  groups.forEach((items, key) => {
    const [filePath, sideKey, range, category] = key.split(":");
    const [start, end] = range.split("-").map(Number);
    const highest = items.reduce((acc, cur) => (severityRank(cur.severity) > severityRank(acc.severity) ? cur : acc), items[0]);
    const avgConfidence = items.reduce((s, c) => s + c.confidence, 0) / items.length;
    merged.push({
      id: `merged-${filePath}-${sideKey}-${start}-${end}-${category}`,
      filePath,
      startLine: start,
      endLine: end,
      side: sideKey === "left" ? "left" : "right",
      category: highest.category,
      severity: highest.severity,
      confidence: Number(avgConfidence.toFixed(2)),
      title: highest.title,
      description: highest.description,
      suggestionCode: highest.suggestionCode,
      suggestionExplanation: highest.suggestionExplanation,
      modelId: highest.modelId,
      sourceModels: items.map((i) => i.modelId),
      modelVotes: items.map((i) => ({ modelId: i.modelId, severity: i.severity, confidence: i.confidence }))
    });
  });
  return merged;
}

function generateSummaryFromFindings(findings: Array<Pick<ModelFinding, "severity" | "filePath">>): string {
  if (!findings.length) return "No issues detected.";
  const blockers = findings.filter((f) => f.severity === "blocker").length;
  const majors = findings.filter((f) => f.severity === "major").length;
  const minors = findings.filter((f) => f.severity === "minor").length;
  const files = new Set(findings.map((f) => f.filePath)).size;

  const criticalParts = [];
  if (blockers) criticalParts.push(`${blockers} blocker${blockers === 1 ? "" : "s"}`);
  if (majors) criticalParts.push(`${majors} major issue${majors === 1 ? "" : "s"}`);
  const critical = criticalParts.length ? criticalParts.join(" and ") : "no blockers or major issues";
  const minorPart = minors ? `${criticalParts.length ? " plus " : ""}${minors} minor suggestion${minors === 1 ? "" : "s"}` : "";
  const filePart = files ? ` across ${files} file${files === 1 ? "" : "s"}` : "";

  return `Found ${critical}${minorPart}${filePart}.`;
}

function severityRank(s: ModelFinding["severity"]): number {
  if (s === "blocker") return 3;
  if (s === "major") return 2;
  return 1;
}

function estimateTokens(request: ReviewRequest, models: ModelConfig[]): TokenEstimate {
  const base = estimateBreakdown(request);
  const perModel: Record<string, TokenEstimateBreakdown> = {};
  models.forEach((m) => {
    const completion = m.maxTokens ?? 512;
    perModel[`${m.provider}:${m.model}`] = {
      ...base,
      promptTokens: base.promptTokens,
      diffTokens: base.diffTokens,
      rulesTokens: base.rulesTokens,
      domainTokens: base.domainTokens
    };
    perModel[`${m.provider}:${m.model}`].promptTokens += completion;
  });

  const totalTokens =
    Object.values(perModel).reduce((sum, est) => sum + est.promptTokens + est.diffTokens + est.rulesTokens + est.domainTokens, 0);

  return { totalTokens, breakdown: base, perModel };
}

function estimateBreakdown(request: ReviewRequest): TokenEstimateBreakdown {
  const promptTokens = roughTokenCount(
    [
      request.pr.repo,
      String(request.pr.number),
      request.customPrompt ?? ""
    ].join(" ")
  );
  const diffTokens = roughTokenCount(
    request.diffFiles
      .flatMap((f) => f.hunks.flatMap((h) => [...h.oldLines, ...h.newLines]))
      .join("\n")
  );
  const rulesTokens = roughTokenCount((request.customRules ?? []).join("\n"));
  const domainTokens = roughTokenCount((request.domainContext ?? []).join("\n"));
  return { promptTokens, diffTokens, rulesTokens, domainTokens };
}

function roughTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatDiffForPrompt(diffFiles: ReviewRequest["diffFiles"]): string {
  return diffFiles
    .map((f) => {
      const hunks = f.hunks
        .map((h) => {
          const oldBlock =
            h.oldLines.length > 0
              ? h.oldLines.map((line, idx) => `- L${h.startLineOld + idx}: ${line}`).join("\n")
              : "  (no old/left lines in this hunk)";

          const newBlock =
            h.newLines.length > 0
              ? h.newLines.map((line, idx) => `+ R${h.startLineNew + idx}: ${line}`).join("\n")
              : "  (no new/right lines in this hunk)";

          return [`@@ File: ${f.path} @@`, "OLD (left / base version):", oldBlock, "", "NEW (right / PR version):", newBlock].join("\n");
        })
        .join("\n\n");

      return hunks;
    })
    .join("\n\n");
}

type LineRange = { start: number; end: number };
type DiffLineRanges = { left: LineRange[]; right: LineRange[] };

function normalizeDiffPath(path: string): string {
  return path.trim().replace(/^(?:\.\/)+/, "").replace(/^(?:a|b)\//, "");
}

function lineInRanges(line: number, ranges: LineRange[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

function buildDiffLineRanges(diffFiles: ReviewRequest["diffFiles"]): {
  canonicalByNormalized: Map<string, string>;
  rangesByCanonical: Map<string, DiffLineRanges>;
} {
  const canonicalByNormalized = new Map<string, string>();
  const rangesByCanonical = new Map<string, DiffLineRanges>();

  diffFiles.forEach((file) => {
    const canonical = file.path;
    const normalized = normalizeDiffPath(canonical);
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, canonical);
    }

    const left: LineRange[] = [];
    const right: LineRange[] = [];
    file.hunks.forEach((h) => {
      if (h.oldLines.length > 0) {
        left.push({ start: h.startLineOld, end: h.startLineOld + h.oldLines.length - 1 });
      }
      if (h.newLines.length > 0) {
        right.push({ start: h.startLineNew, end: h.startLineNew + h.newLines.length - 1 });
      }
    });

    rangesByCanonical.set(canonical, { left, right });
  });

  return { canonicalByNormalized, rangesByCanonical };
}

function filterFindingsToDiff(findings: ModelFinding[], diffFiles: ReviewRequest["diffFiles"]): ModelFinding[] {
  if (!findings.length) return findings;
  if (!diffFiles.length) return [];

  const { canonicalByNormalized, rangesByCanonical } = buildDiffLineRanges(diffFiles);

  return findings.flatMap((finding) => {
    const normalized = normalizeDiffPath(String(finding.filePath ?? ""));
    const canonical = canonicalByNormalized.get(normalized);
    if (!canonical) return [];
    const ranges = rangesByCanonical.get(canonical);
    if (!ranges) return [];

    const side: "left" | "right" = finding.side === "left" ? "left" : "right";
    const sideRanges = side === "left" ? ranges.left : ranges.right;
    if (!sideRanges.length) return [];

    const start = Number.isFinite(finding.startLine) ? finding.startLine : 0;
    const end = Number.isFinite(finding.endLine) ? finding.endLine : start;
    if (start <= 0 || end <= 0) return [];
    if (!lineInRanges(start, sideRanges) || !lineInRanges(end, sideRanges)) return [];

    if (finding.filePath === canonical) return [finding];
    return [{ ...finding, filePath: canonical }];
  });
}

function buildReviewPrompt(request: ReviewRequest, model: ModelConfig): { system: string; user: string } {
  const rules = (request.customRules ?? []).join("\n");
  const domain = (request.domainContext ?? []).join("\n");
  const customPrompt = request.customPrompt?.trim() ?? "";
  const filesText = formatDiffForPrompt(request.diffFiles);

  const example = `
Example response shape:

{
  "summary": "Found a leftover console.log in the video control message handler.",
  "findings": [
    {
      "filePath": "src/js/videoControl.js",
      "side": "right",
      "line": 36,
      "category": "bug",
      "severity": "minor",
      "confidence": 0.95,
      "title": "Leftover console.log in production code",
      "description": "There are console.log calls (e.g., console.log(request)) in message handlers. Leaving debug logging in production can clutter logs and may leak sensitive info.",
      "suggestionCode": "// Remove or guard debug logging\\n// console.log(request);",
      "suggestionExplanation": "Remove or guard debug logging so production runs don't emit unnecessary or sensitive logs."
    }
  ]
}
`.trim();

  const system = [
    "You are a code review assistant.",
    "Assume the PR/MR build succeeds (CI/build pipeline will catch compilation issues). Ignore findings that are purely compile/type errors such as missing methods, missing libraries/modules, unresolved imports, or unknown symbols.",
    "Only report issues that are directly supported by the provided diff. Do not speculate about code that is not shown. Do not invent file paths or line numbers: every finding MUST point to an exact line that exists in the diff (L... for left/old, R... for right/new). If you cannot ground a finding to a specific diff line, omit it.",
    "The summary must only mention issues that appear in 'findings'.",
    "Return a single JSON object with:",
    "  - 'summary': a 1-3 sentence summary of the most important issues.",
    "  - 'findings': an array of finding objects.",
    "Each finding MUST include these fields:",
    "  - filePath: exact relative file path, e.g. 'src/js/videoControl.js'.",
    "  - side: 'left' for the OLD/base version (L...), or 'right' for the NEW/PR version (R...).",
    "  - line: 1-based line number on that side (use the numbers shown in the diff after L... or R...).",
    "  - category: 'bug' or 'typo'.",
    "  - severity: 'blocker', 'major', or 'minor'.",
    "  - confidence: a number between 0 and 1.",
    "  - title: a short one-line title.",
    "  - description: a few sentences explaining the problem and impact.",
    "  - suggestionCode: optional code or patch-style snippet that fixes the issue.",
    "  - suggestionExplanation: a short explanation of the suggested fix.",
    "Do NOT include 'id', 'startLine', or 'endLine' fields in your JSON; Bello will fill those internally.",
    "If there are no issues, return a concise summary and {\"findings\": []}.",
    "Respond ONLY with JSON (no markdown, no comments, no natural language outside the JSON)."
  ].join(" ");

  const userParts = [
    `Repository: ${request.pr.repo} PR #${request.pr.number} (branch ${request.pr.branch ?? "unknown"})`,
    rules ? `Custom rules:\n${rules}` : "",
    domain ? `Domain context:\n${domain}` : "",
    customPrompt ? `Custom focus:\n${customPrompt}` : "",
    "Return JSON in the shape shown in the example below (same fields, but with your own findings):",
    example,
    "Diff:\n" + filesText
  ].filter(Boolean);

  return { system, user: userParts.join("\n\n") };
}

function buildEnsembleConsolidationPrompt(
  request: ReviewRequest,
  mergedByRule: ReviewResult["findings"],
  rawResults: Array<{ modelId: string; findings: ModelFinding[] }>
): { system: string; user: string } {
  const filesText = formatDiffForPrompt(request.diffFiles);

  const system = [
    "You are a senior code review arbiter.",
    "Several reviewer models have proposed findings on the same diff.",
    "Your job is to consolidate them into a single, high-quality list:",
    "- Remove duplicate findings (same file and location, same underlying issue).",
    "- Remove findings that are not supported by the diff or are clearly incorrect.",
    "- Enforce diff grounding: remove any finding whose filePath/side/line cannot be verified against the diff below.",
    "- Optionally adjust severity and confidence if some models disagree.",
    "- Assume the PR/MR build succeeds; remove findings that are purely compile/type errors (missing methods, missing libraries/modules, unresolved imports, unknown symbols, etc.).",
    "The summary must only mention issues that appear in 'findings'.",
    "Return a single JSON object with 'summary' and 'findings'. Each finding must include: filePath, side ('left' or 'right'), line (1-based on that side), category, severity, confidence, title, description, suggestionCode, suggestionExplanation.",
    "Do NOT include id/startLine/endLine fields; Bello will add those.",
    "Respond ONLY with JSON."
  ].join(" ");

  const rawFindingsText = rawResults
    .map(
      (r) =>
        `Model: ${r.modelId}\n` +
        JSON.stringify(
          r.findings.map((f) => ({
            id: f.id,
            filePath: f.filePath,
            side: f.side,
            line: f.startLine,
            category: f.category,
            severity: f.severity,
            confidence: f.confidence,
            title: f.title,
            description: f.description,
            suggestionCode: f.suggestionCode,
            suggestionExplanation: f.suggestionExplanation
          })),
          null,
          2
        )
    )
    .join("\n\n");

  const ruleMergedText = JSON.stringify(mergedByRule, null, 2);

  const user = [
    `Repository: ${request.pr.repo} PR #${request.pr.number} (branch ${request.pr.branch ?? "unknown"})`,
    "Diff:\n" + filesText,
    "Here are the raw findings from each reviewer model:",
    rawFindingsText,
    "Here is an initial rule-based merge of their findings (may contain duplicates or incorrect items):",
    ruleMergedText,
    "Now produce a FINAL consolidated JSON object with 'summary' and 'findings' only."
  ].join("\n\n");

  return { system, user };
}

async function runArbiterConsolidation(
  request: ReviewRequest,
  mergedByRule: ReviewResult["findings"],
  rawResults: Array<{ modelId: string; findings: ModelFinding[] }>,
  arbiter: ModelConfig
): Promise<{ findings: ReviewResult["findings"]; summary?: string }> {
  const prompt = buildEnsembleConsolidationPrompt(request, mergedByRule, rawResults);

  let resp: LlmResponse;
  if (arbiter.provider === "openai") {
    resp = await callOpenAI(prompt, arbiter);
  } else if (arbiter.provider === "anthropic") {
    resp = await callAnthropic(prompt, arbiter);
  } else if (arbiter.provider === "gemini") {
    resp = await callGemini(prompt, arbiter);
  } else if (arbiter.provider === "openrouter") {
    resp = await callOpenRouter(prompt, arbiter);
  } else {
    return { findings: mergedByRule };
  }

  const grounded = filterFindingsToDiff(resp.findings, request.diffFiles);
  return {
    findings: mergeFindings(grounded),
    summary: resp.summary
  };
}

async function pingModel(model: ModelConfig): Promise<{ ok: boolean; error?: string; detail?: string }> {
  if (model.endpoint?.startsWith("mock://")) {
    if (model.endpoint.includes("fail")) return { ok: false, error: "Mock endpoint failure" };
    return { ok: true };
  }
  const promptText = 'Just return "hi"';
  const expected = "hi";
  const matchesExpected = (text: string) => text.trim().toLowerCase() === expected;
  try {
    switch (model.provider) {
      case "openrouter": {
        const endpoint = (model.endpoint ?? "https://openrouter.ai").replace(/\/+$/, "");
        const url = `${endpoint}/api/v1/chat/completions`;
        const body: Record<string, any> = {
          model: model.model,
          messages: [
            { role: "system", content: "Respond with the exact text hi" },
            { role: "user", content: promptText }
          ],
          max_tokens: 256
        };
        applySamplingParams(body, model);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${model.apiKey ?? ""}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`OpenRouter responded ${res.status}${text ? `: ${text}` : ""}`);
        }
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content ?? "";
        const text = typeof content === "string" ? content : JSON.stringify(content);
        return matchesExpected(text) ? { ok: true } : { ok: false, error: `Unexpected response: ${text}` };
      }
      case "openai": {
        const endpoint = (model.endpoint ?? "https://api.openai.com").replace(/\/+$/, "");
        const url = `${endpoint}/v1/responses`;
        const body: Record<string, any> = {
          model: model.model,
          input: [
            { role: "system", content: "Respond with the exact text hi" },
            { role: "user", content: promptText }
          ],
          max_output_tokens: 256
        };
        applySamplingParams(body, model);
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${model.apiKey ?? ""}`
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`OpenAI responded ${res.status}${text ? `: ${text}` : ""}`);
        }
        const data = await res.json();
        const text = data.output?.[0]?.content?.[0]?.text ?? data.output_text ?? "";
        return matchesExpected(String(text)) ? { ok: true } : { ok: false, error: `Unexpected response: ${text}` };
      }
      case "anthropic": {
        const endpoint = (model.endpoint ?? "https://api.anthropic.com").replace(/\/+$/, "");
        const url = `${endpoint}/v1/messages`;
        const temp = normalizeNumber(model.temperature);
        const body: Record<string, any> = {
          model: model.model,
          system: "Respond with the exact text hi",
          messages: [{ role: "user", content: promptText }],
          max_tokens: 256
        };
        if (typeof temp === "number") {
          body.temperature = temp;
        }
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": model.apiKey ?? "",
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Anthropic responded ${res.status}${text ? `: ${text}` : ""}`);
        }
        const data = await res.json();
        const text = data.content?.[0]?.text ?? "";
        return typeof text === "string" && matchesExpected(text)
          ? { ok: true }
          : { ok: false, error: `Unexpected response: ${text}` };
      }
      case "gemini": {
        const endpoint = (model.endpoint ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
        const url = `${endpoint}/v1beta/models/${encodeURIComponent(model.model)}:generateContent?key=${encodeURIComponent(
          model.apiKey ?? ""
        )}`;
        const generationConfig: Record<string, any> = { maxOutputTokens: 256 };
        applyGenerationConfigSampling(generationConfig, model);
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: `Respond with the exact text hi\n\n${promptText}` }] }],
            generationConfig
          })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Gemini API responded ${res.status}${text ? `: ${text}` : ""}`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") ?? "";
        return typeof text === "string" && matchesExpected(text)
          ? { ok: true }
          : { ok: false, error: `Unexpected response: ${text}` };
      }
      default:
        return { ok: false, error: "Unsupported provider" };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, detail: message };
  }
}

function extractSummary(parsed: any): string {
  const candidates = [
    parsed?.summary,
    parsed?.overview,
    parsed?.resultSummary,
    parsed?.review?.summary,
    parsed?.result?.summary
  ];
  const text = candidates.find((c) => typeof c === "string" && c.trim().length);
  return typeof text === "string" ? text.trim() : "";
}

function parseReviewPayload(
  jsonInput: unknown,
  modelId: string
): { summary: string; findings: ModelFinding[]; parseError: boolean } {
  let parsed: any = {};
  let parseError = false;
  if (typeof jsonInput === "string") {
    try {
      parsed = JSON.parse(jsonInput);
    } catch (err) {
      parseError = true;
      return { summary: "", findings: [], parseError };
    }
  } else if (jsonInput && typeof jsonInput === "object") {
    parsed = jsonInput;
  } else {
    parseError = true;
    return { summary: "", findings: [], parseError };
  }
  const findingsRaw = Array.isArray(parsed.findings) ? parsed.findings : Array.isArray(parsed) ? parsed : [];
  const findings = findingsRaw
    .map((f, idx) => {
      const sideRaw = String(f.side ?? f.anchorSide ?? f.lineSide ?? "").toLowerCase();
      const side: "left" | "right" = sideRaw === "left" ? "left" : "right";

      const lineRaw = Number(f.line ?? f.startLine ?? f.endLine ?? f.lineNumber ?? 0);
      const normalizedLine = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : 0;
      const startLine = normalizedLine;
      const endLine = normalizedLine;

      const confidenceRaw = Number(f.confidence ?? 0.5);
      const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;
      return {
        id: f.id ?? `f-${idx}`,
        modelId: modelId,
        filePath: f.filePath ?? f.path ?? "",
        startLine,
        endLine,
        side,
        category: (f.category ?? "bug") as ModelFinding["category"],
        severity: (f.severity ?? "major") as ModelFinding["severity"],
        confidence,
        title: f.title ?? "Issue",
        description: f.description ?? "",
        suggestionCode: f.suggestionCode ?? f.code,
        suggestionExplanation: f.suggestionExplanation ?? f.explanation
      };
    })
    .filter((f) => f.filePath && f.description && f.startLine > 0);

  return { summary: extractSummary(parsed), findings, parseError };
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function normalizeJsonInput(candidate: unknown): unknown {
  if (candidate == null) return "{}";
  if (typeof candidate === "string") {
    return extractJson(candidate) ?? candidate;
  }
  return candidate;
}

function extractAnthropicJsonCandidate(data: any): unknown {
  const content = data?.content;
  if (!Array.isArray(content)) return content ?? null;
  for (const block of content) {
    if (!block) continue;
    if (typeof block.text === "string") return block.text;
    if (block.output && typeof block.output === "object") return block.output;
    if (block.output_json && typeof block.output_json === "object") return block.output_json;
    if (block.input_json && typeof block.input_json === "object") return block.input_json;
    if (block.json && typeof block.json === "object") return block.json;
  }
  return null;
}

function extractGeminiJsonCandidate(data: any): unknown {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (!part) continue;
      if (typeof part.text === "string") return part.text;
      if (part.json && typeof part.json === "object") return part.json;
      if (part.inlineData && typeof part.inlineData === "object") return part.inlineData;
    }
  }
  return data?.candidates?.[0]?.content ?? null;
}

function applySamplingParams(body: Record<string, any>, model: ModelConfig, options?: { includeSeed?: boolean }) {
  const temp = normalizeNumber(model.temperature);
  const seed = normalizeNumber(model.seed);
  if (typeof temp === "number") {
    body.temperature = temp;
  }
  if (options?.includeSeed !== false && typeof seed === "number") {
    body.seed = seed;
  }
}

function applyGenerationConfigSampling(config: Record<string, any>, model: ModelConfig) {
  const temp = normalizeNumber(model.temperature);
  const seed = normalizeNumber(model.seed);
  if (typeof temp === "number") {
    config.temperature = temp;
  }
  if (typeof seed === "number") {
    config.seed = seed;
  }
}

async function callOpenAI(prompt: { system: string; user: string }, model: ModelConfig): Promise<LlmResponse> {
  const endpoint = (model.endpoint ?? "https://api.openai.com").replace(/\/+$/, "");
  const url = `${endpoint}/v1/responses`;
  const baseBody: Record<string, any> = {
    model: model.model,
    input: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    response_format: { type: "json_object" }
  };
  if (typeof model.maxTokens === "number") {
    baseBody.max_output_tokens = model.maxTokens;
  }
  applySamplingParams(baseBody, model);
  const extra = parseExtraJson(model);
  const body = extra ? { ...extra, ...baseBody } : baseBody;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey ?? ""}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`OpenAI responded ${res.status}`);
  }
  const data = await res.json();
  const text = data.output?.[0]?.content?.[0]?.text ?? data.output_text ?? "";
  const jsonText = extractJson(text) ?? "{}";
  const { summary, findings, parseError } = parseReviewPayload(jsonText, model.model);
  const usage = data.usage
    ? {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return { summary, findings, usage, parseError };
}

async function callOpenRouter(prompt: { system: string; user: string }, model: ModelConfig): Promise<LlmResponse> {
  const endpoint = (model.endpoint ?? "https://openrouter.ai").replace(/\/+$/, "");
  const url = `${endpoint}/api/v1/chat/completions`;
  const baseBody: Record<string, any> = {
    model: model.model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ],
    response_format: { type: "json_object" }
  };
  if (typeof model.maxTokens === "number") {
    baseBody.max_tokens = model.maxTokens;
  }
  applySamplingParams(baseBody, model);
  const extra = parseExtraJson(model);
  const body = extra ? { ...extra, ...baseBody } : baseBody;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey ?? ""}`
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`OpenRouter responded ${res.status}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const jsonText = extractJson(typeof text === "string" ? text : JSON.stringify(text)) ?? "{}";
  const { summary, findings, parseError } = parseReviewPayload(jsonText, model.model);
  const usage = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0)
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return { summary, findings, usage, parseError };
}

async function callAnthropic(prompt: { system: string; user: string }, model: ModelConfig): Promise<LlmResponse> {
  const endpoint = (model.endpoint ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${endpoint}/v1/messages`;
  const temp = normalizeNumber(model.temperature);
  const baseBody: Record<string, any> = {
    model: model.model,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    max_tokens: model.maxTokens ?? 512,
    output_format: { type: "json_schema", schema: REVIEW_JSON_SCHEMA },
    ...(typeof temp === "number" ? { temperature: temp } : {})
  };
  const extra = parseExtraJson(model);
  const body = extra ? { ...extra, ...baseBody } : baseBody;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": model.apiKey ?? "",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "structured-outputs-2025-11-13",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Anthropic responded ${res.status}`);
  }
  const data = await res.json();
  const jsonInput = normalizeJsonInput(extractAnthropicJsonCandidate(data));
  const { summary, findings, parseError } = parseReviewPayload(jsonInput, model.model);
  const usage = data.usage
    ? {
        promptTokens: data.usage.input_tokens ?? 0,
        completionTokens: data.usage.output_tokens ?? 0,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return { summary, findings, usage, parseError };
}

async function callGemini(prompt: { system: string; user: string }, model: ModelConfig): Promise<LlmResponse> {
  const endpoint = (model.endpoint ?? "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const url = `${endpoint}/v1beta/models/${encodeURIComponent(model.model)}:generateContent?key=${encodeURIComponent(model.apiKey ?? "")}`;
  const generationConfig: Record<string, any> = {
    responseMimeType: "application/json",
    responseJsonSchema: REVIEW_JSON_SCHEMA
  };
  applyGenerationConfigSampling(generationConfig, model);
  if (typeof model.maxTokens === "number") {
    generationConfig.maxOutputTokens = model.maxTokens;
  }
  const baseBody: Record<string, any> = {
    contents: [{ role: "user", parts: [{ text: `${prompt.system}\n\n${prompt.user}` }] }]
  };
  if (Object.keys(generationConfig).length) {
    baseBody.generationConfig = generationConfig;
  }
  const extra = parseExtraJson(model);
  const body = extra ? { ...extra, ...baseBody } : baseBody;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`Gemini API responded ${res.status}`);
  }
  const data = await res.json();
  const jsonInput = normalizeJsonInput(extractGeminiJsonCandidate(data));
  const { summary, findings, parseError } = parseReviewPayload(jsonInput, model.model);
  const usage = data.usageMetadata
    ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: (data.usageMetadata.promptTokenCount ?? 0) + (data.usageMetadata.candidatesTokenCount ?? 0)
      }
    : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return { summary, findings, usage, parseError };
}
