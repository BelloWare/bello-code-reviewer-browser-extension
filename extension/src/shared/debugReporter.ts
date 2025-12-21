import { getDebugMode } from "./storage";
import { DEBUG_SERVER_TOKEN, DEBUG_SERVER_URL } from "./debugConstants";

export type ExtensionContext = "background" | "content" | "popup" | "options";

let debugPostWarned = false;

async function post(path: string, body: any) {
  try {
    await fetch(`${DEBUG_SERVER_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Token": DEBUG_SERVER_TOKEN
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    if (!debugPostWarned) {
      // Debug server may not be running; warn once to avoid noise.
      console.debug("[bello] debug post failed (server may be offline)", err);
      debugPostWarned = true;
    }
  }
}

export async function logDebug(
  source: ExtensionContext,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
  stack?: string
) {
  if (!__BELLO_DEBUG_BUILD__) return;
  if (!(await getDebugMode())) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    context,
    stack
  };
  try {
    console[level](`[${source}] ${message}`, context ?? "");
  } catch {
    console.log(`[${source}] ${message}`, context ?? "");
  }
  await post("/log", entry);
}

export async function reportError(
  source: ExtensionContext,
  label: string,
  error: unknown,
  extraContext?: Record<string, unknown>
) {
  const err = error instanceof Error ? error : new Error(String(error));
  await logDebug(
    source,
    "error",
    `[${label}] ${err.message}`,
    { ...extraContext, name: err.name },
    err.stack
  );
}
