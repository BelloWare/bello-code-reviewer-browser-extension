import { getClientId, getDebugMode, setDebugMode } from "./storage";
import { logDebug } from "./debugReporter";
import { attachToTab, detachFromTab, evalInTab } from "./debuggerBridge";

import { DEBUG_SERVER_TOKEN, DEBUG_SERVER_URL } from "./debugConstants";
const POLL_INTERVAL_MS = 8000;
const HEARTBEAT_INTERVAL_MS = 15000;

async function postResult(result: any) {
  await fetch(`${DEBUG_SERVER_URL}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Token": DEBUG_SERVER_TOKEN },
    body: JSON.stringify(result)
  });
}

async function fetchCommand(clientId: string) {
  const res = await fetch(`${DEBUG_SERVER_URL}/command?clientId=${encodeURIComponent(clientId)}`, {
    headers: { "X-Debug-Token": DEBUG_SERVER_TOKEN }
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.command ?? null;
}

async function sendHeartbeat(clientId: string) {
  if (!(await getDebugMode())) return;
  await fetch(`${DEBUG_SERVER_URL}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Token": DEBUG_SERVER_TOKEN },
    body: JSON.stringify({
      clientId,
      extensionVersion: chrome.runtime.getManifest().version,
      debugFlags: ["debugMode"]
    })
  }).catch((err) => {
    // Intentional: heartbeat is best-effort; server may be offline.
    console.debug("[bello] debug heartbeat failed", err);
  });
}

async function showTestNotification(payload: any) {
  return new Promise<void>((resolve) => {
    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "Bello Debug",
      message: String(payload?.message ?? "Test notification")
    }, () => resolve());
  });
}

async function evalInTabCommand(payload: any) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  await attachToTab(tab.id);
  try {
    const expression = String(payload?.expression ?? "window.location.href");
    return await evalInTab(tab.id, expression);
  } finally {
    await detachFromTab(tab.id);
  }
}

async function openTestPage(payload: any) {
  const url = payload?.url ?? "https://example.com";
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id, url };
}

async function handleCommand(command: any, clientId: string) {
  const { commandId, type, payload, correlationId } = command;
  try {
    let parsed: any = null;
    let summary = "";

    switch (type) {
      case "reloadExtension":
        summary = "Extension reloaded";
        chrome.runtime.reload();
        break;
      case "testNotification":
        summary = "Notification shown";
        await showTestNotification(payload);
        break;
      case "evalInTab": {
        const res = await evalInTabCommand(payload);
        parsed = res;
        summary = "evalInTab executed";
        break;
      }
      case "openTestPage": {
        const info = await openTestPage(payload);
        parsed = info;
        summary = "Test page opened";
        break;
      }
      default:
        summary = `Unknown command type: ${type}`;
        await postResult({
          commandId,
          clientId,
          status: "error",
          summary,
          error: { message: summary },
          correlationId
        });
        return;
    }

    await postResult({
      commandId,
      clientId,
      status: "ok",
      summary,
      parsed,
      correlationId
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    await logDebug("background", "error", `Command ${commandId} failed: ${e.message}`, {}, e.stack);
    await postResult({
      commandId,
      clientId,
      status: "error",
      summary: `Command failed: ${e.message}`,
      error: { message: e.message, stack: e.stack },
      correlationId
    });
  }
}

export async function startDebugClient() {
  if (!__BELLO_DEBUG_BUILD__) return;
  const enabled = await getDebugMode();
  if (!enabled) {
    await setDebugMode(true);
  }
  const clientId = await getClientId();
  await logDebug("background", "info", `Debug client started: ${clientId}`);

  // send an immediate heartbeat
  void sendHeartbeat(clientId);
  setInterval(() => {
    void sendHeartbeat(clientId);
  }, HEARTBEAT_INTERVAL_MS);

  const poll = async () => {
    try {
      const command = await fetchCommand(clientId);
      if (command) await handleCommand(command, clientId);
    } catch (err) {
      await logDebug("background", "error", "Command polling error", { err: String(err) });
    }
  };
  setInterval(poll, POLL_INTERVAL_MS);

  (globalThis as any).debugTick = poll;
  (globalThis as any).debugHeartbeat = () => sendHeartbeat(clientId);
}
