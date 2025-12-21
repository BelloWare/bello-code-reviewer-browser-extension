async function readLocal<T = any>(keys: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve(items as T);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function writeLocal(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function removeLocal(keys: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          return reject(chrome.runtime.lastError);
        }
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

export type Platform = "github" | "gitlab";

export type HostConfigEntry = {
  hostname: string;
  platform: Platform;
  enabled: boolean;
};

export type HostConfig = {
  entries: HostConfigEntry[];
};

export async function getHostConfig(): Promise<HostConfig> {
  try {
    const items = await readLocal<{ hostConfig?: HostConfig }>(["hostConfig"]);
    const cfg = items.hostConfig;
    if (cfg && Array.isArray(cfg.entries)) {
      const entries = cfg.entries
        .filter((e): e is HostConfigEntry => Boolean(e) && typeof e.hostname === "string" && typeof e.platform === "string")
        .map((e) => ({
          hostname: e.hostname.trim().toLowerCase(),
          platform: e.platform === "gitlab" ? "gitlab" : "github",
          enabled: e.enabled !== false
        }));
      return { entries: entries.filter((e) => e.hostname.length > 0) };
    }
  } catch (err) {
    console.warn("[bello] getHostConfig failed, defaulting to empty", err);
  }
  return { entries: [] };
}

export async function setHostConfig(config: HostConfig): Promise<void> {
  try {
    await writeLocal({ hostConfig: config });
  } catch (err) {
    console.warn("[bello] setHostConfig failed", err);
  }
}

export async function getDebugMode(): Promise<boolean> {
  if (!__BELLO_DEBUG_BUILD__) return false;
  try {
    const items = await readLocal<{ debugMode?: boolean }>(["debugMode"]);
    return Boolean(items.debugMode);
  } catch (err) {
    // Intentional: debug mode should never break the extension; default to off.
    console.warn("[bello] getDebugMode failed, disabling debug mode", err);
    return false;
  }
}

export async function setDebugMode(value: boolean): Promise<void> {
  try {
    await writeLocal({ debugMode: __BELLO_DEBUG_BUILD__ ? value : false });
  } catch (err) {
    // Intentional: failing to persist debug mode should not break the extension.
    console.warn("[bello] setDebugMode failed", err);
  }
}

export async function getClientId(): Promise<string> {
  try {
    const items = await readLocal<{ debugClientId?: string }>(["debugClientId"]);
    if (items.debugClientId) return items.debugClientId;
    const id = `client-${Math.random().toString(36).slice(2)}`;
    await writeLocal({ debugClientId: id });
    return id;
  } catch (err) {
    // Intentional: use an ephemeral ID if storage is unavailable.
    console.warn("[bello] getClientId failed, using ephemeral client id", err);
    return `client-${Math.random().toString(36).slice(2)}`;
  }
}

export type SidebarPosition = { top: number; right: number };

export async function getSidebarPosition(defaultPos: SidebarPosition): Promise<SidebarPosition> {
  const items = await readLocal<{ sidebarPosition?: SidebarPosition }>(["sidebarPosition"]);
  const pos = items.sidebarPosition;
  if (pos && typeof pos.top === "number" && typeof pos.right === "number") {
    return { top: pos.top, right: pos.right };
  }
  // No value in storage: fall back to default position.
  return defaultPos;
}

export async function setSidebarPosition(pos: SidebarPosition): Promise<void> {
  await writeLocal({ sidebarPosition: pos });
}

export async function clearSidebarPosition(): Promise<void> {
  await removeLocal(["sidebarPosition"]);
}

export async function getSidebarWidth(defaultWidth: number): Promise<number> {
  const items = await readLocal<{ sidebarWidth?: number }>(["sidebarWidth"]);
  const val = Number(items.sidebarWidth);
  if (Number.isFinite(val) && val > 0) {
    return val;
  }
  return defaultWidth;
}

export async function setSidebarWidth(width: number): Promise<void> {
  await writeLocal({ sidebarWidth: width });
}

export type SeverityFilter = {
  blocker: boolean;
  major: boolean;
  minor: boolean;
};

const DEFAULT_SEVERITY_FILTER: SeverityFilter = {
  blocker: true,
  major: true,
  minor: true
};

export async function getSeverityFilter(): Promise<SeverityFilter> {
  try {
    const items = await readLocal<{ severityFilter?: Partial<SeverityFilter> }>(["severityFilter"]);
    const cfg = items.severityFilter;
    if (cfg && typeof cfg === "object") {
      return {
        blocker: typeof cfg.blocker === "boolean" ? cfg.blocker : true,
        major: typeof cfg.major === "boolean" ? cfg.major : true,
        minor: typeof cfg.minor === "boolean" ? cfg.minor : true
      };
    }
  } catch (err) {
    console.warn("[bello] getSeverityFilter failed, defaulting to all", err);
  }
  return { ...DEFAULT_SEVERITY_FILTER };
}

export async function setSeverityFilter(filter: SeverityFilter): Promise<void> {
  await writeLocal({ severityFilter: filter });
}

export type ProviderId = "openrouter" | "openai" | "anthropic" | "gemini";

export type ReviewerModelConfig = {
  provider: ProviderId;
  model: string;
  alias?: string;
  endpoint?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  /**
   * Advanced request options serialized as JSON.
   * Merged into the provider request body; used for reasoning/tuning knobs.
   */
  extraJson?: string;
};

export type ArbiterModelConfig = ReviewerModelConfig;

export type ModelConfigStored = {
  mode: "single" | "ensemble";
  reviewers: ReviewerModelConfig[];
  arbiter?: ArbiterModelConfig;
};

export async function getModelConfig(): Promise<ModelConfigStored | null> {
  const items = await readLocal<{ modelConfig?: ModelConfigStored }>(["modelConfig"]);
  const cfg = items.modelConfig;
  if (cfg && Array.isArray(cfg.reviewers) && cfg.reviewers.length > 0) {
    return cfg;
  }
  return null;
}

export async function setModelConfig(config: ModelConfigStored): Promise<void> {
  await writeLocal({ modelConfig: config });
}

export async function clearModelConfig(): Promise<void> {
  await removeLocal(["modelConfig"]);
}
