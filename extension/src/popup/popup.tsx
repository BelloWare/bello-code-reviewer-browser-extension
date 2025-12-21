import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { HostConfig, HostConfigEntry, Platform } from "../shared/storage";
import { clearModelConfig, clearSidebarPosition, getDebugMode, getHostConfig, getModelConfig, setDebugMode, setHostConfig } from "../shared/storage";
import { builtinPlatformForHost, resolvePlatformForHost } from "../shared/hostResolver";
import { logDebug, reportError } from "../shared/debugReporter";
import { trackEvent } from "../shared/analytics";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app root");

window.addEventListener("error", (event) => {
  void reportError("popup", "window.onerror", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  void reportError("popup", "unhandledrejection", event.reason);
});

type Toast = { kind: "success" | "error" | "info"; text: string };

const popupStyles = `
  :root { color-scheme: light; }

  body {
    margin: 0;
    background: #f6f8fa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #24292f;
  }

  #app {
    min-width: 360px;
    max-width: 420px;
  }

  .bello-popup {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .bello-popup-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    background: #ffffff;
    border: 1px solid #d0d7de;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }

  .bello-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .bello-brand-icon {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
  }

  .bello-brand-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .bello-brand-title {
    font-weight: 800;
    letter-spacing: -0.3px;
    line-height: 1.1;
  }

  .bello-brand-subtitle {
    font-size: 12px;
    color: #57606a;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bello-toast {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #d0d7de;
    background: #ffffff;
    font-size: 12px;
    color: #24292f;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }
  .bello-toast.success { border-color: rgba(26, 127, 55, 0.25); background: #f0fff4; }
  .bello-toast.error { border-color: rgba(207, 34, 46, 0.25); background: #fff5f5; }

  .bello-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .bello-muted { color: #57606a; font-size: 12px; }

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
    padding: 14px 16px;
    font-size: 13px;
    color: #24292f;
    line-height: 1.4;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .bello-tag {
    font-family: ui-monospace, SFMono-Regular, monospace;
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    color: #0f0f13;
    border: 1px solid #d0d7de;
  }

  .bello-chip {
    background: #f6f8fa;
    color: #111827;
    border: 1px solid #d0d7de;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .bello-chip.good { background: #f0fff4; border-color: rgba(26, 127, 55, 0.25); color: #1a7f37; }
  .bello-chip.bad { background: #fff5f5; border-color: rgba(207, 34, 46, 0.25); color: #cf222e; }

  .bello-field-label {
    font-size: 11px;
    font-weight: 600;
    color: #57606a;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
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
    padding: 7px 10px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.2s;
    font-size: 13px;
    user-select: none;
  }
  .bello-btn:hover { background: #eaeef2; }
  .bello-btn:disabled { cursor: not-allowed; opacity: 0.65; }
  .bello-btn-primary {
    background: #F5E050;
    color: #0f0f13;
    border-color: #F5E050;
    font-weight: 700;
  }
  .bello-btn-primary:hover { background: #EAC545; border-color: #EAC545; }
  .bello-btn-secondary { background: #ffffff; }
  .bello-btn-danger {
    background: #fff5f5;
    border-color: rgba(207, 34, 46, 0.25);
    color: #cf222e;
  }
  .bello-btn-danger:hover { background: #ffebe9; border-color: rgba(207, 34, 46, 0.35); }

  .bello-btn-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .toggle-track {
    width: 36px;
    height: 18px;
    background: #d0d7de;
    border-radius: 10px;
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
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

  .bello-hint {
    font-size: 11px;
    color: #57606a;
    background: rgba(246, 248, 250, 0.8);
    border: 1px dashed #d0d7de;
    border-radius: 6px;
    padding: 6px 10px;
  }

  .bello-divider {
    height: 1px;
    background: #e1e4e8;
    margin: 2px 0;
  }
`;

function formatPlatform(platform: Platform): string {
  return platform === "gitlab" ? "GitLab" : "GitHub";
}

function Toggle({
  value,
  onChange,
  label,
  disabled
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div class="bello-row" role="group" aria-label={label}>
      <div style="min-width:0;">
        <div style="font-weight:600;">{label}</div>
      </div>
      <div
        class={`toggle-track ${value ? "on" : ""} ${disabled ? "locked" : ""}`}
        role="switch"
        aria-checked={value}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && onChange(!value)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onChange(!value);
          }
        }}
      >
        <div class="toggle-thumb" />
      </div>
    </div>
  );
}

