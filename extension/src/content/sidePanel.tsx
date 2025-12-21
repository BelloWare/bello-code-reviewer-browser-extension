import { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BgResponse, ModelTestResult, ReviewFile, ReviewPrMeta, ReviewResult, Severity } from "../types";
import {
  getModelConfig,
  getSeverityFilter,
  getSidebarPosition,
  getSidebarWidth,
  setSeverityFilter as persistSeverityFilter,
  setSidebarWidth,
  type ModelConfigStored,
  type ProviderId,
  type SeverityFilter
} from "../shared/storage";
import { trackEvent } from "../shared/analytics";

export type PanelView = "collapsed" | "main" | "running" | "config";

type ModelFormConfig = ModelConfigStored["reviewers"][number];

type Props = {
  view: PanelView;
  setView: (view: PanelView, intent?: "auto" | "manual") => void;
  goBack: () => void;
  canGoBack: boolean;
  modelConfigured: boolean;
  onTestModelConfig: (config: ModelConfigStored, onProgress?: (result: ModelTestResult) => void) => Promise<BgResponse>;
  onSaveModelConfig: (config: ModelConfigStored) => Promise<void>;
  prMeta?: ReviewPrMeta | null;
  files: ReviewFile[];
  allFiles: ReviewFile[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  multiModel: boolean;
  setMultiModel: (val: boolean) => void;
  customPrompt: string;
  setCustomPrompt: (val: string) => void;
  response?: ReviewResult;
  loading: boolean;
  error?: string;
  setError: (val: string | null) => void;
  onRun: () => void;
  onLauncherRun: () => Promise<void>;
  onRefresh: () => void;
  activeVariantId: string | null;
  setActiveVariantId: (val: string | null) => void;
};

type TestState = { state: "idle" | "testing" | "passed" | "failed"; error?: string; detail?: string };

const testStatusKey = (target: ModelTestResult["target"], index: number) => `${target}-${index}`;
const PENDING_GOTO_KEY = "bello-pending-go-to-code";
const SEVERITY_ORDER: Severity[] = ["blocker", "major", "minor"];

const formatSeverityLabel = (severity: Severity) => severity[0].toUpperCase() + severity.slice(1);

const DEFAULT_ENDPOINTS: Record<ProviderId, string> = {
  openrouter: "https://openrouter.ai",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com"
};

const getDefaultEndpoint = (provider: ProviderId): string => DEFAULT_ENDPOINTS[provider] ?? "";

const defaultModelConfig = (): ModelFormConfig => ({
  provider: "openrouter",
  alias: "",
  model: "openai/gpt-5.1-codex-mini",
  endpoint: getDefaultEndpoint("openrouter"),
  apiKey: "",
  extraJson: ""
});

const blankReviewer = (): ModelFormConfig => ({
  provider: "openrouter",
  alias: "",
  model: "",
  endpoint: "",
  apiKey: "",
  extraJson: ""
});

const nextReviewerFromPrevious = (previous?: ModelFormConfig): ModelFormConfig => {
  const base = previous ? { ...previous } : blankReviewer();
  return { ...base, model: "" };
};

const modelsMatch = (
  a: ModelFormConfig,
  b: ModelFormConfig
): boolean => {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.endpoint ?? "") === (b.endpoint ?? "") &&
    (a.apiKey ?? "") === (b.apiKey ?? "") &&
    (a.maxTokens ?? 0) === (b.maxTokens ?? 0) &&
    (a.temperature ?? 0) === (b.temperature ?? 0) &&
    (a.seed ?? 0) === (b.seed ?? 0) &&
    (a.extraJson ?? "") === (b.extraJson ?? "")
  );
};

const normalizeBase = (endpoint?: string) => (endpoint ?? "").replace(/\/+$/, "").toLowerCase();

const toOptionalNumber = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed.length) return undefined;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : undefined;
};

