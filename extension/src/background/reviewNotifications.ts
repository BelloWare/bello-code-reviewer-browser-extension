import type { ReviewPrMeta } from "../types";

const NOTIFICATION_PREFIX = "bello-review";
const NOTIFICATION_ICON = chrome.runtime.getURL("icons/icon48.png");

const encodePart = (value: string) => encodeURIComponent(value);
const decodePart = (value: string) => decodeURIComponent(value);

const buildReviewUrl = (pr: ReviewPrMeta): string => {
  const base = (pr.origin || `https://${pr.host}`).replace(/\/+$/, "");
  if (pr.platform === "gitlab") {
    return `${base}/${pr.repo}/-/merge_requests/${pr.number}`;
  }
  return `${base}/${pr.repo}/pull/${pr.number}`;
};

const buildNotificationId = (pr: ReviewPrMeta, tabId?: number): string => {
  return [
    NOTIFICATION_PREFIX,
    pr.platform,
    encodePart(pr.origin),
    encodePart(pr.host),
    encodePart(pr.repo),
    String(pr.number),
    tabId !== undefined ? String(tabId) : ""
  ].join("|");
};

const parseNotificationId = (id: string): { pr: ReviewPrMeta; tabId?: number } | null => {
  if (!id.startsWith(`${NOTIFICATION_PREFIX}|`)) return null;
  const parts = id.split("|");
  if (parts.length < 7) return null;
  const platform = parts[1] === "gitlab" ? "gitlab" : "github";
  const origin = decodePart(parts[2] ?? "");
  const host = decodePart(parts[3] ?? "");
  const repo = decodePart(parts[4] ?? "");
  const number = Number(parts[5]);
  const tabIdRaw = parts[6];
  const tabId = tabIdRaw ? Number(tabIdRaw) : undefined;
  if (!origin || !host || !repo || !Number.isFinite(number)) return null;
  return {
    pr: {
      platform,
      host,
      origin,
      repo,
      number
    },
    tabId: Number.isFinite(tabId) ? tabId : undefined
  };
};

const focusTab = async (tabId: number): Promise<boolean> => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return false;
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return true;
  } catch {
    return false;
  }
};

export const initReviewNotifications = (): void => {
  if ((globalThis as any).__belloReviewNotificationsInit) return;
  (globalThis as any).__belloReviewNotificationsInit = true;
  chrome.notifications.onClicked.addListener((id) => {
    const meta = parseNotificationId(id);
    if (!meta) return;
    void (async () => {
      const url = buildReviewUrl(meta.pr);
      const focused = meta.tabId !== undefined ? await focusTab(meta.tabId) : false;
      if (!focused) {
        await chrome.tabs.create({ url });
      }
      void chrome.notifications.clear(id);
    })();
  });
};

export const showReviewCompleteNotification = async (pr: ReviewPrMeta, tabId?: number): Promise<void> => {
  const id = buildNotificationId(pr, tabId);
  const title = "Bello review complete";
  const message = `${pr.repo} #${pr.number} is ready. Click to return to the PR.`;
  await new Promise<void>((resolve) => {
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: NOTIFICATION_ICON,
        title,
        message,
        requireInteraction: true
      },
      () => resolve()
    );
  });
};
