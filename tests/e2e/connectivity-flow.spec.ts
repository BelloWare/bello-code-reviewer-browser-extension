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
    shadow?.querySelector(".bello-collapsed")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.textContent?.includes("Configure Model");
  }, {}, { timeout: 8000 });
}

async function setupFixtureRoutes(page: Page) {
  await page.route("**/AInoob/NooBox/pull/98.diff", (route) => {
    route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_DIFF });
  });
  await page.route("**/AInoob/NooBox/pull/98**", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
  });
}

async function setModelAndEndpoint(page: Page, modelId: string, endpoint: string) {
  await page.evaluate(({ modelId, endpoint }) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const modelInput = shadow?.querySelector('.bello-model-card:not(.arbiter) input[placeholder="e.g. openai/gpt-5-mini"]') as HTMLInputElement | null;
    const baseInput = shadow?.querySelector('.bello-model-card:not(.arbiter) input[placeholder="https://api.example.com/v1"]') as HTMLInputElement | null;
    if (modelInput) {
      modelInput.value = "";
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
      modelInput.value = modelId;
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (baseInput) {
      baseInput.value = endpoint;
      baseInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { modelId, endpoint });
}

async function getPrimaryButtonText(page: Page) {
  const handle = await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const primary = btns.find((b) => b.textContent?.includes("Save Configuration") || b.textContent?.includes("Check connectivity"));
    return primary?.textContent?.trim() ?? null;
  }, {}, { timeout: 5000 });
  return (await handle.jsonValue()) as string | null;
}

async function clickPrimary(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const primary = btns.find((b) => b.textContent?.includes("Save Configuration") || b.textContent?.includes("Check connectivity"));
    (primary as HTMLButtonElement | undefined)?.click();
  });
}

async function openConfigureModels(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const cfg = btns.find((b) => b.textContent?.includes("Configure Models")) as HTMLButtonElement | undefined;
    cfg?.click();
  });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.textContent?.includes("Configure Model");
  }, {}, { timeout: 8000 });
}

async function launchContext(extensionPath: string) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-connectivity-"));
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

test.describe("Model connectivity check flow", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("requires connectivity after edits and returns to main after save", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);
      await openConfig(page);

      await setModelAndEndpoint(page, "openai/gpt-5.1-codex-mini", "mock://ok");

      await page.waitForFunction(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const btn = Array.from(shadow?.querySelectorAll("button") ?? []).find((b) => b.textContent?.includes("Check connectivity"));
        return Boolean(btn);
      }, {}, { timeout: 5000 });

      await clickPrimary(page);

      await page.waitForFunction(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const btn = Array.from(shadow?.querySelectorAll("button") ?? []).find((b) => b.textContent?.includes("Save Configuration"));
        return Boolean(btn);
      }, {}, { timeout: 10000 });

      await clickPrimary(page);

      await page.waitForFunction(() => {
        const host = document.querySelector("#bello-sidepanel-host");
        return host?.getAttribute("data-view") === "main";
      }, {}, { timeout: 8000 });

      await openConfigureModels(page);
      const finalButton = await getPrimaryButtonText(page);
      expect(finalButton).toContain("Save Configuration");
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
