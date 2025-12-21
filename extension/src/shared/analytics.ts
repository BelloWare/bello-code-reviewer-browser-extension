type AnalyticsParams = Record<string, string | number | boolean>;

let warned = false;

const sanitizeParams = (params?: Record<string, unknown>): AnalyticsParams => {
  const safe: AnalyticsParams = {};
  if (!params) return safe;
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = typeof value === "string" ? value.slice(0, 100) : value;
    }
  });
  return safe;
};

export async function trackEvent(name: string, params?: Record<string, unknown>): Promise<void> {
  const eventName = typeof name === "string" ? name.trim() : "";
  if (!eventName || !chrome?.runtime?.id) return;
  const payload = { name: eventName, params: sanitizeParams(params) };
  try {
    await new Promise<void>((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "TRACK_EVENT", payload }, () => resolve());
      } catch {
        resolve();
      }
    });
  } catch (err) {
    if (!warned) {
      console.debug("[bello] analytics sendMessage error", err);
      warned = true;
    }
  }
}
