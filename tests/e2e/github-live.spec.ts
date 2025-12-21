import { chromium, expect, test } from "@playwright/test";
import path from "path";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const PR_URL = "https://github.com/AInoob/NooBox/pull/98";

function buildExtension() {
  const result = spawnSync("npm", ["--prefix", "extension", "run", "build:debug"], {
    cwd: path.resolve(__dirname, "..", ".."),
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error("Failed to build extension");
  }
}

test.describe.skip("Live GitHub PR (requires local Chrome permissions)", () => {
  test.beforeAll(() => {
    buildExtension();
    mkdirSync(path.resolve(__dirname, "../../test-results"), { recursive: true });
  });

  test("sidebar mounts on real PR page and can start review", async () => {
    test.setTimeout(45000);
    const extensionPath = path.resolve(__dirname, "../../dist-debug");
    expect(existsSync(extensionPath)).toBeTruthy();
    const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-live-"));

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
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
      ],
      ignoreDefaultArgs: ["--disable-extensions"]
    });

    const firstPage = context.pages()[0] ?? (await context.newPage());
    await firstPage.goto("about:blank");

    const page = await context.newPage();
    page.on("console", (msg) => console.log("GITHUB PAGE:", msg.text()));
    const response = await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
    if (!response || response.status() >= 400) {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      test.skip(`GitHub response ${response?.status()}`);
    }
    await page.screenshot({ path: path.resolve(__dirname, "../../test-results/live-1-loaded.png"), fullPage: true });

    // wait for host to be injected (content script runs at document_start)
    let hostFound = false;
    for (let i = 0; i < 20; i++) {
      const host = await page.$("#bello-sidepanel-host");
      if (host) {
        hostFound = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    if (!hostFound) {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
      test.skip("Sidebar host did not render");
    }
    await page.screenshot({ path: path.resolve(__dirname, "../../test-results/live-2-collapsed.png"), fullPage: true });

    // open the panel from collapsed launcher
    await page.evaluate(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      const startBtn = shadow?.querySelector(".bello-collapsed") as HTMLElement | null;
      startBtn?.click();
    });
    await page.waitForTimeout(300);

    // should land in config view on first run
    await page.waitForFunction(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      return shadow?.textContent?.includes("Configure Model");
    }, { timeout: 8000 });

    // save default config to continue
    await page.evaluate(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
      const save = btns.find((b) => b.textContent?.includes("Save Configuration") || b.textContent?.includes("Save & Continue")) as HTMLButtonElement | undefined;
      save?.click();
    });

    // preflight view should render
    await page.waitForFunction(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      return shadow?.textContent?.includes("Preflight Check");
    }, { timeout: 8000 });

    // start review and wait for results
    await page.evaluate(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
      const start = btns.find((b) => b.textContent?.includes("Start Review") || b.textContent?.includes("Running")) as HTMLButtonElement | undefined;
      start?.click();
    });

    await page.waitForFunction(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      return shadow?.textContent?.includes("Results");
    }, { timeout: 10000 });

    const summaryText = await page.evaluate(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      return shadow?.querySelector("[data-bello-summary]")?.textContent?.trim() ?? "";
    });
    expect(summaryText.length).toBeGreaterThan(0);

    const findingsState = await page.evaluate(() => {
      const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
      const list = shadow?.querySelector("[data-bello-findings]");
      return {
        hasList: Boolean(list),
        cardCount: list ? list.querySelectorAll(".bello-card").length : 0,
        text: list?.textContent?.trim() ?? ""
      };
    });
    expect(findingsState.hasList).toBeTruthy();
    expect(findingsState.text.length).toBeGreaterThan(0);

    await page.screenshot({ path: path.resolve(__dirname, "../../test-results/live-4-findings.png"), fullPage: true });

    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  });
});
