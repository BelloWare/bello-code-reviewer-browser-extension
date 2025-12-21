import { chromium, expect, test, Page } from "@playwright/test";
import path from "path";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PR_URL = "https://github.com/AInoob/NooBox/pull/98";
const FIXTURE_HTML = readFileSync(path.resolve(__dirname, "fixtures/pr.html"), "utf8");
const FIXTURE_DIFF = readFileSync(path.resolve(__dirname, "fixtures/pr.diff"), "utf8");

function buildExtension() {
  const result = spawnSync("npm", ["--prefix", "extension", "run", "build:debug"], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("Failed to build extension");
  }
}

async function waitForSidebar(page: Page) {
  await page.waitForFunction(() => document.querySelector("#bello-sidepanel-host"), {}, { timeout: 10000 });
}

async function openConfig(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const startBtn = shadow?.querySelector(".bello-collapsed") as HTMLElement | null;
    startBtn?.click();
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.textContent?.includes("Configure Model");
  }, {}, { timeout: 8000 });
}

async function setBaseUrlAndSave(page: Page, endpoint: string) {
  const values = await page.evaluate((ep) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const inputs = Array.from(shadow?.querySelectorAll('input[placeholder="https://api.example.com/v1"]') ?? []) as HTMLInputElement[];
    const current: string[] = [];
    inputs.forEach((input) => {
      input.value = ep;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      current.push(input.value);
    });
    return current;
  }, endpoint);
  console.log("[review-error] base urls set to", values);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const btn = btns.find((b) => b.textContent?.includes("Check connectivity")) as HTMLButtonElement | undefined;
    btn?.click();
  });

  const handle = await page.waitForFunction(() => {
    const host = document.querySelector("#bello-sidepanel-host") as HTMLElement | null;
    const shadow = host?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const save = btns.find((b) => b.textContent?.includes("Save Configuration"));
    if (save) return "readyToSave";
    if (shadow?.querySelector(".bello-test-status.failed")) return "error";
    return null;
  }, {}, { timeout: 15000 });

  const state = (await handle.jsonValue()) as string | null;
  if (state !== "readyToSave") return state;

  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const save = btns.find((b) => b.textContent?.includes("Save Configuration")) as HTMLButtonElement | undefined;
    save?.click();
  });
  await page.waitForFunction(
    () => document.querySelector("#bello-sidepanel-host")?.getAttribute("data-view") === "main",
    {},
    { timeout: 15000 }
  );
  return "saved";
}

async function startReview(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const start = btns.find((b) => b.textContent?.includes("Run Review")) as HTMLButtonElement | undefined;
    start?.click();
  });
}

async function waitForErrorBanner(page: Page) {
  const textHandle = await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const banner = shadow?.querySelector(".bello-test-status.failed");
    return banner?.textContent?.trim() || null;
  }, {}, { timeout: 15000 });
  return (await textHandle.jsonValue()) as string;
}

async function waitForSummary(page: Page) {
  const summaryHandle = await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const node = shadow?.querySelector("[data-bello-summary]");
    const text = node?.textContent?.trim() ?? "";
    return text.length ? text : null;
  }, {}, { timeout: 15000 });
  return (await summaryHandle.jsonValue()) as string;
}

async function launchContext(extensionPath: string) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-state-"));
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
  const context = page.context();
  await context.route("**/AInoob/NooBox/pull/98.diff", (route) => {
    route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_DIFF });
  });
  await context.route("**/AInoob/NooBox/pull/98**", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
  });
}

test.describe("LLM failure and success paths", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("surfaces an error when the reviewer endpoint is unreachable", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);
      await openConfig(page);
      const state = await setBaseUrlAndSave(page, "mock://fail");
      console.log("[review-error] connectivity state for mock fail", state);
      const errText = await waitForErrorBanner(page);
      expect(errText.toLowerCase()).toContain("model");
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("renders summary and findings when the reviewer endpoint responds", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);
      await openConfig(page);
      await setBaseUrlAndSave(page, "mock://ok");
      await startReview(page);
      const summary = await waitForSummary(page);
      expect(summary.length).toBeGreaterThan(0);
      const findingsState = await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const count = shadow?.querySelectorAll(".bello-finding-item")?.length ?? 0;
        const text = shadow?.querySelector(".bello-finding-group")?.textContent?.toLowerCase() ?? "";
        return { count, noIssues: text.includes("no issues found") };
      });
      expect(findingsState.count > 0 || findingsState.noIssues).toBeTruthy();
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