function BelloIcon({ size = 28, disabled }: { size?: number; disabled?: boolean }) {
  const outer = disabled ? "#8c959f" : "#0f0f13";
  const eyelid = disabled ? "#d0d7de" : "#f5e050";
  const ink = disabled ? "#57606a" : "#0f0f13";
  return (
    <svg
      class="bello-brand-icon"
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="12" fill={outer} />
      <circle cx="12" cy="12" r="9.5" fill="#ffffff" />
      <path d="M3.923 7 A9.5 9.5 0 0 1 20.077 7 Z" fill={eyelid} />
      <polyline
        points="9.2 8.7 7.4 12 9.2 15.3"
        fill="none"
        stroke={ink}
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <polyline
        points="14.8 8.7 16.6 12 14.8 15.3"
        fill="none"
        stroke={ink}
        stroke-width="1.4"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <circle cx="12" cy="12" r="2.8" fill={ink} />
    </svg>
  );
}

async function getActiveTabInfo(): Promise<{ host?: string; tabId?: number }> {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const url = tab?.url;
      if (!url) return resolve({ tabId: tab?.id });
      try {
        const parsed = new URL(url);
        resolve({ host: parsed.hostname, tabId: tab?.id });
      } catch {
        resolve({ tabId: tab?.id });
      }
    });
  });
}

function desiredHostEntry(args: {
  hostname: string;
  builtin: Platform | null;
  enabled: boolean;
  platform: Platform;
}): HostConfigEntry | null {
  const { hostname, builtin, enabled, platform } = args;
  if (!enabled) {
    if (builtin) return { hostname, platform: builtin, enabled: false };
    return null;
  }
  if (builtin && platform === builtin) return null;
  return { hostname, platform, enabled: true };
}

