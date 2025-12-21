import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { detectCurrentPrMeta, getCurrentPlatform } from "./diffCollector";
import { logDebug, reportError } from "../shared/debugReporter";
import { trackEvent } from "../shared/analytics";
import type { BgRequest, BgResponse, ModelTestResult, ReviewRequest, ReviewResult, ReviewFile } from "../types";
import SidePanel, { PanelView } from "./sidePanel";
import {
  getSidebarPosition,
  setSidebarPosition,
  SidebarPosition,
  setModelConfig,
  getModelConfig,
  ModelConfigStored,
  type Platform
} from "../shared/storage";

type Prepared = {
  prMeta: ReviewRequest["pr"];
  files: ReviewFile[];
};

const DEFAULT_SKIP_PATTERNS: ReviewRequest["policy"]["skipPatterns"] = {
  paths: [],
  names: [],
  extensions: [],
  maxFileBytes: undefined,
  maxAddedLines: undefined
};

function App({ initialPlatform }: { initialPlatform: Platform | null }) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [view, setViewState] = useState<PanelView>("collapsed");
  const [viewHistory, setViewHistory] = useState<PanelView[]>(["collapsed"]);
  const [configIntent, setConfigIntent] = useState<"auto" | "manual">("auto");
  const [multiModel, setMultiModel] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [customPrompt, setCustomPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<ReviewResult | null>(null);
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentPlatform, setCurrentPlatform] = useState<Platform | null>(initialPlatform);
  const initialModelConfigured = (() => {
    const raw = document.documentElement.getAttribute("data-bello-model-config");
    if (raw) return true;
    return Boolean((window as any).__BELLO_MODEL_CONFIG);
  })();
  const [modelConfigured, setModelConfigured] = useState(initialModelConfigured);
  useEffect(() => {
    if (__BELLO_DEBUG_BUILD__) {
      console.debug("[bello] modelConfigured state", modelConfigured);
    }
  }, [modelConfigured]);
  const viewRef = useRef<PanelView>("collapsed");
  viewRef.current = view;

  const isEventFromBelloPanel = (e: KeyboardEvent): boolean => {
    const host = document.getElementById("bello-sidepanel-host");
    if (!host) return false;

    const target = e.target as Node | null;
    if (target === host) return true;
    if (target && host.contains(target)) return true;

    const active = document.activeElement;
    const shadow = (host as any).shadowRoot as ShadowRoot | null;
    if (shadow && active instanceof Node && shadow.contains(active)) return true;

    return false;
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const fromBello = isEventFromBelloPanel(e);

      if (fromBello) {
        if (e.key === "Escape" && viewRef.current !== "collapsed") {
          e.preventDefault();
          e.stopPropagation();
          setView("collapsed");
          return;
        }
        e.stopPropagation();
        return;
      }

      if (e.key === "Escape" && viewRef.current !== "collapsed") {
        e.preventDefault();
        e.stopPropagation();
        setView("collapsed");
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [view]);

  useEffect(() => {
    const stopIfFromBello = (e: KeyboardEvent) => {
      if (isEventFromBelloPanel(e)) {
        e.stopPropagation();
      }
    };
    window.addEventListener("keyup", stopIfFromBello, true);
    window.addEventListener("keypress", stopIfFromBello, true);
    return () => {
      window.removeEventListener("keyup", stopIfFromBello, true);
      window.removeEventListener("keypress", stopIfFromBello, true);
    };
  }, []);

  useEffect(() => {
    const override = (window as any).__BELLO_MODEL_CONFIG;
    const attrConfig = (() => {
      const raw = document.documentElement.getAttribute("data-bello-model-config");
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        console.warn("[bello] Invalid data-bello-model-config JSON, ignoring", err);
        return null;
      }
    })();
    const cfg = override || attrConfig;
    if (cfg && cfg.model && cfg.provider) {
      void (async () => {
        try {
          await setModelConfig(cfg);
        } catch (err) {
          console.error("[bello] Failed to apply initial model config", err);
        }
      })();
      setModelConfigured(true);
      if (view === "config" && configIntent === "auto") setView("main");
    }
  }, [view, configIntent]);

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await getModelConfig();
        setModelConfigured(Boolean(cfg));
        if (cfg && view === "config" && configIntent === "auto") {
          setView("main");
        }
      } catch (err) {
        console.error("[bello] Failed to load model config in content script", err);
        setModelConfigured(false);
      }
    })();
  }, [view, configIntent]);

  useEffect(() => {
    window.addEventListener("error", (event) => {
      void reportError("content", "window.onerror", event.error ?? event.message, {
        file: event.filename,
        line: event.lineno,
        col: event.colno
      });
    });
    window.addEventListener("unhandledrejection", (event) => {
      void reportError("content", "unhandledrejection", event.reason);
    });
  }, []);

  useEffect(() => {
    if (!response) {
      setActiveVariantId(null);
      return;
    }
    const variants = response.variants ?? [];
    if (!variants.length) return;
    const existing = variants.find((v) => v.id === activeVariantId);
    if (existing) return;
    const fallback = variants.find((v) => v.type === "consolidated") ?? variants[0];
    setActiveVariantId(fallback?.id ?? null);
  }, [response, activeVariantId]);

  async function collectAndPrepare(options?: { setViewToMain?: boolean; skipIfCancelled?: () => boolean }): Promise<{ prepared: Prepared; selected: Set<string> } | null> {
    const meta = await detectCurrentPrMeta();
    if (!meta) {
      if (options?.skipIfCancelled?.()) return null;
      const platform = currentPlatform ?? (await getCurrentPlatform());
      setCurrentPlatform(platform ?? null);
      const message = platform
        ? `This host is configured as ${platform}, but this page doesn't look like a pull/merge request. Navigate to a PR/MR page or change the site configuration.`
        : "Not a supported pull/merge request page.";
      setPrepared(null);
      setError(message);
      if (options?.setViewToMain) setView("main");
      return null;
    }
    setCurrentPlatform(meta.platform);
    const nextPrepared: Prepared = { prMeta: meta, files: [] };
    const nextSelected = new Set<string>();
    setPrepared(nextPrepared);
    setSelected(nextSelected);
    setError(null);
    if (options?.setViewToMain) setView("main");
    void tryRestoreCachedReview(nextPrepared.prMeta);
    console.log("[bello] collected PR/MR meta (diff will be fetched in background)", {
      repo: meta.repo,
      platform: meta.platform,
      host: meta.host
    });
    return { prepared: nextPrepared, selected: nextSelected };
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const platform = currentPlatform ?? (await getCurrentPlatform());
      if (cancelled) return;
      setCurrentPlatform(platform);
      if (!platform) return;
      await collectAndPrepare({ skipIfCancelled: () => cancelled });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const includedFiles = useMemo(() => {
    if (!prepared) return [];
    const base = prepared.files ?? [];
    return base.filter((f) => selected.size === 0 || selected.has(f.path));
  }, [prepared, selected]);

  async function handleRun(
    preparedOverride?: Prepared,
    selectedOverride?: Set<string>,
    options?: { source?: "panel" | "launcher" }
  ) {
    if (loading) return;
    const runSource = options?.source ?? "panel";
    const targetPrepared = preparedOverride ?? prepared;
    const selection = selectedOverride ?? selected;
    const prMeta = targetPrepared?.prMeta ?? (await detectCurrentPrMeta());
    if (!targetPrepared || !prMeta) {
      const message = currentPlatform
        ? "No PR/MR data collected yet. Click refresh in Bello while on a pull/merge request page."
        : "No PR data collected yet. Click refresh in Bello to load the diff.";
      setError(message);
      console.warn("[bello] Run Review blocked:", message);
      void logDebug("content", "warn", "Run Review blocked: no prepared data");
      void trackEvent("review_error", {
        platform: currentPlatform ?? prMeta?.platform ?? "unknown",
        stage: "pr_meta"
      });
      setView("main");
      return;
    }
    const baseFiles = targetPrepared.files ?? [];
    const filesForRun = selection.size ? baseFiles.filter((f) => selection.has(f.path)) : baseFiles;
    const isRerun = Boolean(response);
    console.log("[bello] Run Review clicked", { files: filesForRun.length });
    void logDebug("content", "info", "Run Review clicked", { files: filesForRun.length });
    setLoading(true);
    setError(null);
    setView("running");
    const trimmedPrompt = customPrompt.trim();
    const payload: ReviewRequest = {
      pr: prMeta,
      diffFiles: filesForRun,
      policy: {
        skipPatterns: DEFAULT_SKIP_PATTERNS
      },
      customPrompt: trimmedPrompt.length ? trimmedPrompt : undefined
    };
    void trackEvent(isRerun ? "rerun_review" : "start_review", { platform: prMeta.platform });
    try {
      console.log("[bello] sending RUN_REVIEW", {
        repo: payload.pr.repo,
        files: payload.diffFiles.length,
        selected: filesForRun.map((f) => f.path)
      });
      const res = await sendMessage({ type: "RUN_REVIEW", payload });
      console.log("[bello] RUN_REVIEW response", res?.type);
      if (res.type === "REVIEW_DONE") {
        setActiveVariantId(null);
        setResponse(res.payload);
        // Stay on the main view and just populate the existing layout with the new data.
        setView("main");
      } else if (res.type === "REVIEW_ERROR") {
        setError(res.payload.message);
        setView("main");
        console.error("[bello] review error", res.payload.message);
        void logDebug("content", "error", "RUN_REVIEW error", { message: res.payload.message });
      } else if (res.type === "ERROR") {
        setError(res.error);
        setView("main");
        console.error("[bello] review error", res.error);
        void logDebug("content", "error", "RUN_REVIEW error", { message: res.error });
      }
    } catch (err) {
      setError((err as Error).message);
      setView("main");
      console.error("[bello] review exception", err);
      void logDebug("content", "error", "RUN_REVIEW exception", { message: String(err) });
    } finally {
      setLoading(false);
    }
  }

  const setView = (next: PanelView, intent: "auto" | "manual" = "auto") => {
    setViewHistory((prev) => {
      if (prev[prev.length - 1] === next) return prev;
      const nextHistory = [...prev, next];
      return nextHistory.slice(-8);
    });
    if (next === "config") {
      setConfigIntent(intent);
    } else {
      setConfigIntent("auto");
    }
    setViewState(next);
  };

  async function tryRestoreCachedReview(pr: ReviewRequest["pr"]) {
    if (response || loading) return;
    try {
      const res = await sendMessage({ type: "GET_LAST_REVIEW", payload: { pr } });
      if (res.type === "LAST_REVIEW_RESULT") {
        setActiveVariantId(null);
        setResponse(res.payload);
        setView("main", "auto");
        void logDebug("content", "info", "Restored cached review", { repo: pr.repo, number: pr.number });
      }
    } catch (err) {
      console.warn("[bello] Failed to restore cached review", err);
    }
  }

  const goBack = () => {
    setViewHistory((prev) => {
      if (prev.length <= 1) return prev;
      const nextHistory = prev.slice(0, -1);
      setViewState(nextHistory[nextHistory.length - 1]);
      setConfigIntent("auto");
      return nextHistory;
    });
  };

  const handleRefresh = async () => {
    await collectAndPrepare({ setViewToMain: true });
  };

  const handleLauncherRun = async () => {
    if (loading) return;
    let cfg: ModelConfigStored | null = null;
    try {
      cfg = await getModelConfig();
    } catch (err) {
      console.error("[bello] Failed to read model config before launcher run", err);
    }
    if (!cfg) {
      setModelConfigured(false);
      setView("config", "manual");
      return;
    }
    setModelConfigured(true);
    const preparedResult = await collectAndPrepare({ setViewToMain: true });
    if (!preparedResult) return;
    await handleRun(preparedResult.prepared, preparedResult.selected, { source: "launcher" });
  };

  return (
    <SidePanel
      view={view}
      setView={setView}
      goBack={goBack}
      canGoBack={viewHistory.length > 1}
      modelConfigured={modelConfigured}
      onTestModelConfig={async (cfg: ModelConfigStored, onProgress?: (result: ModelTestResult) => void) => {
        const reviewers = (cfg.reviewers ?? []).filter((r) => r.model?.trim().length > 0);
        const tests: Array<{ model: ModelConfigStored["reviewers"][number]; target: ModelTestResult["target"]; index: number }> = reviewers.map(
          (model, index) => ({ model, target: "reviewer", index })
        );
        if (cfg.arbiter) {
          tests.push({ model: cfg.arbiter as ModelConfigStored["reviewers"][number], target: "arbiter", index: 0 });
        }
        if (!tests.length) {
          return { type: "TEST_MODEL_RESULT", payload: { ok: false, error: "No reviewer configured.", results: [] } };
        }
        const results = await Promise.all(
          tests.map(async (entry) => {
            const response = await sendMessage({ type: "TEST_MODEL_SINGLE", payload: entry });
            let result: ModelTestResult;
            if (response.type === "TEST_MODEL_RESULT" && response.payload.results?.length) {
              const res = response.payload.results[0];
              result = { ...res, target: entry.target, index: entry.index };
            } else if (response.type === "TEST_MODEL_RESULT") {
              const error = response.payload.error ?? "Model test failed";
              result = {
                target: entry.target,
                index: entry.index,
                model: entry.model.model,
                provider: entry.model.provider,
                status: response.payload.ok ? "passed" : "failed",
                error,
                detail: error
              };
            } else {
              const error = response.type === "ERROR" ? response.error : "Model test failed";
              result = {
                target: entry.target,
                index: entry.index,
                model: entry.model.model,
                provider: entry.model.provider,
                status: "failed",
                error,
                detail: error
              };
            }
            if (onProgress) {
              onProgress(result);
            }
            return result;
          })
        );
        const firstFailure = results.find((r) => r.status === "failed");
        return {
          type: "TEST_MODEL_RESULT",
          payload: {
            ok: !firstFailure,
            error: firstFailure?.error,
            results
          }
        };
      }}
      onSaveModelConfig={async (cfg: ModelConfigStored) => {
        const reviewerCount = cfg.reviewers?.length ?? 0;
        const providerCounts = cfg.reviewers.reduce(
          (acc, r) => {
            if (r.provider === "openai") acc.provider_openai_count += 1;
            if (r.provider === "anthropic") acc.provider_anthropic_count += 1;
            if (r.provider === "gemini") acc.provider_gemini_count += 1;
            if (r.provider === "openrouter") acc.provider_openrouter_count += 1;
            return acc;
          },
          {
            provider_openai_count: 0,
            provider_anthropic_count: 0,
            provider_gemini_count: 0,
            provider_openrouter_count: 0
          }
        );
        try {
          await setModelConfig(cfg);
          setModelConfigured(true);
          void trackEvent("model_config_saved", {
            reviewer_count: reviewerCount,
            ...providerCounts
          });
        } catch (err) {
          console.error("[bello] Failed to save model config from config view", err);
          setError("Failed to save model configuration. Please check the extension console.");
        }
      }}
      prMeta={prepared?.prMeta}
      files={includedFiles}
      allFiles={prepared?.files ?? []}
      selected={selected}
      setSelected={setSelected}
      multiModel={multiModel}
      setMultiModel={setMultiModel}
      customPrompt={customPrompt}
      setCustomPrompt={setCustomPrompt}
      response={response ?? undefined}
      loading={loading}
      error={error ?? undefined}
      setError={(val) => setError(val ?? null)}
      onRun={() => {
        void handleRun(undefined, undefined, { source: "panel" });
      }}
      onLauncherRun={handleLauncherRun}
      onRefresh={() => {
        void handleRefresh();
      }}
      activeVariantId={activeVariantId}
      setActiveVariantId={setActiveVariantId}
    />
  );
}

