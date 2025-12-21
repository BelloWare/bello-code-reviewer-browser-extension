import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { chromium } from "playwright";

const extensionPath = path.resolve("dist-debug");
const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-debug-profile-"));

async function main() {
  console.log(`[launcher] starting Playwright Chromium with extension from ${extensionPath}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-features=ChromeWhatsNewUI,Translate,ExtensionsMenuAccessControl",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-cloud-import",
      "--disable-component-extensions-with-background-pages",
      "--disable-popup-blocking",
      "--disable-search-engine-choice-screen",
      "--enable-logging=stderr",
      "--v=1"
    ]
  });

  // open a blank page to keep context alive
  if (context.pages().length === 0) {
    await context.newPage();
  }
  const page = context.pages()[0];
  await page.goto("about:blank");

  // Try to surface the extension ID and wake the service worker
  const sw = await context.waitForEvent("serviceworker", { timeout: 10000 }).catch(() => null);
  if (sw) {
    const extId = sw.url().match(/chrome-extension:\/\/([a-p]{32})/i)?.[1];
    console.log(`[launcher] extension service worker detected: ${sw.url()}`);
    if (extId) {
      console.log(`[launcher] extension ID: ${extId}`);
      try {
        await page.goto(`chrome-extension://${extId}/popup.html`);
      } catch (err) {
        console.warn("[launcher] could not open popup to warm extension", err?.message ?? err);
      }
    }
  } else {
    console.warn("[launcher] no extension service worker seen (extension may not have loaded)");
  }

  console.log(`[launcher] Chromium ready with profile ${userDataDir}. Leave this running to keep the extension active.`);
}

main().catch((err) => {
  console.error("[launcher] failed", err);
  process.exit(1);
});
