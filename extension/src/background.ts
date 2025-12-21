import { setDebugMode } from "./shared/storage";
import { logDebug, reportError } from "./shared/debugReporter";
import { handleMessage } from "./background/reviewEngine";
import { initReviewNotifications, showReviewCompleteNotification } from "./background/reviewNotifications";
import type { SidecarMessage } from "./types";

chrome.runtime.onInstalled.addListener(async () => {
  await setDebugMode(false);
  await logDebug("background", "info", "Installed prod background");
});

self.addEventListener("error", (event) => {
  void reportError("background", "worker-error", event.error ?? event.message);
});

self.addEventListener("unhandledrejection", (event) => {
  void reportError("background", "worker-unhandledrejection", event.reason);
});

chrome.runtime.onMessage.addListener((message: SidecarMessage, sender, sendResponse) => {
  handleMessage(message)
    .then((res) => {
      if (message.type === "RUN_REVIEW" && res.type === "REVIEW_DONE") {
        void showReviewCompleteNotification(message.payload.pr, sender.tab?.id);
      }
      sendResponse(res);
    })
    .catch((err) => sendResponse({ type: "ERROR", error: (err as Error).message }));
  return true;
});

initReviewNotifications();