function PopupApp() {
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const [debugMode, setDebugModeState] = useState(false);
  const [tabId, setTabId] = useState<number | null>(null);
  const [host, setHost] = useState<string | null>(null);

  const [builtin, setBuiltin] = useState<Platform | null>(null);
  const [effectivePlatform, setEffectivePlatform] = useState<Platform | null>(null);
  const [storedEntry, setStoredEntry] = useState<HostConfigEntry | null>(null);

  const [siteEnabled, setSiteEnabled] = useState(false);
  const [sitePlatform, setSitePlatform] = useState<Platform>("github");
  const [savingSite, setSavingSite] = useState(false);

  const [modelConfigured, setModelConfigured] = useState<boolean | null>(null);

  const hasSiteChanges = useMemo(() => {
    if (!host) return false;
    const desired = desiredHostEntry({ hostname: host, builtin, enabled: siteEnabled, platform: sitePlatform });
    const current = storedEntry;
    if (!desired && !current) return false;
    if (!desired || !current) return true;
    return desired.enabled !== current.enabled || desired.platform !== current.platform || desired.hostname !== current.hostname;
  }, [host, builtin, siteEnabled, sitePlatform, storedEntry]);

  useEffect(() => {
    void (async () => {
      const [debug, tabInfo, hostCfg, modelCfg] = await Promise.all([getDebugMode(), getActiveTabInfo(), getHostConfig(), getModelConfig()]);
      setDebugModeState(debug);
      setTabId(tabInfo.tabId ?? null);

      const nextHost = tabInfo.host?.trim().toLowerCase() ?? null;
      setHost(nextHost);
      setModelConfigured(Boolean(modelCfg));

      if (!nextHost) {
        setReady(true);
        return;
      }

      const hostBuiltin = builtinPlatformForHost(nextHost);
      setBuiltin(hostBuiltin);

      const entry = hostCfg.entries.find((e) => e.hostname === nextHost) ?? null;
      setStoredEntry(entry);

      const effective = resolvePlatformForHost(hostCfg, nextHost);
      setEffectivePlatform(effective);

      const enabled = entry ? entry.enabled !== false : Boolean(hostBuiltin);
      setSiteEnabled(enabled);
      setSitePlatform(entry?.platform ?? hostBuiltin ?? "github");

      setReady(true);
    })();
  }, []);

  const saveSite = async () => {
    if (!host) {
      setToast({ kind: "error", text: "No active tab host detected." });
      return;
    }
    setSavingSite(true);
    setToast(null);
    try {
      const cfg = await getHostConfig();
      const desired = desiredHostEntry({ hostname: host, builtin, enabled: siteEnabled, platform: sitePlatform });
      const entries = cfg.entries.filter((e) => e.hostname !== host);
      const nextEntries = desired ? [...entries, desired] : entries;
      await setHostConfig({ entries: nextEntries });

      setStoredEntry(desired);
      setEffectivePlatform(siteEnabled ? (desired?.enabled ? desired.platform : builtin ?? null) : null);

      const msg = siteEnabled
        ? `Saved. Bello is enabled for ${formatPlatform(sitePlatform)} on ${host}.`
        : `Saved. Bello is disabled on ${host}.`;
      setToast({ kind: "success", text: `${msg} Reload the tab to apply.` });
      void trackEvent("host_config_changed", { platform: siteEnabled ? sitePlatform : "disabled" });
    } catch (err) {
      console.error("[bello] Failed to save host config", err);
      setToast({ kind: "error", text: "Failed to save site settings. See extension console." });
    } finally {
      setSavingSite(false);
    }
  };

  const resetSite = async () => {
    if (!host) return;
    setSavingSite(true);
    setToast(null);
    try {
      const cfg = await getHostConfig();
      const nextEntries = cfg.entries.filter((e) => e.hostname !== host);
      await setHostConfig({ entries: nextEntries });

      setStoredEntry(null);
      const nextEffective = builtinPlatformForHost(host);
      setBuiltin(nextEffective);
      setEffectivePlatform(nextEffective);
      setSiteEnabled(Boolean(nextEffective));
      setSitePlatform(nextEffective ?? "github");

      setToast({
        kind: "success",
        text: nextEffective
          ? `Reset. Using default detection (${formatPlatform(nextEffective)}) for ${host}. Reload the tab to apply.`
          : `Reset. ${host} is no longer configured (disabled by default). Reload the tab to apply.`
      });
    } catch (err) {
      console.error("[bello] Failed to reset site config", err);
      setToast({ kind: "error", text: "Failed to reset site settings. See extension console." });
    } finally {
      setSavingSite(false);
    }
  };

  const reloadTab = async () => {
    if (!tabId) return;
    try {
      chrome.tabs.reload(tabId);
    } catch (err) {
      console.warn("[bello] Failed to reload tab", err);
    }
  };

  const onToggleDebug = async (next: boolean) => {
    setDebugModeState(next);
    await setDebugMode(next);
    void logDebug("popup", "info", `debugMode set to ${next}`);
  };

  const ping = async () => {
    await logDebug("popup", "info", "Manual ping from popup");
    setToast({ kind: "info", text: "Sent debug ping." });
  };

  const resetPosition = async () => {
    try {
      await clearSidebarPosition();
      void logDebug("popup", "info", "Sidebar position reset");
      setToast({ kind: "success", text: "Sidebar position reset. Reload the tab to apply." });
    } catch (err) {
      console.error("[bello] Failed to reset sidebar position", err);
      setToast({ kind: "error", text: "Failed to reset sidebar position. See extension console." });
    }
  };

  const clearModels = async () => {
    const ok = confirm("Clear model configuration? You’ll need to reconfigure models in the sidebar.");
    if (!ok) return;
    try {
      await clearModelConfig();
      void logDebug("popup", "info", "Model configuration cleared");
      setModelConfigured(false);
      setToast({ kind: "success", text: "Model configuration cleared." });
    } catch (err) {
      console.error("[bello] Failed to clear model config", err);
      setToast({ kind: "error", text: "Failed to clear model configuration. See extension console." });
    }
  };

  const siteStatusChip = useMemo(() => {
    if (!host) return <span class="bello-chip bad">No active tab</span>;
    if (effectivePlatform) return <span class="bello-chip good">Enabled · {formatPlatform(effectivePlatform)}</span>;
    return <span class="bello-chip bad">Disabled</span>;
  }, [host, effectivePlatform]);

  const showPlatformSelect = Boolean(host) && (siteEnabled || !builtin);
  const platformLocked = Boolean(builtin) && (!storedEntry || storedEntry.platform === builtin);

  const showDebug = __BELLO_DEBUG_BUILD__;

  return (
    <div class="bello-popup">
      <style>{popupStyles}</style>

      <div class="bello-popup-header">
        <div class="bello-brand">
          <BelloIcon disabled={!effectivePlatform} />
          <div class="bello-brand-text">
            <div class="bello-brand-title">Bello</div>
            <div class="bello-brand-subtitle">AI code review side panel</div>
          </div>
        </div>
        {siteStatusChip}
      </div>

      {toast && <div class={`bello-toast ${toast.kind}`}>{toast.text}</div>}

      <div class="bello-card">
        <div class="bello-card-header">This Site</div>
        <div class="bello-card-body">
          {!ready && <div class="bello-muted">Loading…</div>}

          {ready && (
            <>
              <div>
                <div class="bello-field-label">Active host</div>
                <div style="font-weight:600; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <span class="bello-tag">{host ?? "—"}</span>
                  {builtin && <span class="bello-muted">Default: {formatPlatform(builtin)}</span>}
                  {!builtin && <span class="bello-muted">Not configured by default</span>}
                </div>
              </div>

              <Toggle value={siteEnabled} onChange={setSiteEnabled} label="Enable Bello on this host" disabled={!host} />

              {showPlatformSelect && (
                <div>
                  <div class="bello-field-label">Platform</div>
                  <select
                    class="bello-qa-input"
                    value={sitePlatform}
                    disabled={!siteEnabled || platformLocked}
                    onChange={(e) => setSitePlatform((e.currentTarget.value as Platform) ?? "github")}
                  >
                    <option value="github">GitHub</option>
                    <option value="gitlab">GitLab</option>
                  </select>
                  {platformLocked && <div class="bello-hint" style="margin-top:8px;">Platform is auto-detected for this host.</div>}
                </div>
              )}

              <div class="bello-btn-row">
                <button class="bello-btn bello-btn-primary" disabled={!host || savingSite || !hasSiteChanges} onClick={saveSite}>
                  {savingSite ? "Saving…" : "Save"}
                </button>
                <button class="bello-btn bello-btn-secondary" disabled={!host || savingSite || !tabId} onClick={reloadTab}>
                  Reload tab
                </button>
              </div>

              <button class="bello-btn" disabled={!host || savingSite || !storedEntry} onClick={resetSite}>
                Reset this host
              </button>

              {!host && <div class="bello-hint">Open a GitHub/GitLab tab to configure site behavior.</div>}
            </>
          )}
        </div>
      </div>

      <div class="bello-card">
        <div class="bello-card-header">{showDebug ? "Debug & Advanced" : "Advanced"}</div>
        <div class="bello-card-body">
          {showDebug && (
            <>
              <Toggle value={debugMode} onChange={onToggleDebug} label="Debug mode" />
              <div class="bello-hint">Debug mode enables extra logging and the optional debug client.</div>
              <div class="bello-divider" />
              <button class="bello-btn bello-btn-secondary" onClick={ping}>
                Send debug ping
              </button>
              <div class="bello-divider" />
            </>
          )}

          <button class="bello-btn bello-btn-secondary" onClick={resetPosition}>
            Reset sidebar position
          </button>

          <div class="bello-row">
            <div style="min-width:0;">
              <div style="font-weight:600;">Model configuration</div>
              <div class="bello-muted">{modelConfigured === null ? "—" : modelConfigured ? "Configured" : "Not configured"}</div>
            </div>
            <button class="bello-btn bello-btn-danger" disabled={!modelConfigured} onClick={clearModels}>
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

render(<PopupApp />, root);
