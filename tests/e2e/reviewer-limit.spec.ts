import { chromium, expect, test, Page } from "@playwright/test";
import path from "path";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PR_URL = "https://github.com/AInoob/NooBox/pull/98";
const FIXTURE_HTML = readFileSync(path.resolve(__dirname, "fixtures/pr.html"), "utf8");

function buildExtension() {
  const result = spawnSync("npm", ["--prefix", "extension", "run", "build:debug"], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("Failed to build extension");
  }
}

async function launchContext(extensionPath: string) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-limit-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-crashpad",
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
    ],
    ignoreDefaultArgs: ["--disable-extensions"]
  });
  return { context, userDataDir };
}

async function setupFixtureRoutes(page: Page) {
  await page.route("**/AInoob/NooBox/pull/98**", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
  });
}

async function waitForSidebar(page: Page) {
  await page.waitForFunction(() => document.querySelector("#bello-sidepanel-host"), {}, { timeout: 10000 });
}

async function openConfig(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    shadow?.querySelector(".bello-collapsed")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.textContent?.includes("Configure Model");
  }, {}, { timeout: 8000 });
}

async function countReviewers(page: Page) {
  const count = await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.querySelectorAll(".bello-model-card:not(.arbiter)")?.length ?? 0;
  });
  return count;
}

async function addReviewer(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const addBtn = Array.from(shadow?.querySelectorAll("button") ?? []).find((b) => b.textContent?.includes("+ Add Reviewer")) as HTMLButtonElement | undefined;
    addBtn?.click();
  });
}

test.describe("Reviewer limit enforcement", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("caps reviewers at 5 and shows a limit hint", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);
      await openConfig(page);

      for (let i = await countReviewers(page); i < 5; i++) {
        await addReviewer(page);
        await page.waitForTimeout(100);
      }
      const count = await countReviewers(page);
      expect(count).toBe(5);

      const hint = await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        return shadow?.textContent?.includes("Maximum of 5 reviewers reached.");
      });
      expect(hint).toBeTruthy();

      await addReviewer(page);
      await page.waitForTimeout(200);
      const countAfter = await countReviewers(page);
      expect(countAfter).toBe(5);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
