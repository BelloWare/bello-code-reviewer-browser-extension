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

async function launchContext(extensionPath: string) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-config-"));
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
  await page.route("**/AInoob/NooBox/pull/98.diff", (route) => {
    route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_DIFF });
  });
  await page.route("**/AInoob/NooBox/pull/98**", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
  });
}

async function waitForSidebar(page: Page) {
  await page.waitForFunction(() => document.querySelector("#bello-sidepanel-host"), {}, { timeout: 10000 });
}

async function openLauncher(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const startBtn = shadow?.querySelector(".bello-collapsed") as HTMLElement | null;
    startBtn?.click();
  });
}

async function setBaseUrlAndSave(page: Page, endpoint: string) {
  await page.evaluate((ep) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const inputs = Array.from(shadow?.querySelectorAll('input[placeholder="https://api.example.com/v1"]') ?? []) as HTMLInputElement[];
    inputs.forEach((input) => {
      input.value = ep;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }, endpoint);
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const primary = btns.find((b) => b.textContent?.includes("Check connectivity")) as HTMLButtonElement | undefined;
    primary?.click();
  });

  const handle = await page.waitForFunction(() => {
    const host = document.querySelector("#bello-sidepanel-host") as HTMLElement | null;
    const shadow = host?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const save = btns.find((b) => b.textContent?.includes("Save Configuration"));
    if (save) return "readyToSave";
    if (shadow?.querySelector(".bello-error-card")) return "error";
    return null;
  }, {}, { timeout: 10000 });
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

test.describe("Config navigation respects manual intent", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("Configure Models button stays in config even when already configured", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      console.log("[config-nav] visiting PR page");
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      console.log("[config-nav] page loaded");
      await waitForSidebar(page);
      console.log("[config-nav] sidebar ready");
      await openLauncher(page);
      await page.waitForFunction(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        return shadow?.textContent?.includes("Configure Model");
      }, {}, { timeout: 10000 });

      await setBaseUrlAndSave(page, "mock://ok");
      await page.waitForFunction(() => document.querySelector("#bello-sidepanel-host")?.getAttribute("data-view") === "main", {}, { timeout: 15000 });
      console.log("[config-nav] saved config and reached main");

      await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
        const cfg = btns.find((b) => b.textContent?.includes("Configure Models")) as HTMLButtonElement | undefined;
        cfg?.click();
      });

      await page.waitForFunction(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        return shadow?.textContent?.includes("Configure Model");
      }, {}, { timeout: 10000 });
      await page.waitForTimeout(1000);
      const stillConfig = await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        return shadow?.textContent?.includes("Configure Model");
      });
      expect(stillConfig).toBeTruthy();

      await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
        const cancel = btns.find((b) => b.textContent?.includes("Cancel")) as HTMLButtonElement | undefined;
        cancel?.click();
      });
      await page.waitForFunction(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        return shadow?.textContent?.includes("Run Review");
      }, {}, { timeout: 15000 });
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
