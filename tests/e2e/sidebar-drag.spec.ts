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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-drag-"));
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

async function readPosition(page: Page) {
  const pos = await page.evaluate(() => {
    const host = document.querySelector("#bello-sidepanel-host");
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { top: rect.top, right: window.innerWidth - rect.right };
  });
  return pos as { top: number; right: number } | null;
}

async function dragCollapsed(page: Page, dx: number, dy: number) {
  const start = await page.evaluate(() => {
    const host = document.querySelector("#bello-sidepanel-host") as HTMLElement | null;
    const shadow = host?.shadowRoot;
    const pill = shadow?.querySelector(".bello-collapsed") as HTMLElement | null;
    if (!pill) return null;
    const rect = pill.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (!start) throw new Error("collapsed pill not found");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 10 });
  await page.mouse.up();
}

test.describe("Sidebar drag persists position", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("drags the launcher and saves position", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);

      const before = await readPosition(page);
      expect(before).not.toBeNull();

      await dragCollapsed(page, 60, 80);
      await page.waitForTimeout(300);

      const after = await readPosition(page);
      expect(after).not.toBeNull();
      expect(after!.top).not.toBeCloseTo(before!.top, 0);
      expect(after!.right).not.toBeCloseTo(before!.right, 0);

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForSidebar(page);
      const afterReload = await readPosition(page);
      expect(afterReload).not.toBeNull();
      expect(Math.abs(afterReload!.top - after!.top)).toBeLessThan(8);
      expect(Math.abs(afterReload!.right - after!.right)).toBeLessThan(8);
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