export default function SidePanel(props: Props): JSX.Element {
  const {
    view,
    setView,
    goBack,
    canGoBack,
    modelConfigured,
    onTestModelConfig,
    onSaveModelConfig,
    prMeta,
    files,
    allFiles,
    selected,
    setSelected,
    multiModel,
    setMultiModel,
    customPrompt,
    setCustomPrompt,
    response,
    loading,
    error,
    setError,
    onRun,
    onLauncherRun,
    onRefresh,
    activeVariantId,
    setActiveVariantId
  } = props;

  const [mode, setMode] = useState<ModelConfigStored["mode"]>("single");
  const [reviewers, setReviewers] = useState<ModelFormConfig[]>([defaultModelConfig()]);
  const [arbiterEnabled, setArbiterEnabled] = useState(false);
  const [arbiterChoice, setArbiterChoice] = useState<"existing" | "custom">("existing");
  const [arbiterExistingIndex, setArbiterExistingIndex] = useState(0);
  const [arbiterCustom, setArbiterCustom] = useState<ModelFormConfig>(defaultModelConfig());
  const [savingModel, setSavingModel] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [testStatuses, setTestStatuses] = useState<Record<string, TestState>>({});
  const [validated, setValidated] = useState(false);
  const [panelWidth, setPanelWidth] = useState(600);
  const [severityFilter, setSeverityFilterState] = useState<SeverityFilter>({ blocker: true, major: true, minor: true });
  const maxReviewers = 5;
  const hasMultipleReviewers = reviewers.length > 1;
  const effectiveMode: ModelConfigStored["mode"] = reviewers.length > 1 ? "ensemble" : "single";
  const arbiterRequired = effectiveMode === "ensemble";
  const arbiterActive = arbiterRequired || arbiterEnabled;
  const duplicateReviewers = useMemo(() => {
    const seen = new Set<string>();
    for (const r of reviewers) {
      const modelId = r.model.trim().toLowerCase();
      if (!modelId) continue;
      const key = `${r.provider}:${modelId}::${normalizeBase(r.endpoint)}::${r.temperature ?? "na"}::${r.seed ?? "na"}`;
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }, [reviewers]);

  const skipped = useMemo(() => {
    if (selected.size === 0) return [];
    return allFiles.filter((f) => !selected.has(f.path)).map((f) => ({ file: f.path, reason: "Skipped by selection" }));
  }, [allFiles, selected]);
  const availableVariants = useMemo(() => {
    if (response?.variants?.length) return response.variants;
    if (response) {
      return [
        {
          id: "consolidated",
          label: "Consolidated",
          type: "consolidated" as const,
          summary: response.summary,
          findings: response.findings
        }
      ];
    }
    return [];
  }, [response]);

  const activeVariant = useMemo(() => {
    if (!availableVariants.length) return null;
    return (
      availableVariants.find((v) => v.id === activeVariantId) ??
      availableVariants.find((v) => v.type === "consolidated") ??
      availableVariants[0]
    );
  }, [availableVariants, activeVariantId]);

  const allFindings = activeVariant?.findings ?? response?.findings ?? [];
  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { blocker: 0, major: 0, minor: 0 };
    for (const finding of allFindings) {
      if (finding.severity === "blocker" || finding.severity === "major" || finding.severity === "minor") {
        counts[finding.severity] += 1;
      }
    }
    return counts;
  }, [allFindings]);
  const filteredFindings = useMemo(() => {
    if (!allFindings.length) return [];
    return allFindings.filter((f) => severityFilter[f.severity]);
  }, [allFindings, severityFilter]);
  const hasReviewResponse = Boolean(response);
  const summaryText = activeVariant?.summary?.trim()
    ? activeVariant.summary
    : response
      ? `Found ${allFindings.length} issues.`
      : "Run Bello to generate a summary.";
  const hasAnyFindings = allFindings.length > 0;
  const hasVisibleFindings = filteredFindings.length > 0;
  const variantError = activeVariant?.error;
  const running = loading || view === "running";
  const panelWidthRef = useRef(panelWidth);
  const viewRef = useRef(view);
  const toggleSeverity = (severity: Severity) => {
    const next = { ...severityFilter, [severity]: !severityFilter[severity] };
    setSeverityFilterState(next);
    void persistSeverityFilter(next).catch((err) => {
      console.warn("[bello] Failed to save severity filter", err);
    });
  };

  useEffect(() => {
    panelWidthRef.current = panelWidth;
  }, [panelWidth]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getSeverityFilter();
        if (!cancelled) setSeverityFilterState(stored);
      } catch (err) {
        console.warn("[bello] Failed to load severity filter", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view === "collapsed") return;
    const host = document.getElementById("bello-sidepanel-host");
    if (!host) return;
    const dock = () => {
      host.style.position = "fixed";
      host.style.left = "auto";
      host.style.right = "0px";
      host.style.top = "0px";
      host.style.height = "100vh";
      host.style.maxHeight = "100vh";
    };
    dock();
    const raf = window.requestAnimationFrame(dock);
    const timer = window.setTimeout(dock, 120);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [view, panelWidth, response, prMeta?.repo, prMeta?.number]);

  useEffect(() => {
    if (!prMeta) return;
    const raw = sessionStorage.getItem(PENDING_GOTO_KEY);
    if (!raw) return;
    let pending: {
      path: string;
      line: number;
      side?: "left" | "right";
      pr?: { repo?: string; number?: number; host?: string; platform?: string };
      view?: string;
    } | null = null;
    try {
      pending = JSON.parse(raw);
    } catch {
      sessionStorage.removeItem(PENDING_GOTO_KEY);
      return;
    }
    if (
      !pending ||
      pending.pr?.repo !== prMeta.repo ||
      pending.pr?.number !== prMeta.number ||
      pending.pr?.host !== prMeta.host ||
      pending.pr?.platform !== prMeta.platform
    ) {
      return;
    }

    const desiredView: PanelView =
      pending.view === "collapsed" || pending.view === "main" || pending.view === "running" || pending.view === "config"
        ? pending.view
        : "main";
    setView(desiredView, "manual");

    let attempts = 0;
    const maxAttempts = 20;
    let timer: number | null = null;

    const tryScroll = () => {
      attempts += 1;
      const fileNode = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(pending!.path)}"]`);
      if (fileNode) {
        scrollToFile(pending!.path, pending!.line, pending!.side ?? "right");
        sessionStorage.removeItem(PENDING_GOTO_KEY);
        return;
      }
      if (attempts >= maxAttempts) {
        sessionStorage.removeItem(PENDING_GOTO_KEY);
        return;
      }
      timer = window.setTimeout(tryScroll, 400);
    };

    tryScroll();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [prMeta, setView]);

  useEffect(() => {
    const host = document.getElementById("bello-sidepanel-host");
    if (host) {
      host.style.transition = "width 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
      host.style.width = view === "collapsed" ? "max-content" : `${Math.max(400, panelWidth)}px`;
      host.setAttribute("data-view", view);
      if (view === "collapsed") {
        void (async () => {
          let stored = { top: 65, right: 12 };
          try {
            stored = await getSidebarPosition(stored);
          } catch (err) {
            console.warn("[bello] Failed to read sidebar position for collapse", err);
          }
          host.style.top = `${stored.top}px`;
          host.style.right = `${stored.right}px`;
          host.style.height = "auto";
          host.dataset.collapsedTop = String(stored.top);
          host.dataset.collapsedRight = String(stored.right);
        })();
      } else {
        host.style.top = "0px";
        host.style.right = "0px";
        host.style.height = "100vh";
      }
    }

    const shadow = host?.shadowRoot;
    const dragZone = shadow?.querySelector<HTMLElement>("[data-bello-drag-zone]");
    if (dragZone) {
      dragZone.style.cursor = view === "collapsed" ? "move" : "default";
    }
    const handle = shadow?.getElementById("bello-resize-handle") as HTMLElement | null;
    if (handle) {
      handle.style.cursor = "col-resize";
    }
  }, [view, panelWidth]);

  useEffect(() => {
    void (async () => {
      try {
        const storedWidth = await getSidebarWidth(600);
        setPanelWidth(Math.max(400, storedWidth));
      } catch (err) {
        console.warn("[bello] Failed to read sidebar width, using default", err);
        setPanelWidth(600);
      }
    })();
  }, []);

  useEffect(() => {
    if (viewRef.current === "collapsed") return;
    const host = document.getElementById("bello-sidepanel-host");
    const shadow = host?.shadowRoot;
    if (!host || !shadow) {
      console.warn("[bello] resize host/shadow not ready", { hasHost: Boolean(host), hasShadow: Boolean(shadow) });
      return;
    }

    const handle = shadow.querySelector<HTMLElement>("#bello-resize-handle");
    if (!handle) {
      console.warn("[bello] resize handle not found", { view: viewRef.current });
      return;
    }
    console.log("[bello] resize handle bound");

    let resizing = false;
    let startX = 0;
    let startWidth = panelWidthRef.current;
    let prevTransition = "";
    const minWidth = 400;

    const onMove = (e: MouseEvent) => {
      if (!resizing) return;
      const dx = startX - e.clientX;
      const next = Math.max(minWidth, startWidth + dx);
      host.style.width = `${next}px`;
      panelWidthRef.current = next;
    };
    const onUp = async () => {
      if (!resizing) return;
      resizing = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      host.style.transition = prevTransition;
      setPanelWidth(panelWidthRef.current);
      console.log("[bello] resize up", { width: panelWidthRef.current });
      try {
        await setSidebarWidth(panelWidthRef.current);
      } catch (err) {
        console.warn("[bello] Failed to persist sidebar width", err);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (viewRef.current === "collapsed") return;
      if (e.button !== 0) return;
      resizing = true;
      startX = e.clientX;
      startWidth = panelWidthRef.current;
      prevTransition = host.style.transition;
      host.style.transition = "none";
      console.log("[bello] resize down", { startX, startWidth });
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    };

    handle.addEventListener("mousedown", onDown);
    return () => {
      handle.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [view]);

  useEffect(() => {
    if (view !== "config") return;
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getModelConfig();
        if (!cfg || cancelled) return;
        setMode(cfg.mode ?? "single");
        setReviewers(cfg.reviewers.length ? cfg.reviewers.map((r) => ({ ...r })) : [defaultModelConfig()]);
        if (cfg.arbiter) {
          setArbiterEnabled(true);
          setArbiterCustom({ ...cfg.arbiter });
          const matchIdx = cfg.reviewers.findIndex((r) => modelsMatch(r, cfg.arbiter!));
          if (matchIdx >= 0) {
            setArbiterChoice("existing");
            setArbiterExistingIndex(matchIdx);
          } else {
            setArbiterChoice("custom");
          }
        } else {
          setArbiterEnabled(false);
          setArbiterChoice("existing");
          setArbiterExistingIndex(0);
          setArbiterCustom(defaultModelConfig());
        }
        setTestStatuses({});
        setValidated(true);
        setSaveSuccess(false);
      } catch (err) {
        console.error("[bello] Failed to load model config in side panel", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      const shadow = document.getElementById("bello-sidepanel-host")?.shadowRoot;
      if (!shadow) return;
      const eyes = [
        { eye: "#bello-launcher-eye", pupil: "#bello-launcher-pupil", max: 3.5 },
        { eye: "#bello-panel-eye", pupil: "#bello-panel-pupil", max: 4.5 },
        { eye: "#bello-eye-single-mode", pupil: "#bello-pupil-single-mode", max: 3.0 },
        { eye: "#bello-eye-ens-1", pupil: "#bello-pupil-ens-1", max: 2.5 },
        { eye: "#bello-eye-ens-2", pupil: "#bello-pupil-ens-2", max: 2.5 },
        { eye: "#bello-eye-ens-3", pupil: "#bello-pupil-ens-3", max: 2.5 }
      ];
      eyes.forEach(({ eye, pupil, max }) => {
        const eyeEl = shadow.querySelector<HTMLElement>(eye);
        const pupilEl = shadow.querySelector<HTMLElement>(pupil);
        if (!eyeEl || !pupilEl) return;
        // Safety: only animate our pupils; don't touch other elements.
        if (
          !pupilEl.classList.contains("trackable-pupil") &&
          !pupilEl.classList.contains("bello-pupil") &&
          !pupilEl.classList.contains("bello-header-pupil")
        ) {
          return;
        }
        const rect = eyeEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
        const dist = Math.min(max, Math.hypot(e.clientX - cx, e.clientY - cy));
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        pupilEl.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      });
    };
    document.addEventListener("mousemove", handleMove);
    return () => document.removeEventListener("mousemove", handleMove);
  }, []);

  useEffect(() => {
    if (view === "collapsed") return;
    const shadow = document.getElementById("bello-sidepanel-host")?.shadowRoot;
    const panel = shadow?.getElementById("bello-panel-root") as HTMLElement | null;
    panel?.focus();
  }, [view]);

  useEffect(() => {
    if (reviewers.length === 0) {
      setReviewers([defaultModelConfig()]);
      return;
    }
    setArbiterExistingIndex((idx) => Math.min(idx, Math.max(0, reviewers.length - 1)));
    if (hasMultipleReviewers && !arbiterEnabled) {
      setArbiterEnabled(true);
    }
  }, [reviewers, hasMultipleReviewers, mode, arbiterEnabled]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && view !== "collapsed") {
        e.preventDefault();
        e.stopPropagation();
        setView("collapsed");
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [view, setView]);

  const markConfigDirty = () => {
    if (savingModel) return;
    setSaveSuccess(false);
    setTestStatuses({});
    setValidated(false);
  };

  const applyTestResults = (results?: ModelTestResult[]) => {
    if (!results?.length) return;
    setTestStatuses((prev) => {
      const next = { ...prev } as Record<string, TestState>;
      results.forEach((res) => {
        const key = testStatusKey(res.target, res.index);
        next[key] = { state: res.status, error: res.error, detail: res.detail };
      });
      return next;
    });
    const allPassed = results.every((r) => r.status === "passed");
    if (allPassed) setValidated(true);
  };

  const applyTestResult = (result: ModelTestResult) => {
    setTestStatuses((prev) => {
      const key = testStatusKey(result.target, result.index);
      const next = { ...prev } as Record<string, TestState>;
      next[key] = { state: result.status, error: result.error, detail: result.detail };
      return next;
    });
  };

  const failPendingStatuses = (message: string) => {
    setTestStatuses((prev) => {
      if (!Object.keys(prev).length) return prev;
      const next: Record<string, TestState> = {};
      Object.entries(prev).forEach(([key, val]) => {
        if (val.state === "testing") {
          next[key] = { state: "failed", error: message, detail: message };
        } else {
          next[key] = val;
        }
      });
      return next;
    });
  };

  const handleRemoveReviewer = (idx: number) => {
    markConfigDirty();
    setReviewers((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [defaultModelConfig()];
    });
  };

  const collapsed = (
    <div
      class="bello-pill bello-collapsed"
      data-bello-drag-zone
      onClick={() => {
        const host = document.getElementById("bello-sidepanel-host");
        if (host?.dataset.justDragged === "1") return;
        setView(modelConfigured ? "main" : "config");
      }}
    >
      <div class="bello-label">Bello <span>•</span> AI Review</div>
      <div style="display:flex; gap:8px; align-items:center;">
        <div
          class="bello-eye-btn"
          id="bello-launcher-eye"
          title="Start"
          onClick={(e) => {
            e.stopPropagation();
            void onLauncherRun();
          }}
        >
          <div class="bello-sclera">
            <div class="bello-eyelid"></div>
            <div class="bello-pupil" id="bello-launcher-pupil"></div>
          </div>
        </div>
        <button
          class="bello-gear"
          title="Settings"
          onClick={(e) => {
            e.stopPropagation();
            setView("config");
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
      </div>
    </div>
  );

  const renderEye = (size: number, pupilSize: number, idSuffix: string, extraClass = "") => (
    <div class={`bello-eye-static ${extraClass}`} style={`width:${size}px; height:${size}px;`} id={`bello-eye-${idSuffix}`}>
      <div class="bello-sclera-static" style={`width:${size - 4}px; height:${size - 4}px;`}>
        <div class="bello-eyelid-static"></div>
        <div class="bello-pupil-static trackable-pupil" style={`width:${pupilSize}px; height:${pupilSize}px;`} id={`bello-pupil-${idSuffix}`}></div>
      </div>
    </div>
  );

  const modeBanner = (
    <div class="mode-display">
      <div class="mode-display-card">
        <div class="mode-visual">
          {effectiveMode === "ensemble" ? (
            <div class="mode-visual ensemble">
              {renderEye(18, 5, "ens-1")}
              {renderEye(18, 5, "ens-2")}
              {renderEye(18, 5, "ens-3")}
            </div>
          ) : (
            renderEye(32, 10, "single-mode")
          )}
        </div>
        <div class="mode-display-info">
          <div class="mode-title">{effectiveMode === "ensemble" ? "Ensemble Mode" : "Single Model"}</div>
          <div class="mode-desc">{effectiveMode === "ensemble" ? "Multiple models analyzing together" : "Standard analysis with one reviewer"}</div>
          <div class="bello-hint">
            {effectiveMode === "ensemble"
              ? "✨ Power mode active"
              : "💡 Add more reviewers to enable ensemble mode"}
          </div>
        </div>
      </div>
    </div>
  );

  const renderTestStatus = (key: string) => {
    const status = testStatuses[key];
    if (!status) return null;
    const label = status.state === "testing" ? "Testing" : status.state === "passed" ? "Passed" : "Failed";
    return (
      <div class={`bello-test-status ${status.state}`} title={status.error ?? ""}>
        <span class="status-dot" aria-hidden="true"></span>
        <span>{label}</span>
        {status.state === "failed" && status.error && <span class="status-error" title={status.error}>{status.error}</span>}
      </div>
    );
  };

  const configView = (
    <div class="bello-card">
      <div class="bello-header">
        <span style="display:flex; align-items:center; gap:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Configure Model
        </span>
      </div>
      <div class="bello-body" style="display:flex; flex-direction:column; gap:16px;">
        <div style="display:flex; flex-direction:column; gap:12px;">
          <div style="font-weight:600; font-size:12px; color:#57606a; text-transform:uppercase; letter-spacing:0.5px;">
            Reviewer Models
          </div>
          {duplicateReviewers && (
            <div class="bello-hint" style="border-color:#cf222e; color:#86181d; background:#fff5f5;">
              Duplicate reviewer detected (same model ID and base URL). Adjust models or remove a card before saving.
            </div>
          )}
          {reviewers.map((rev, idx) => (
            <div class="bello-model-card" key={idx}>
              <div class="bello-model-card-header">
                <span class="bello-chip">Reviewer {idx + 1}</span>
                {renderTestStatus(testStatusKey("reviewer", idx))}
                {reviewers.length > 1 && (
                  <button type="button" class="bello-icon-btn delete" onClick={() => handleRemoveReviewer(idx)}>
                    Remove
                  </button>
                )}
              </div>
              <div class="bello-model-main">
                <div style="flex:1;">
                  <label class="bello-field-label">Provider</label>
                  <select
                    class="bello-qa-input"
                    value={rev.provider}
                    onChange={(e) => {
                      markConfigDirty();
                      const next = [...reviewers];
                      const provider = (e.target as HTMLSelectElement).value as ProviderId;
                      next[idx].provider = provider;
                      next[idx].endpoint = getDefaultEndpoint(provider);
                      setReviewers(next);
                    }}
                  >
                    <option value="openrouter">OpenRouter</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Gemini API</option>
                  </select>
                </div>
                <div style="flex:2;">
                  <label class="bello-field-label">Model ID</label>
                  <input
                    class="bello-qa-input"
                    value={rev.model}
                    onInput={(e) => {
                      markConfigDirty();
                      const next = [...reviewers];
                      next[idx].model = (e.target as HTMLInputElement).value;
                      if (!next[idx].endpoint?.trim()) {
                        next[idx].endpoint = getDefaultEndpoint(next[idx].provider);
                      }
                      setReviewers(next);
                    }}
                    placeholder="e.g. openai/gpt-5-mini"
                  />
                </div>
                <div style="flex:1;">
                  <label class="bello-field-label">Alias (optional)</label>
                  <input
                    class="bello-qa-input"
                    value={rev.alias ?? ""}
                    onInput={(e) => {
                      markConfigDirty();
                      const next = [...reviewers];
                      next[idx].alias = (e.target as HTMLInputElement).value;
                      setReviewers(next);
                    }}
                    placeholder="e.g. Backend reviewer"
                  />
                </div>
              </div>
              <div class="bello-model-advanced" style="display:flex; flex-direction:column; gap:8px; padding-top:8px; border-top:1px solid #f0f0f0;">
                <div style="display:flex; gap:12px;">
                  <div style="flex:1;">
                    <label class="bello-field-label">API Key</label>
                    <input
                      class="bello-qa-input"
                      type="password"
                      value={rev.apiKey ?? ""}
                      onInput={(e) => {
                        markConfigDirty();
                        const next = [...reviewers];
                        next[idx].apiKey = (e.target as HTMLInputElement).value;
                        setReviewers(next);
                      }}
                      placeholder="sk-..."
                    />
                  </div>
                  <div style="flex:1;">
                  <label class="bello-field-label">Base URL (no /v1)</label>
                  <input
                    class="bello-qa-input"
                    value={rev.endpoint ?? ""}
                      onInput={(e) => {
                        markConfigDirty();
                        const next = [...reviewers];
                        next[idx].endpoint = (e.target as HTMLInputElement).value;
                        setReviewers(next);
                      }}
                    placeholder="https://api.example.com"
                  />
                </div>
              </div>
                <div style="display:flex; gap:12px;">
                  <div style="flex:1;">
                    <label class="bello-field-label">
                      <span>Temperature (optional)</span>
                      <span
                        class="bello-help-icon"
                        data-tip="Controls randomness/creativity. Lower = more deterministic; higher = more diverse responses (provider permitting)."
                        aria-label="Temperature help"
                        role="img"
                      >
                        ?
                      </span>
                    </label>
                    <input
                      class="bello-qa-input"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={rev.temperature ?? ""}
                      onInput={(e) => {
                        markConfigDirty();
                        const next = [...reviewers];
                        next[idx].temperature = toOptionalNumber((e.target as HTMLInputElement).value);
                        setReviewers(next);
                      }}
                      placeholder="0.2"
                    />
                  </div>
                  <div style="flex:1;">
                    <label class="bello-field-label">
                      <span>Seed (optional)</span>
                      <span
                        class="bello-help-icon"
                        data-tip="Sets a random seed for reproducible results when the model supports it."
                        aria-label="Seed help"
                        role="img"
                      >
                        ?
                      </span>
                    </label>
                    <input
                      class="bello-qa-input"
                      type="number"
                      step="1"
                      value={rev.seed ?? ""}
                      onInput={(e) => {
                        markConfigDirty();
                        const next = [...reviewers];
                        next[idx].seed = toOptionalNumber((e.target as HTMLInputElement).value);
                        setReviewers(next);
                      }}
                      placeholder="1234"
                    />
                  </div>
                </div>
                <div>
                  <label class="bello-field-label">
                    Advanced request options (JSON)
                    <span style="font-weight:400; font-size:11px; color:#57606a; margin-left:4px;">Merged into the request body; use for reasoning/tuning.</span>
                  </label>
                  <textarea
                    class="bello-qa-input"
                    rows={3}
                    spellcheck={false}
                    placeholder={`e.g. OpenAI:
{
  "temperature": 0,
  "reasoning": { "effort": "medium" }
}

Anthropic:
{
  "thinking": { "type": "enabled", "budget_tokens": 4096 }
}`}
                    value={rev.extraJson ?? ""}
                    onInput={(e) => {
                      markConfigDirty();
                      const next = [...reviewers];
                      next[idx].extraJson = (e.target as HTMLTextAreaElement).value;
                      setReviewers(next);
                    }}
                    style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:11px; min-height:70px;"
                  />
                </div>
              </div>
            </div>
          ))}
          {reviewers.length < maxReviewers ? (
            <button
              class="bello-btn bello-btn-dashed"
              onClick={() => {
                markConfigDirty();
                setReviewers([...reviewers, nextReviewerFromPrevious(reviewers[reviewers.length - 1])]);
              }}
            >
              + Add Reviewer
            </button>
          ) : (
            <div class="bello-hint" style="text-align:center;">Maximum of {maxReviewers} reviewers reached.</div>
          )}
        </div>

        {hasMultipleReviewers && (
          <div class="bello-arbiter-section">
            <label class="bello-toggle-row-simple">
              <span style="font-weight:600; font-size:13px;">
                Consolidation Model {arbiterRequired ? "(required for ensembles)" : ""}
              </span>
              <div
                class={`toggle-track ${arbiterActive ? "on" : ""} ${arbiterRequired ? "locked" : ""}`}
                onClick={() => {
                  if (arbiterRequired) return;
                  markConfigDirty();
                  setArbiterEnabled(!arbiterActive);
                }}
              >
                <div class="toggle-thumb"></div>
              </div>
            </label>
            {arbiterRequired && (
              <div class="bello-hint">Pick a consolidation model to merge multiple reviewer responses.</div>
            )}
            {arbiterActive && (
              <div class="bello-model-card arbiter">
                <div class="bello-model-card-header" style="margin-bottom:4px;">
                  <span class="bello-chip">Consolidation</span>
                  {renderTestStatus(testStatusKey("arbiter", 0))}
                </div>
                <div class="arbiter-choice">
                  <label class={`arbiter-option ${arbiterChoice === "existing" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="arbiter-choice"
                      checked={arbiterChoice === "existing"}
                      onChange={() => {
                        markConfigDirty();
                        setArbiterChoice("existing");
                      }}
                    />
                    <span>Use one of the reviewers</span>
                    <select
                      class="bello-qa-input"
                      value={String(Math.min(arbiterExistingIndex, reviewers.length - 1))}
                      onChange={(e) => {
                        markConfigDirty();
                        setArbiterChoice("existing");
                        setArbiterExistingIndex(Number((e.target as HTMLSelectElement).value));
                      }}
                    >
                      {reviewers.map((rev, idx) => (
                        <option value={idx} key={`arbiter-${idx}`}>
                          Reviewer {idx + 1}: {rev.alias?.trim() || rev.model || "Model not set"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label class={`arbiter-option ${arbiterChoice === "custom" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="arbiter-choice"
                      checked={arbiterChoice === "custom"}
                      onChange={() => {
                        markConfigDirty();
                        setArbiterChoice("custom");
                      }}
                    />
                    <span>Custom consolidation model</span>
                  </label>
                </div>
                {arbiterChoice === "custom" && (
                  <>
                    <div class="bello-model-main">
                      <div style="flex:1;">
                        <label class="bello-field-label">Provider</label>
                        <select
                          class="bello-qa-input"
                          value={arbiterCustom.provider}
                          onChange={(e) => {
                            markConfigDirty();
                            const provider = (e.target as HTMLSelectElement).value as ProviderId;
                            setArbiterCustom({ ...arbiterCustom, provider, endpoint: getDefaultEndpoint(provider) });
                          }}
                        >
                          <option value="openrouter">OpenRouter</option>
                          <option value="openai">OpenAI</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="gemini">Gemini API</option>
                        </select>
                      </div>
                      <div style="flex:2;">
                        <label class="bello-field-label">Model ID</label>
                        <input
                          class="bello-qa-input"
                          value={arbiterCustom.model}
                          onInput={(e) => {
                            markConfigDirty();
                            const model = (e.target as HTMLInputElement).value;
                            const endpoint = arbiterCustom.endpoint?.trim()
                              ? arbiterCustom.endpoint
                              : getDefaultEndpoint(arbiterCustom.provider);
                            setArbiterCustom({ ...arbiterCustom, model, endpoint });
                          }}
                          placeholder="e.g. openai/gpt-5-mini"
                        />
                      </div>
                      <div style="flex:1;">
                        <label class="bello-field-label">Alias (optional)</label>
                        <input
                          class="bello-qa-input"
                          value={arbiterCustom.alias ?? ""}
                          onInput={(e) => {
                            markConfigDirty();
                            setArbiterCustom({ ...arbiterCustom, alias: (e.target as HTMLInputElement).value });
                          }}
                          placeholder="e.g. Arbiter"
                        />
                      </div>
                    </div>
                    <div class="bello-model-advanced" style="display:flex; flex-direction:column; gap:8px; padding-top:8px; border-top:1px solid #f0f0f0;">
                      <div style="display:flex; gap:12px;">
                        <div style="flex:1;">
                          <label class="bello-field-label">API Key</label>
                          <input
                            class="bello-qa-input"
                            type="password"
                            value={arbiterCustom.apiKey ?? ""}
                            onInput={(e) => {
                              markConfigDirty();
                              setArbiterCustom({ ...arbiterCustom, apiKey: (e.target as HTMLInputElement).value });
                            }}
                            placeholder="sk-..."
                          />
                        </div>
                        <div style="flex:1;">
                          <label class="bello-field-label">Base URL (no /v1)</label>
                          <input
                            class="bello-qa-input"
                            value={arbiterCustom.endpoint ?? ""}
                            onInput={(e) => {
                              markConfigDirty();
                              setArbiterCustom({ ...arbiterCustom, endpoint: (e.target as HTMLInputElement).value });
                            }}
                            placeholder="https://api.example.com"
                          />
                        </div>
                      </div>
                      <div style="display:flex; gap:12px;">
                        <div style="flex:1;">
                          <label class="bello-field-label">
                            <span>Temperature (optional)</span>
                            <span
                              class="bello-help-icon"
                              data-tip="Controls randomness/creativity. Lower = more deterministic; higher = more diverse responses (provider permitting)."
                              aria-label="Temperature help"
                              role="img"
                            >
                              ?
                            </span>
                          </label>
                          <input
                            class="bello-qa-input"
                            type="number"
                            step="0.1"
                            min="0"
                            max="2"
                            value={arbiterCustom.temperature ?? ""}
                            onInput={(e) => {
                              markConfigDirty();
                              setArbiterCustom({ ...arbiterCustom, temperature: toOptionalNumber((e.target as HTMLInputElement).value) });
                            }}
                            placeholder="0.2"
                          />
                        </div>
                        <div style="flex:1;">
                          <label class="bello-field-label">
                            <span>Seed (optional)</span>
                            <span
                              class="bello-help-icon"
                              data-tip="Sets a random seed for reproducible results when the model supports it."
                              aria-label="Seed help"
                              role="img"
                            >
                              ?
                            </span>
                          </label>
                          <input
                            class="bello-qa-input"
                            type="number"
                            step="1"
                            value={arbiterCustom.seed ?? ""}
                            onInput={(e) => {
                              markConfigDirty();
                        setArbiterCustom({ ...arbiterCustom, seed: toOptionalNumber((e.target as HTMLInputElement).value) });
                      }}
                      placeholder="1234"
                    />
                  </div>
                </div>
                      <div>
                        <label class="bello-field-label">
                          Advanced request options (JSON)
                          <span style="font-weight:400; font-size:11px; color:#57606a; margin-left:4px;">Only for consolidation calls; merged into request.</span>
                        </label>
                        <textarea
                          class="bello-qa-input"
                          rows={3}
                          spellcheck={false}
                          placeholder={`e.g. Anthropic:
{
  "thinking": { "type": "enabled", "budget_tokens": 2048 }
}`}
                          value={arbiterCustom.extraJson ?? ""}
                          onInput={(e) => {
                            markConfigDirty();
                            setArbiterCustom({ ...arbiterCustom, extraJson: (e.target as HTMLTextAreaElement).value });
                          }}
                          style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:11px; min-height:70px;"
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div style="display:flex; gap:10px; margin-top:8px; padding-top:12px; border-top:1px solid #d0d7de;">
          <button
            class={`bello-btn bello-btn-primary ${savingModel ? "bello-btn-loading" : ""} ${saveSuccess ? "bello-btn-success" : ""}`}
            style="flex:1; justify-content:center; padding:8px;"
            onClick={async () => {
              if (savingModel) return;
              setError(null);
              setSaveSuccess(false);
              setTestStatuses({});
              if (reviewers.length > maxReviewers) {
                setError(`You can add up to ${maxReviewers} reviewers.`);
                return;
              }
              const cleanReviewers = reviewers.filter((r) => r.model.trim().length > 0);
              if (!cleanReviewers.length) {
                alert("Please add at least one reviewer model.");
                return;
              }
              if (reviewers.length > 1 && cleanReviewers.length < 2) {
                alert("Add details for each reviewer or remove empty cards before saving.");
                return;
              }
              const dupes = new Set<string>();
              for (const r of cleanReviewers) {
                const key = `${r.provider}:${r.model.trim().toLowerCase()}::${normalizeBase(r.endpoint)}::${r.temperature ?? "na"}::${r.seed ?? "na"}`;
                if (dupes.has(key)) {
                  setError("Duplicate reviewer models detected (same model ID and base URL). Use distinct reviewers or remove duplicates.");
                  return;
                }
                dupes.add(key);
              }
              const modeToSave: ModelConfigStored["mode"] = cleanReviewers.length > 1 ? "ensemble" : "single";
              const arbiterNeeded = modeToSave === "ensemble";
              const arbiterActiveForSave = arbiterNeeded || arbiterEnabled;
              let resolvedArbiter: ModelFormConfig | undefined;
              if (arbiterActiveForSave) {
                if (arbiterChoice === "existing") {
                  const idx = Math.min(arbiterExistingIndex, Math.max(0, cleanReviewers.length - 1));
                  resolvedArbiter = cleanReviewers[idx] ?? cleanReviewers[0];
                } else {
                  if (!arbiterCustom.model.trim()) {
                    alert("Please enter a consolidation model ID.");
                    return;
                  }
                  resolvedArbiter = arbiterCustom;
                }
              }
              if (arbiterNeeded && !resolvedArbiter) {
                alert("A consolidation model is required when using multiple reviewers.");
                return;
              }
              if (!validated) {
                const initialStatuses: Record<string, TestState> = {};
                cleanReviewers.forEach((_, idx) => {
                  initialStatuses[testStatusKey("reviewer", idx)] = { state: "testing" };
                });
                if (arbiterActiveForSave && resolvedArbiter) {
                  initialStatuses[testStatusKey("arbiter", 0)] = { state: "testing" };
                }
                setTestStatuses(initialStatuses);
                setSavingModel(true);
                try {
                  const response = await onTestModelConfig({
                    mode: modeToSave,
                    reviewers: cleanReviewers,
                    arbiter: arbiterActiveForSave ? resolvedArbiter : undefined
                  }, (result) => {
                    applyTestResult(result);
                  });
                  if (response.type === "TEST_MODEL_RESULT") {
                    applyTestResults(response.payload.results);
                    if (response.payload.ok && !(response.payload.results?.length ?? 0)) {
                      setValidated(true);
                    }
                    if (!response.payload.ok) {
                      const msg = response.payload.error ?? "Model test failed";
                      failPendingStatuses(msg);
                    }
                  } else if (response.type === "ERROR") {
                    failPendingStatuses(response.error);
                  } else {
                    const msg = "Model test failed";
                    failPendingStatuses(msg);
                  }
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  failPendingStatuses(msg);
                } finally {
                  setSavingModel(false);
                }
                return;
              }

              setSavingModel(true);
              try {
                await onSaveModelConfig({
                  mode: modeToSave,
                  reviewers: cleanReviewers,
                  arbiter: arbiterActiveForSave ? resolvedArbiter : undefined
                });
                setSaveSuccess(true);
                setTimeout(() => setSaveSuccess(false), 2000);
                setValidated(true);
                setView("main", "manual");
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                setError(msg);
              } finally {
                setSavingModel(false);
              }
            }}
            disabled={savingModel || duplicateReviewers}
          >
            {savingModel ? (validated ? "Saving..." : "Checking...") : saveSuccess ? "Saved!" : validated ? "Save Configuration" : "Check connectivity"}
          </button>
          <button
            class="bello-btn"
            style="padding:8px 16px;"
            onClick={() => {
              if (canGoBack) goBack();
              else setView("main");
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  const handleGoToCode = async (path: string, line: number, side: "left" | "right" = "right") => {
    const pathname = window.location.pathname;
    const fileNode = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    void trackEvent("go_to_code", {
      platform: prMeta?.platform ?? "unknown"
    });

    const isGithubFilesPage = /\/pull\/\d+\/files/.test(pathname);
    const isGitlabDiffsPage = /\/-\/merge_requests\/\d+\/diffs/.test(pathname);
    const onCorrectPage = prMeta?.platform === "gitlab" ? isGitlabDiffsPage : isGithubFilesPage;
    if (onCorrectPage && fileNode) {
      scrollToFile(path, line, side);
      return;
    }

    if (!prMeta) {
      scrollToFile(path, line, side);
      return;
    }

    const pending = {
      path,
      line,
      side,
      pr: { repo: prMeta.repo, number: prMeta.number, host: prMeta.host, platform: prMeta.platform },
      view
    };
    try {
      sessionStorage.setItem(PENDING_GOTO_KEY, JSON.stringify(pending));
    } catch {
      // ignore sessionStorage issues
    }

    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";

    if (prMeta.platform === "gitlab") {
      url.pathname = `/${prMeta.repo}/-/merge_requests/${prMeta.number}/diffs`;
      const fileHash = await sha1Hex(path);
      if (fileHash) url.searchParams.set("file", fileHash);
      window.location.href = url.toString();
      return;
    }

    url.pathname = `/${prMeta.repo}/pull/${prMeta.number}/files`;
    window.location.href = url.toString();
  };

  if (view === "collapsed") {
    return (
      <div>
        <style>{styles}</style>
        {collapsed}
      </div>
    );
  }

  const errorBanner = error && view !== "config" ? (
    <div class="bello-error-card">
      <div class="bello-error-icon">!</div>
      <div class="bello-error-content">
        <strong>System Failure</strong>
        <p>{error}</p>
        {error.includes("Extension was reloaded") && (
          <button
            class="bello-btn bello-btn-primary"
            style="margin-top:8px; padding:2px 8px; font-size:11px; line-height:16px; height:26px;"
            onClick={() => window.location.reload()}
          >
            Refresh tab
          </button>
        )}
      </div>
    </div>
  ) : null;

  const runningContent = (
    <div class="bello-loader-container">
      <div class="bello-loader">
        <div class="bello-loader-eye">
          <div class="bello-loader-pupil"></div>
        </div>
        <div class="bello-scan-line"></div>
      </div>
      <div class="bello-loader-text">
        Processing Code<span class="bello-dots">...</span>
      </div>
      <div class="bello-loader-subtext">Bello is analyzing your changes</div>
    </div>
  );

  const mainContent = (
    <>
      <div class="bello-actions">
        <button
          class={response && !running ? "bello-btn bello-btn-secondary" : "bello-btn bello-btn-primary"}
          onClick={onRun}
          disabled={running}
        >
          {running ? "Running..." : response ? "Re-run Review" : (
            <>
              <span>▶</span> Run Review
            </>
          )}
        </button>
        <button class="bello-btn bello-btn-secondary" onClick={() => setView("config", "manual")}>
          <span style="display:flex; align-items:center; gap:6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
            Configure Models
          </span>
        </button>
      </div>

      <div class="bello-card">
        <div class="bello-card-header">Custom Focus (Optional)</div>
        <div class="bello-card-body">
          <textarea
            class="bello-qa-input"
            rows={3}
            placeholder="e.g. Focus on logic correctness, edge cases, and concurrency risks."
            value={customPrompt}
            onInput={(e) => setCustomPrompt((e.target as HTMLTextAreaElement).value)}
          />
          <div class="bello-hint" style="margin-top:8px;">Applies to this review run only.</div>
        </div>
      </div>

      {availableVariants.length > 1 && (
        <div class="bello-variant-switch">
          {availableVariants.map((variant) => (
            <button
              key={variant.id}
              class={`bello-variant-btn ${activeVariant?.id === variant.id ? "active" : ""}`}
              onClick={() => setActiveVariantId(variant.id)}
            >
              <span class="bello-variant-name">{variant.label}</span>
              <span class="bello-variant-chip">{variant.type === "consolidated" ? "Consolidated" : "Model"}</span>
              {variant.error && <span class="bello-variant-error-chip">Error</span>}
            </button>
          ))}
        </div>
      )}

      <div class="bello-card">
        <div class="bello-card-header">Summary</div>
        <div class="bello-card-body" data-bello-summary>
          {variantError && <div class="bello-variant-error-text">{variantError}</div>}
          {summaryText}
        </div>
      </div>

      <div class="bello-finding-group">
        <div class="bello-group-title">Findings</div>
        <div class="bello-finding-filters">
          {SEVERITY_ORDER.map((severity) => {
            const enabled = severityFilter[severity];
            return (
              <button
                type="button"
                class={`bello-severity-filter sev-${severity} ${enabled ? "active" : "inactive"}`}
                aria-pressed={enabled}
                onClick={() => toggleSeverity(severity)}
              >
                <span class="bello-severity-label">{formatSeverityLabel(severity)}</span>
                <span class="bello-severity-count">{severityCounts[severity]}</span>
              </button>
            );
          })}
        </div>
        {variantError ? (
          <div class="bello-card" style="border-left:3px solid #d1242f;">
            <div class="bello-header" style="background:white; border-bottom:0;">
              <span style="display:flex; align-items:center; gap:6px; color:#d1242f; font-weight:600;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                Model error
              </span>
            </div>
            <div class="bello-body" style="padding-top:0;">
              <p style="margin:0; font-size:12px; color:#57606a;">{variantError}</p>
            </div>
          </div>
        ) : !hasAnyFindings ? (
          hasReviewResponse ? (
            <div class="bello-card" style="border-left:3px solid #2da44e;">
              <div class="bello-header" style="background:white; border-bottom:0;">
                <span style="display:flex; align-items:center; gap:4px; color:#2da44e; font-weight:600;">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  No issues found
                </span>
              </div>
              <div class="bello-body" style="padding-top:0;">
                <p style="margin:0; font-size:12px; color:#57606a;">Bello didn't find any potential issues in the analyzed files.</p>
              </div>
            </div>
          ) : (
            <div class="bello-card" style="background:white;">
              <div class="bello-header" style="background:white; border-bottom:0;">
                <span style="display:flex; align-items:center; gap:4px; color:#57606a; font-weight:600;">
                  Pending review
                </span>
              </div>
            </div>
          )
        ) : !hasVisibleFindings ? (
          <div class="bello-card" style="background:white;">
            <div class="bello-header" style="background:white; border-bottom:0;">
              <span style="display:flex; align-items:center; gap:4px; color:#57606a; font-weight:600;">
                No findings match current filters
              </span>
            </div>
            <div class="bello-body" style="padding-top:0;">
              <p style="margin:0; font-size:12px; color:#57606a;">Toggle the severity badges to show other findings.</p>
            </div>
          </div>
        ) : (
          filteredFindings.map((f, idx) => (
            <div class="bello-finding-item bello-stagger-item" style={`animation-delay: ${idx * 0.05}s`} key={`${f.filePath}-${f.startLine}-${idx}`}>
              <div class="bello-finding-header">
                <span class={`bello-severity ${f.severity === "blocker" ? "sev-high" : ""}`}>{f.severity}</span>
                <span class="bello-finding-path">{f.filePath}:{f.side === "left" ? "L" : "R"}{f.startLine}</span>
              </div>
              <div class="bello-rationale">
                {f.description}
              </div>
              {f.suggestionCode && (
                <div class="bello-code-block">
                  {f.suggestionCode.split("\n").map((line) => (
                    <span class={line.startsWith("+") ? "code-add" : line.startsWith("-") ? "code-del" : ""}>{line}</span>
                  ))}
                </div>
              )}
              <div class="bello-finding-footer">
                <button class="bello-badge-btn" onClick={() => void handleGoToCode(f.filePath, f.startLine, f.side ?? "right")}>Go to code</button>
              </div>
            </div>
          ))
        )}
      </div>

      {skipped.length > 0 && (
        <div class="bello-skipped-card">
          <strong>Skipped:</strong> {skipped.map((s) => s.file).join(", ")}
        </div>
      )}
    </>
  );

  const viewContent =
    view === "config"
      ? configView
      : view === "running"
        ? runningContent
        : mainContent;
  const viewLabel = view;

  return (
    <div id="bello-panel-root" tabIndex={-1}>
      <style>{styles}</style>
      <div class="bello-resize-handle" id="bello-resize-handle" title="Drag to resize"></div>
      <div class="bello-header" data-bello-drag-zone>
        <div class="bello-top-row">
          <div class="bello-brand-lockup">
            <div class="bello-header-eye" id="bello-panel-eye">
              <div class="bello-header-sclera">
                <div class="bello-header-eyelid"></div>
                <div class="bello-header-pupil" id="bello-panel-pupil"></div>
              </div>
            </div>
            Bello Code Reviewer <span style="color:#57606a; font-weight:500; font-size:11px;">[{viewLabel}]</span>
          </div>
          <button class="bello-close-btn" onClick={() => setView("collapsed")}>×</button>
        </div>

        {view !== "config" && (
          <div class="bello-context">
            <strong>{prMeta ? prMeta.repo : "owner/repo"}</strong> • {prMeta ? `${prMeta.platform === "gitlab" ? "MR" : "PR"} #${prMeta.number}` : "PR #?"}<br />
            <span class="bello-tag">{prMeta?.branch ?? "branch"}</span>
            {prMeta && (
              <span class="bello-tag" style="margin-left:6px;">
                {prMeta.platform.toUpperCase()} • {prMeta.host}
              </span>
            )}
          </div>
        )}
        {view === "config" && modeBanner}

        {errorBanner}
      </div>

      <div class="bello-body">
        <div key={view} class="bello-view-transition">
          {viewContent}
        </div>
      </div>
    </div>
  );
}

function scrollToFile(path: string, line: number, side: "left" | "right" = "right") {
  console.log("[bello] scrollToFile", { path, line, side });
  const fileNode = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
  if (!fileNode) {
    console.warn("[bello] scrollToFile: file node not found", { path });
    return;
  }

  const gitlabAnchor = findGitLabLineAnchor(fileNode, line, side);
  if (gitlabAnchor) {
    const href = gitlabAnchor.getAttribute("href") ?? "";
    let targetId: string | null = null;
    try {
      const targetUrl = new URL(href, window.location.href);
      window.history.pushState(null, "", targetUrl.toString());
      targetId = targetUrl.hash ? targetUrl.hash.replace(/^#/, "") : null;
    } catch {
      // ignore bad href
    }
    const targetEl =
      (targetId ? document.getElementById(targetId) : null) ??
      gitlabAnchor.closest<HTMLElement>('[data-testid="left-side"], [data-testid="right-side"]') ??
      gitlabAnchor.closest<HTMLElement>("[id]") ??
      gitlabAnchor.parentElement;
    (targetEl ?? gitlabAnchor).scrollIntoView({ behavior: "smooth", block: "center" });
    if (targetEl) showFloatingEye(targetEl);
    return;
  }
  const fileIdRows = Array.from(fileNode.querySelectorAll<HTMLElement>('tr[id^="diff-"]')).map((r) => r.id);
  console.log("[bello] scrollToFile: file node info", {
    pathAttr: fileNode.getAttribute("data-path"),
    nodeId: fileNode.id,
    dataset: { ...fileNode.dataset },
    diffRowsInFile: fileIdRows.length,
    sampleRowIds: fileIdRows.slice(0, 5)
  });

  const sideLetter = side === "left" ? "L" : "R";
  let row: HTMLElement | null = null;
  let targetCell: HTMLElement | null = null;
  let anchorId: string | undefined;

  // 1) Direct anchor from data-anchor if present
  const baseAnchor =
    fileNode.dataset.anchor ??
    (fileNode.id?.startsWith("diff-") ? fileNode.id : fileNode.querySelector<HTMLElement>('[id^="diff-"]')?.id);
  if (baseAnchor) {
    const targetId = `${baseAnchor}${sideLetter}${line}`;
    targetCell = document.getElementById(targetId) as HTMLElement | null;
    row = targetCell?.closest("tr") as HTMLElement | null;
    anchorId = targetCell?.id;
    console.log("[bello] scrollToFile: anchor lookup", { baseAnchor, targetId, cellFound: Boolean(targetCell), rowFound: Boolean(row) });
  }

  // 2) Try td with GitHub diff anchor id scoped to file node
  if (!row) {
    const cellById = fileNode.querySelector<HTMLElement>(`td[id^="diff-"][id$="${sideLetter}${line}"]`);
    if (cellById) {
      targetCell = cellById;
      row = cellById.closest("tr") as HTMLElement | null;
      anchorId = anchorId ?? cellById.id;
    }
    console.log("[bello] scrollToFile: cell by id (scoped)", {
      found: Boolean(targetCell),
      selector: `td[id^=\"diff-\"][id$=\"${sideLetter}${line}\"]`,
      rowFound: Boolean(row)
    });
  }

  // 3) Try row id scoped to file node
  if (!row) {
    row = fileNode.querySelector<HTMLElement>(`tr[id^="diff-"][id$="${sideLetter}${line}"]`);
    console.log("[bello] scrollToFile: row by id (scoped)", { found: Boolean(row), selector: `tr[id^=\"diff-\"][id$=\"${sideLetter}${line}\"]` });
  }

  if (!row) {
    const selectors: string[] = [];
    if (side === "right") {
      selectors.push(
        `td.blob-num-addition[data-line-number="${line}"]`,
        `td.blob-num-modified[data-line-number="${line}"]`,
        `td.blob-num-context[data-line-number="${line}"]`
      );
    } else {
      selectors.push(
        `td.blob-num-deletion[data-line-number="${line}"]`,
        `td.blob-num-deletion[data-line-number-old="${line}"]`,
        `td.blob-num-context[data-line-number="${line}"]`
      );
    }
    const lineCell = fileNode.querySelector<HTMLElement>(selectors.join(","));
    row = lineCell?.closest("tr") as HTMLElement | null;
    console.log("[bello] scrollToFile: row by cell", { found: Boolean(row), selectors });
  }

  if (!row) {
    // Try searching outside this file node in case GitHub split the DOM differently.
    const globalCell = document.querySelector<HTMLElement>(`td[id^="diff-"][id$="${sideLetter}${line}"]`);
    if (globalCell) {
      targetCell = globalCell;
      row = globalCell.closest("tr") as HTMLElement | null;
      anchorId = anchorId ?? globalCell.id;
      console.log("[bello] scrollToFile: found cell globally", { cellId: globalCell.id, rowId: row?.id });
    } else {
      const globalRow = document.querySelector<HTMLElement>(`tr[id^="diff-"][id$="${sideLetter}${line}"]`);
      if (globalRow) {
        console.log("[bello] scrollToFile: found row globally", { rowId: globalRow.id });
        row = globalRow;
      }
    }
  }

  if (!row) {
    if (baseAnchor) {
      const targetId = `${baseAnchor}${sideLetter}${line}`;
      const targetEl = document.getElementById(targetId);
      if (targetEl) {
        targetCell = targetEl;
        row = targetEl.closest("tr") as HTMLElement | null;
        anchorId = anchorId ?? targetEl.id;
        console.log("[bello] scrollToFile: base anchor matched element (fallback)", { targetId, rowId: row?.id });
      }
      const url = new URL(window.location.href);
      url.hash = `#${targetId}`;
      console.warn("[bello] scrollToFile: row not found, using base anchor", { baseAnchor, targetId, hash: url.hash, rowFound: Boolean(row) });
      window.history.pushState(null, "", url.toString());
    } else {
      console.warn("[bello] scrollToFile: row not found, scrolling to file header", { path, line, side });
    }
    fileNode.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const finalAnchorId = (row.id && row.id.startsWith("diff-") ? row.id : undefined) ?? anchorId ?? targetCell?.id;
  if (finalAnchorId) {
    const url = new URL(window.location.href);
    url.hash = `#${finalAnchorId}`;
    console.log("[bello] scrollToFile: updating hash", { hash: url.hash, anchorId: finalAnchorId });
    window.history.pushState(null, "", url.toString());
  }

  row.scrollIntoView({ behavior: "smooth", block: "center" });
  showFloatingEye(row);
}

function findGitLabLineAnchor(fileNode: HTMLElement, line: number, side: "left" | "right"): HTMLAnchorElement | null {
  const anchors = Array.from(fileNode.querySelectorAll<HTMLAnchorElement>(`a[data-linenumber="${line}"][href]`));
  if (!anchors.length) return null;
  const parsed = anchors
    .map((anchor) => {
      const href = anchor.getAttribute("href") ?? "";
      try {
        const url = new URL(href, window.location.href);
        const m = url.hash.match(/^#(?:[0-9a-f]{40})_(\d+)_(\d+)$/i);
        if (!m) return null;
        return { anchor, oldLine: Number(m[1]), newLine: Number(m[2]) };
      } catch {
        return null;
      }
    })
    .filter((v): v is { anchor: HTMLAnchorElement; oldLine: number; newLine: number } => Boolean(v));
  if (!parsed.length) return null;

  const match = parsed.find(({ oldLine, newLine }) => (side === "right" ? newLine : oldLine) === line) ?? parsed[0];
  return match.anchor;
}

async function sha1Hex(value: string): Promise<string | null> {
  if (!("crypto" in globalThis) || !crypto.subtle) return null;
  try {
    const data = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-1", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

let floatingEyeEl: HTMLElement | null = null;
let floatingEyeTarget: HTMLElement | null = null;
let floatingEyeTargetId: string | null = null;
let eyeListenersAttached = false;
let floatingEyePupil: HTMLElement | null = null;
let floatingEyeMoveHandler: ((e: MouseEvent) => void) | null = null;
type FloatingEyeScrollTarget = Window | HTMLElement;
let floatingEyeScrollTargets: FloatingEyeScrollTarget[] = [];
let floatingEyePositionRaf: number | null = null;
let floatingEyeChaseRaf: number | null = null;
let floatingEyeChaseUntilMs = 0;

function showFloatingEye(targetRow: HTMLElement) {
  floatingEyeTarget = targetRow;
  floatingEyeTargetId = targetRow.id || null;
  if (!floatingEyeEl) {
    ensureFloatingEyeStyles();
    const eye = document.createElement("div");
    eye.id = "bello-floating-eye";
    eye.className = "bello-header-eye bello-floating-eye";
    eye.innerHTML = `
      <div class="bello-header-sclera">
        <div class="bello-header-eyelid"></div>
        <div class="bello-header-pupil" id="bello-floating-pupil"></div>
      </div>
    `;
    floatingEyePupil = eye.querySelector<HTMLElement>("#bello-floating-pupil");
    floatingEyeEl = eye;
    floatingEyeEl.style.position = "fixed";
    floatingEyeEl.style.zIndex = "2147483646";
    floatingEyeEl.style.pointerEvents = "none";
    floatingEyeEl.style.transition = "transform 0.12s ease-out, opacity 0.2s ease-out";
    floatingEyeEl.style.opacity = "0.95";
    document.body.appendChild(floatingEyeEl);
    if (!floatingEyeMoveHandler) {
      floatingEyeMoveHandler = (e: MouseEvent) => {
        if (!floatingEyeEl || !floatingEyePupil) return;
        const rect = floatingEyeEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = Math.atan2(e.clientY - cy, e.clientX - cx);
        const max = 4;
        const dist = Math.min(max, Math.hypot(e.clientX - cx, e.clientY - cy));
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        floatingEyePupil.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      };
    }
  }
  if (!eyeListenersAttached) {
    eyeListenersAttached = true;
    window.addEventListener("resize", requestFloatingEyePositionUpdate);
    if (floatingEyeMoveHandler) {
      window.addEventListener("mousemove", floatingEyeMoveHandler, { passive: true });
    }
  }
  updateFloatingEyeScrollTargets(targetRow);
  chaseFloatingEyePosition(1200);
  requestFloatingEyePositionUpdate();
}

function updateFloatingEyePosition() {
  if (!floatingEyeEl) return;
  if (floatingEyeTargetId && (!floatingEyeTarget || !floatingEyeTarget.isConnected)) {
    const refreshed = document.getElementById(floatingEyeTargetId) as HTMLElement | null;
    if (refreshed) {
      floatingEyeTarget = refreshed;
      updateFloatingEyeScrollTargets(refreshed);
    }
  }
  if (!floatingEyeTarget) return;
  const rect = floatingEyeTarget.getBoundingClientRect();
  const top = rect.top - 3;
  const left = rect.left - 22;
  floatingEyeEl.style.top = `${top}px`;
  floatingEyeEl.style.left = `${Math.max(4, left)}px`;
}

function requestFloatingEyePositionUpdate() {
  if (floatingEyePositionRaf) return;
  floatingEyePositionRaf = window.requestAnimationFrame(() => {
    floatingEyePositionRaf = null;
    updateFloatingEyePosition();
  });
}

function chaseFloatingEyePosition(durationMs: number) {
  floatingEyeChaseUntilMs = Math.max(floatingEyeChaseUntilMs, Date.now() + durationMs);
  if (floatingEyeChaseRaf) return;
  const tick = () => {
    updateFloatingEyePosition();
    if (Date.now() < floatingEyeChaseUntilMs) {
      floatingEyeChaseRaf = window.requestAnimationFrame(tick);
    } else {
      floatingEyeChaseRaf = null;
    }
  };
  floatingEyeChaseRaf = window.requestAnimationFrame(tick);
}

function updateFloatingEyeScrollTargets(target: HTMLElement) {
  const nextTargets: FloatingEyeScrollTarget[] = [window, ...getScrollableAncestors(target)];
  for (const prev of floatingEyeScrollTargets) {
    if (nextTargets.includes(prev)) continue;
    prev.removeEventListener("scroll", requestFloatingEyePositionUpdate as any);
  }
  for (const next of nextTargets) {
    if (floatingEyeScrollTargets.includes(next)) continue;
    next.addEventListener("scroll", requestFloatingEyePositionUpdate as any, { passive: true });
  }
  floatingEyeScrollTargets = nextTargets;
}

function getScrollableAncestors(target: HTMLElement): HTMLElement[] {
  const ancestors: HTMLElement[] = [];
  let node: HTMLElement | null = target.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    const scrollableY = (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && node.scrollHeight > node.clientHeight;
    const scrollableX = (overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") && node.scrollWidth > node.clientWidth;
    if (scrollableY || scrollableX) ancestors.push(node);
    node = node.parentElement;
  }
  return ancestors;
}

function ensureFloatingEyeStyles() {
  if (document.getElementById("bello-floating-eye-style")) return;
  const style = document.createElement("style");
  style.id = "bello-floating-eye-style";
  style.textContent = `
    #bello-floating-eye {
      width: 28px;
      height: 28px;
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
    }
    .bello-floating-eye {
      width: 28px;
      height: 28px;
      background: #0f0f13;
      border-radius: 50%;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 6px rgba(0,0,0,0.18);
    }
    .bello-floating-eye .bello-header-sclera {
      width: 23px;
      height: 23px;
      background: white;
      border-radius: 50%;
      position: relative;
      overflow: hidden;
    }
    .bello-floating-eye .bello-header-pupil {
      width: 8px;
      height: 8px;
      background: #0f0f13;
      border-radius: 50%;
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
    }
    .bello-floating-eye .bello-header-eyelid {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: #F5E050;
      transform-origin: top;
      transform: scaleY(0);
      animation: belloBlinkFloating 5s infinite;
      z-index: 10;
    }
    @keyframes belloBlinkFloating {
      0%, 90%, 100% { transform: scaleY(0); }
      92%, 98% { transform: scaleY(1); }
    }
  `;
  document.head.appendChild(style);
}

const styles = `
#bello-launcher-root {
  position: fixed;
  top: 80px;
  right: 24px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
.bello-focus-highlight td.blob-code {
  outline: 2px solid #0969da;
  background-color: #ddf4ff;
  transition: background-color 0.3s ease-out;
}
#bello-floating-eye {
  text-shadow: 0 1px 2px rgba(0,0,0,0.2);
}
#bello-floating-eye .bello-header-eye {
  margin: 0;
}
.bello-pill {
  display: flex;
  align-items: center;
  background: #ffffff;
  border: 1px solid #d0d7de;
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
  border-radius: 100px;
  padding: 4px 4px 4px 14px;
  transition: transform 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  gap: 10px;
}
.bello-pill:hover {
  transform: scale(1.02);
  border-color: #F5E050;
  box-shadow: 0 8px 24px rgba(245, 224, 80, 0.15);
}
.bello-variant-switch {
  display: flex;
  gap: 8px;
  margin: 12px 0 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.bello-variant-switch::-webkit-scrollbar {
  display: none;
}
.bello-variant-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid #d0d7de;
  background: #ffffff;
  color: #0f0f13;
  cursor: pointer;
  box-shadow: inset 0 -2px 0 rgba(15,15,19,0.05);
  transition: all 0.12s ease;
  font-size: 12px;
}
.bello-variant-btn:hover {
  border-color: #b6bfc8;
  background: #f8fafc;
}
.bello-variant-btn.active {
  border-color: #F5E050;
  background: #F5E050;
  color: #0f0f13;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,0.08);
}
.bello-variant-name {
  font-weight: 700;
}
.bello-variant-chip {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(15,15,19,0.06);
  font-size: 11px;
  color: #0f0f13;
}
.bello-variant-btn.active .bello-variant-chip {
  background: rgba(0,0,0,0.08);
  color: #0f0f13;
}
.bello-variant-error-chip {
  padding: 2px 6px;
  border-radius: 999px;
  background: #fdeceb;
  color: #b42318;
  font-weight: 600;
  font-size: 11px;
}
.bello-variant-btn.active .bello-variant-error-chip {
  background: rgba(0,0,0,0.12);
  color: #b42318;
}
.bello-variant-error-text {
  color: #b42318;
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 6px;
}
.bello-label {
  font-size: 13px;
  font-weight: 700;
  color: #0f0f13;
  letter-spacing: -0.3px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: default;
}
.bello-label span { color: #d0d7de; }
.bello-eye-btn {
  width: 24px; 
  height: 24px;
  background: #0f0f13;
  border-radius: 50%;
  position: relative;
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.2s;
  border: none;
}
.bello-eye-btn:hover { transform: scale(1.1); }
.bello-sclera {
  width: 19px; 
  height: 19px;
  background: white;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
}
.bello-pupil {
  width: 6px; 
  height: 6px;
  background: #0f0f13;
  border-radius: 50%;
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.bello-eyelid {
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  background: #F5E050;
  transform-origin: top;
  transform: scaleY(0);
  animation: belloBlink 4s infinite;
  z-index: 10;
}
@keyframes belloBlink {
  0%, 48%, 52%, 100% { transform: scaleY(0); }
  50% { transform: scaleY(1); }
}
.bello-gear {
  color: #57606a;
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bello-gear:hover { background: #f6f8fa; color: #0f0f13; }

  #bello-panel-root {
    position: relative;
    width: 100%;
    height: 100%;
    background: #ffffff;
    border-left: 1px solid #d0d7de;
    outline: none;
    box-shadow: -10px 0 30px rgba(0,0,0,0.1);
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #24292f;
    user-select: text;
    padding-left: 6px;
  }
.bello-resize-handle {
  position: absolute;
  top: 0;
  left: -6px;
  width: 12px;
  height: 100%;
  cursor: col-resize;
  z-index: 2147483648;
}
.bello-resize-handle::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 28px;
  transform: translate(-50%, -50%);
  background: #d0d7de;
  border-radius: 2px;
}
.bello-header {
  padding: 20px;
  border-bottom: 1px solid #d0d7de;
  background: #fcfcfc;
}
.bello-top-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}
.bello-brand-lockup {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 18px;
  color: #0f0f13;
}
.bello-header-eye {
  width: 28px;
  height: 28px;
  background: #0f0f13;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.bello-header-sclera {
  width: 23px;
  height: 23px;
  background: white;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
}
.bello-header-pupil {
  width: 8px;
  height: 8px;
  background: #0f0f13;
  border-radius: 50%;
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
}
.bello-header-eyelid {
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  background: #F5E050;
  transform-origin: top;
  transform: scaleY(0);
  animation: belloBlink 5s infinite;
  z-index: 10;
}
.bello-close-btn {
  background: none;
  border: none;
  color: #57606a;
  cursor: pointer;
  font-size: 18px;
  padding: 4px;
  transition: color 0.2s;
}
.bello-close-btn:hover { color: #0f0f13; }
.bello-context {
  font-size: 12px;
  color: #57606a;
  margin-bottom: 12px;
}
.bello-tag {
  font-family: ui-monospace, SFMono-Regular, monospace;
  background: #f3f4f6;
  padding: 2px 6px;
  border-radius: 4px;
  color: #0f0f13;
  border: 1px solid #d0d7de;
}
.bello-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bello-qa-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  font-size: 13px;
  background: #ffffff;
  color: #24292f;
  box-sizing: border-box;
}
.bello-qa-input:focus {
  border-color: #F5E050;
  box-shadow: 0 0 0 1px #F5E050;
  outline: none;
}
.bello-btn {
  background: #f6f8fa;
  color: #24292f;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.2s;
}
.bello-btn:hover { background: #eaeef2; }
.bello-btn-primary {
  background: #F5E050;
  color: #0f0f13;
  border-color: #F5E050;
  font-weight: 600;
}
.bello-btn-primary:hover { background: #EAC545; border-color: #EAC545; }
.bello-btn-primary:disabled {
  background: #f6f8fa;
  color: #8c959f;
  border-color: #d0d7de;
  cursor: not-allowed;
}
.bello-btn-secondary {
  background: #ffffff;
  color: #24292f;
}
.bello-btn-dashed {
  background: transparent;
  border: 1px dashed #d0d7de;
  color: #57606a;
}
.bello-btn-dashed:hover {
  border-color: #57606a;
  color: #24292f;
  background: #f6f8fa;
}
.bello-actions {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
  user-select: none;
}
.bello-card {
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,0.04);
}
.bello-card-header {
  padding: 12px 16px;
  border-bottom: 1px solid #d0d7de;
  font-weight: 700;
  background: #fffdf5;
  color: #24292f;
  font-size: 13px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
}
.bello-card-body {
  padding: 16px;
  font-size: 13px;
  color: #24292f;
  line-height: 1.5;
}
.bello-finding-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bello-group-title {
  font-size: 12px;
  font-weight: 700;
  color: #24292f;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.bello-group-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e1e4e8;
}
.bello-finding-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: -4px;
}
.bello-severity-filter {
  border: 1px solid #d0d7de;
  background: #ffffff;
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
  color: #57606a;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all 0.2s;
}
.bello-severity-filter:hover {
  border-color: #57606a;
  color: #24292f;
}
.bello-severity-filter.inactive { opacity: 0.45; }
.bello-severity-filter.active { font-weight: 600; }
.bello-severity-filter.sev-blocker.active { background: #ffebe9; color: #cf222e; border-color: rgba(207, 34, 46, 0.3); }
.bello-severity-filter.sev-major.active { background: #fff8c5; color: #9a6700; border-color: rgba(154, 103, 0, 0.3); }
.bello-severity-filter.sev-minor.active { background: #ddf4ff; color: #0969da; border-color: rgba(9, 105, 218, 0.3); }
.bello-severity-count {
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.bello-finding-item {
  border: 1px solid #d0d7de;
  border-radius: 12px;
  padding: 16px;
  background: #ffffff;
  transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
}
.bello-finding-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0,0,0,0.08);
  border-color: #F5E050;
  z-index: 1;
}
.bello-finding-header {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.bello-finding-path {
  font-family: monospace;
  color: #57606a;
  word-break: break-all;
  flex: 1;
  min-width: 220px;
}
.bello-severity {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 4px;
  background: #f6f8fa;
  color: #24292f;
  text-transform: capitalize;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid #d0d7de;
}
.bello-severity.sev-high { background: #ffebe9; color: #cf222e; border: 1px solid rgba(207, 34, 46, 0.2); }
.bello-rationale { font-size: 13px; color: #24292f; margin-bottom: 12px; line-height: 1.5; }
.bello-code-block {
  background: #f6f8fa;
  border-radius: 6px;
  padding: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  border: 1px solid #d0d7de;
  color: #24292f;
  margin-bottom: 12px;
  overflow-x: auto;
}
.bello-finding-footer { display: flex; gap: 8px; }
.bello-badge-btn {
  border: 1px solid #d0d7de;
  background: #ffffff;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 11px;
  cursor: pointer;
  color: #57606a;
  transition: all 0.2s;
}
.bello-badge-btn:hover { background: #f6f8fa; color: #24292f; border-color: #d0d7de; }

/* Error Card */
.bello-error-card {
  background: #fff8f8;
  border: 1px solid #ff8182;
  color: #24292f;
  padding: 16px;
  border-radius: 8px;
  font-size: 13px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  box-shadow: 0 4px 12px rgba(255, 68, 68, 0.15);
  position: relative;
  overflow: hidden;
}

.bello-error-icon {
  background: #cf222e;
  color: #ffffff;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 900;
  flex-shrink: 0;
  font-family: monospace;
  font-size: 16px;
}
.bello-error-content strong {
  display: block;
  margin-bottom: 4px;
  color: #cf222e;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.bello-error-content p { margin: 0; color: #24292f; }



/* Loader */
.bello-loader-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.04);
}
.bello-loader {
  width: 60px;
  height: 60px;
  background: #0f0f13;
  border-radius: 50%;
  position: relative;
  margin-bottom: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 4px rgba(15, 15, 19, 0.1);
}
.bello-loader-eye {
  width: 40px;
  height: 40px;
  background: #ffffff;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
}
.bello-loader-pupil {
  width: 14px;
  height: 14px;
  background: #0f0f13;
  border-radius: 50%;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  animation: belloLookAround 3s infinite;
}
.bello-scan-line {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 2px solid #F5E050;
  opacity: 0;
  animation: belloScan 2s infinite;
  pointer-events: none;
}
.bello-loader-text {
  font-size: 16px;
  font-weight: 700;
  color: #0f0f13;
  margin-bottom: 6px;
}
.bello-loader-subtext {
  font-size: 13px;
  color: #57606a;
}
.bello-dots {
  display: inline-block;
  width: 20px;
  text-align: left;
  animation: belloDots 1.5s infinite;
}

@keyframes belloLookAround {
  0%, 100% { transform: translate(-50%, -50%); }
  20% { transform: translate(-20%, -50%); }
  40% { transform: translate(-80%, -50%); }
  60% { transform: translate(-50%, -80%); }
  80% { transform: translate(-50%, -20%); }
}
@keyframes belloScan {
  0% { transform: scale(1); opacity: 0.8; }
  100% { transform: scale(1.4); opacity: 0; }
}
@keyframes belloDots {
  0% { content: "."; }
  33% { content: ".."; }
  66% { content: "..."; }
}

.toggle-track {
  width: 36px;
  height: 18px;
  background: #d0d7de;
  border-radius: 10px;
  position: relative;
  margin-right: 8px;
  cursor: pointer;
}
.toggle-thumb {
  width: 16px;
  height: 16px;
  background: #ffffff;
  border-radius: 50%;
  position: absolute;
  top: 1px;
  left: 1px;
  transition: transform 0.2s, background 0.2s;
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
.toggle-track.on { background: #F5E050; }
.toggle-track.on .toggle-thumb { transform: translateX(18px); background: #0f0f13; }
.toggle-track.locked { cursor: not-allowed; opacity: 0.8; }
.file-check {
  margin-right: 8px;
  accent-color: #F5E050;
}
.bello-mode-selector {
  display: flex;
  gap: 12px;
}
.bello-mode-option {
  flex: 1;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative;
  transition: all 0.2s;
  background: #ffffff;
}
.bello-mode-option:hover {
  border-color: #F5E050;
  background: #fffdf5;
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(245, 224, 80, 0.2);
}
.bello-mode-option.selected {
  border-color: #F5E050;
  background: #fffdf5;
  box-shadow: 0 0 0 1px #F5E050;
}
.mode-visual {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
.mode-visual.ensemble {
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
}
.bello-eye-static {
  background: #0f0f13;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.bello-sclera-static {
  background: white;
  border-radius: 50%;
  position: relative;
  overflow: hidden;
}
.bello-pupil-static {
  background: #0f0f13;
  border-radius: 50%;
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
}
.bello-eyelid-static {
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  background: #F5E050;
  transform-origin: top;
  transform: scaleY(0);
  animation: belloBlink 4s infinite;
  z-index: 10;
}
.mode-info { display: flex; flex-direction: column; gap: 2px; }
.mode-title { font-weight: 600; font-size: 13px; color: #24292f; }
.mode-desc { font-size: 11px; color: #57606a; }
.mode-check {
  position: absolute;
  top: 6px;
  right: 6px;
  color: #F5E050;
  font-weight: bold;
  font-size: 12px;
}
.mode-display {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
}
.mode-display-card {
  display: flex;
  align-items: center;
  gap: 16px;
  background: linear-gradient(135deg, #ffffff 0%, #fffdf5 100%);
  border: 1px solid #F5E050;
  border-radius: 12px;
  padding: 16px;
  width: 100%;
  box-sizing: border-box;
  box-shadow: 0 4px 12px rgba(245, 224, 80, 0.15);
  position: relative;
  overflow: hidden;
}
.mode-display-card::before {
  content: "";
  position: absolute;
  top: 0; right: 0;
  width: 100px; height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8));
  pointer-events: none;
}
.mode-display-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  z-index: 1;
}
.mode-display-info .mode-title {
  font-weight: 800;
  font-size: 16px;
  color: #0f0f13;
  letter-spacing: -0.3px;
}
.mode-display-info .mode-desc {
  font-size: 13px;
  color: #57606a;
}
.bello-hint {
  font-size: 11px;
  color: #57606a;
  background: rgba(246, 248, 250, 0.8);
  border: 1px dashed #d0d7de;
  border-radius: 6px;
  padding: 6px 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  align-self: flex-start;
}
.bello-model-card {
  background: #ffffff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: box-shadow 0.2s;
}
.bello-model-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.08);
  transform: translateY(-1px);
}
.bello-model-card.arbiter {
  border-color: #a371f7;
  background: #fcfaff;
}
.bello-model-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bello-chip {
  background: #f6f8fa;
  color: #111827;
  border: 1px solid #d0d7de;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.bello-model-main {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.bello-model-main > div {
  min-width: 0;
}
.bello-field-label {
  font-size: 11px;
  font-weight: 600;
  color: #57606a;
  margin-bottom: 4px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bello-help-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #f2f4f7;
  color: #57606a;
  font-size: 11px;
  font-weight: 700;
  cursor: help;
  border: 1px solid #d0d7de;
  flex-shrink: 0;
  position: relative;
}
.bello-help-icon:hover {
  background: #e6e8eb;
  color: #24292f;
  border-color: #afb8c1;
}
.bello-help-icon::after {
  content: attr(data-tip);
  position: absolute;
  top: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: #24292f;
  color: #ffffff;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  white-space: pre-wrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.08s ease-in;
  min-width: 180px;
  max-width: min(260px, 70vw);
  z-index: 20;
}
.bello-help-icon:hover::after {
  opacity: 1;
}
.bello-model-advanced input {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.bello-icon-btn.delete {
  background: none;
  border: none;
  color: #cf222e;
  cursor: pointer;
  margin-left: auto;
}
.bello-icon-btn.delete:hover { color: #a40e26; }
.arbiter-choice {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.arbiter-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border: 1px dashed #d0d7de;
  border-radius: 8px;
  cursor: pointer;
}
.arbiter-option.selected {
  border-color: #a371f7;
  background: #f4edff;
}
.arbiter-option input {
  margin: 0;
}
.arbiter-option select {
  flex: 1;
}
.bello-arbiter-section {
  border-top: 1px solid #d0d7de;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bello-toggle-row-simple {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #24292f;
}

/* Loading Button */
.bello-btn-loading {
  position: relative;
  color: transparent !important;
  pointer-events: none;
}
.bello-btn-loading::after {
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  width: 16px; height: 16px;
  margin: -8px 0 0 -8px;
  border: 2px solid #0f0f13;
  border-top-color: transparent;
  border-radius: 50%;
  animation: belloSpin 0.8s linear infinite;
}
.bello-btn-success {
  background: #2da44e !important;
  border-color: #2da44e !important;
  color: #ffffff !important;
  transition: all 0.3s ease;
}
.bello-test-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #0f172a;
  flex: 1;
  min-width: 0;
  white-space: normal;
  overflow: visible;
}
.bello-test-status .status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d0d7de;
}
.bello-test-status.testing .status-dot {
  background: #0ea5e9;
  animation: belloPulse 1s ease-in-out infinite;
}
.bello-test-status.passed {
  color: #1a7f37;
}
.bello-test-status.passed .status-dot {
  background: #1a7f37;
}
.bello-test-status.failed {
  color: #cf222e;
}
.bello-test-status.failed .status-dot {
  background: #cf222e;
}
.bello-test-status .status-error {
  font-weight: 400;
  color: #cf222e;
  white-space: normal;
  overflow-wrap: anywhere;
}
.status-dot {
  display: inline-block;
}
@keyframes belloSpin {
  to { transform: rotate(360deg); }
}
@keyframes belloPulse {
  0% { transform: scale(0.95); opacity: 0.6; }
  50% { transform: scale(1.15); opacity: 1; }
  100% { transform: scale(0.95); opacity: 0.6; }
}


/* View Transitions */
.bello-view-transition {
  animation: belloFadeIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}
@keyframes belloFadeIn {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* List Stagger */
.bello-stagger-item {
  animation: belloSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1) backwards;
}
@keyframes belloSlideIn {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}

/* Hover Effects */
.bello-finding-item {
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s, border-color 0.2s;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 16px;
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.02);
}
.bello-finding-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(0,0,0,0.08);
  border-color: #F5E050;
  z-index: 1;
}

/* Actions Grid */
.bello-actions {
  display: grid;
  grid-template-columns: 1.2fr 1fr 1fr;
  gap: 12px;
  user-select: none;
}

/* Section Titles */
.bello-group-title {
  font-size: 14px;
  font-weight: 700;
  color: #24292f;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.bello-group-title::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #e1e4e8;
}

/* Skipped Section Card */
.bello-skipped-card {
  background: #f6f8fa;
  border: 1px dashed #d0d7de;
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 12px;
  color: #57606a;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Config Visual Improvements */
.bello-model-card {
  animation: belloPopIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
}
@keyframes belloPopIn {
  from { opacity: 0; transform: scale(0.95); }
  to { opacity: 1; transform: scale(1); }
}

.bello-arbiter-section {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.bello-qa-input:focus, .bello-model-advanced input:focus {
  border-color: #F5E050;
  box-shadow: 0 0 0 3px rgba(245, 224, 80, 0.3);
  outline: none;
}

.mode-visual {
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}
`;
