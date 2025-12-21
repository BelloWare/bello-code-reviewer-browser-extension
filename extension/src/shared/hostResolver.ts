import type { HostConfig, Platform } from "./storage";

export function builtinPlatformForHost(hostname: string): Platform | null {
  const normalized = normalizeHostname(hostname);
  if (normalized === "github.com" || normalized === "localhost" || normalized === "127.0.0.1") return "github";
  if (normalized === "gitlab.com") return "gitlab";
  return null;
}

export function resolvePlatformForHost(cfg: HostConfig, hostname: string): Platform | null {
  const normalized = normalizeHostname(hostname);
  const entry = cfg.entries.find((e) => e.hostname === normalized);
  if (entry) return entry.enabled ? entry.platform : null;
  return builtinPlatformForHost(normalized);
}

function normalizeHostname(value: string): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  const match = trimmed.match(/^([a-z0-9.-]+):\d+$/);
  return match ? match[1] : trimmed;
}