function sendMessage(message: BgRequest): Promise<BgResponse> {
  const friendlyError: BgResponse = { type: "ERROR", error: "Extension was reloaded. Please refresh this tab." };
  return new Promise((resolve, reject) => {
    try {
      console.log("[bello] sendMessage ->", message.type);
      chrome.runtime.sendMessage(message, (response: BgResponse) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          const msg = lastError.message || "";
          console.warn("[bello] sendMessage error", message.type, msg);
          if (msg.includes("Extension context invalidated")) {
            resolve(friendlyError);
            return;
          }
          reject(new Error(msg));
          return;
        }
        console.log("[bello] sendMessage <-", message.type, response?.type);
        resolve(response);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Extension context invalidated")) {
        resolve(friendlyError);
        return;
      }
      reject(err);
    }
  });
}

function mount() {
  if ((window as any).__belloInjected) return;

  const DEFAULT_POS: SidebarPosition = { top: 65, right: 12 };

  const init = async () => {
    if ((window as any).__belloInjected) return;
    const platform = await getCurrentPlatform();
    if (!platform) {
      console.log("[bello] mount: skipping injection, host not configured", window.location.hostname);
      return;
    }
    if ((window as any).__belloInjected) return;
    if (document.getElementById("bello-sidepanel-host")) return;
    if (!document.body) {
      return;
    }
    (window as any).__belloInjected = true;
    console.log("[bello] content script mounted", { platform, host: window.location.hostname, path: window.location.pathname });

    const host = document.createElement("div");
    host.id = "bello-sidepanel-host";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.maxHeight = "100vh";
    host.style.width = "600px";
    host.style.pointerEvents = "none";
    host.style.overflow = "visible";

    const shadow = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    container.style.pointerEvents = "auto";
    container.style.width = "100%";
    container.style.height = "100%";
    shadow.appendChild(container);
    document.body.appendChild(host);

    let stored = DEFAULT_POS;
    try {
      stored = await getSidebarPosition(DEFAULT_POS);
    } catch (err) {
      console.warn("[bello] Failed to read sidebar position, using default", err);
    }
    const applied = applyPosition(host, stored);
    if (applied.top !== stored.top || applied.right !== stored.right) {
      try {
        await setSidebarPosition(applied);
      } catch (err) {
        console.warn("[bello] Failed to persist initial sidebar position", err);
      }
    }

    render(<App initialPlatform={platform} />, container);

    // Keep collapsed position in data attrs for quick checks
    host.dataset.view = "collapsed";
    host.dataset.collapsedTop = String(applied.top);
    host.dataset.collapsedRight = String(applied.right);

    const dragZone = host.shadowRoot?.querySelector<HTMLElement>("[data-bello-drag-zone]");
    if (dragZone) {
      let dragging = false;
      let didDrag = false;
      let startX = 0;
      let startY = 0;
      let startTop = applied.top;
      let startRight = applied.right;
      let currentPos: SidebarPosition = applied;
      const dragThresholdPx = 4;

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!didDrag && (Math.abs(dx) > dragThresholdPx || Math.abs(dy) > dragThresholdPx)) {
          didDrag = true;
        }
        const nextPos: SidebarPosition = {
          top: startTop + dy,
          right: Math.max(0, startRight - dx)
        };
        currentPos = applyPosition(host, nextPos);
        host.dataset.collapsedTop = String(currentPos.top);
        host.dataset.collapsedRight = String(currentPos.right);
      };

      const onMouseUp = async () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        if (didDrag) {
          host.dataset.justDragged = "1";
          window.setTimeout(() => {
            if (host.dataset.justDragged === "1") host.dataset.justDragged = "0";
          }, 0);
        } else {
          host.dataset.justDragged = "0";
        }
        try {
          await setSidebarPosition(currentPos);
        } catch (err) {
          console.warn("[bello] Failed to persist dragged sidebar position", err);
        }
        didDrag = false;
      };

      const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        if (host.dataset.view !== "collapsed") return;
        dragging = true;
        didDrag = false;
        host.dataset.justDragged = "0";
        startX = e.clientX;
        startY = e.clientY;
        const rect = host.getBoundingClientRect();
        startTop = rect.top;
        startRight = window.innerWidth - rect.right;
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      };

      dragZone.style.cursor = "move";
      dragZone.addEventListener("mousedown", onMouseDown);
    }
  };

  if (document.readyState === "loading" && !document.body) {
    document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
  } else {
    void init();
  }
}

mount();

function applyPosition(host: HTMLElement, pos: SidebarPosition): SidebarPosition {
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const clampedTop = Math.max(0, Math.min(pos.top, Math.max(viewportHeight - 320, 0)));
  const clampedRight = Math.max(0, pos.right);
  const availableHeight = Math.max(320, viewportHeight - clampedTop);
  host.style.top = `${clampedTop}px`;
  host.style.right = `${clampedRight}px`;
  host.style.height = `${availableHeight}px`;
  return { top: clampedTop, right: clampedRight };
}
