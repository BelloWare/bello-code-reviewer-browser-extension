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
  const userDataDir = mkdtempSync(path.join(tmpdir(), "bello-playwright-ensemble-"));
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

async function addReviewerCard(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const addBtn = btns.find((b) => b.textContent?.includes("+ Add Reviewer")) as HTMLButtonElement | undefined;
    addBtn?.click();
  });
}

async function setReviewerBaseUrls(page: Page, endpoint: string) {
  await page.evaluate((ep) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const inputs = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="https://api.example.com/v1"]') ?? []) as HTMLInputElement[];
    inputs.forEach((input) => {
      input.value = ep;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }, endpoint);
}

async function setReviewerBaseUrlAt(page: Page, index: number, endpoint: string) {
  await page.evaluate(({ idx, endpoint }) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const inputs = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="https://api.example.com/v1"]') ?? []) as HTMLInputElement[];
    const input = inputs[idx];
    if (input) {
      input.value = endpoint;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { idx: index, endpoint });
}

async function setReviewerModels(page: Page, modelIds: string[]) {
  await page.evaluate((ids) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const inputs = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="e.g. openai/gpt-5-mini"]') ?? []) as HTMLInputElement[];
    inputs.forEach((input, idx) => {
      const nextVal = ids[idx] ?? input.value;
      input.value = nextVal;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }, modelIds);
}

async function waitForReviewerCount(page: Page, expected: number) {
  await page.waitForFunction((count) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const cards = shadow?.querySelectorAll(".bello-model-card:not(.arbiter)") ?? [];
    return cards.length === count;
  }, expected, { timeout: 15000 });
}

async function getReviewerCount(page: Page) {
  const handle = await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return shadow?.querySelectorAll(".bello-model-card:not(.arbiter)")?.length ?? 0;
  });
  return handle;
}

async function getSelectedMode(page: Page) {
  const modeHandle = await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const node = shadow?.querySelector(".mode-display-card .mode-title");
    return node?.textContent?.trim() ?? null;
  }, {}, { timeout: 5000 });
  return (await modeHandle.jsonValue()) as string | null;
}

async function isConsolidationOn(page: Page) {
  const handle = await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const track = shadow?.querySelector(".bello-arbiter-section .toggle-track");
    return track?.classList.contains("on") ?? false;
  }, { timeout: 5000 });
  return (await handle.jsonValue()) as boolean;
}

async function clickConsolidationToggle(page: Page) {
  await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const track = shadow?.querySelector(".bello-arbiter-section .toggle-track") as HTMLElement | null;
    track?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function selectCustomArbiter(page: Page, modelId: string, endpoint: string) {
  await page.evaluate(({ modelId, endpoint }) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const radios = shadow?.querySelectorAll('input[name="arbiter-choice"]');
    const customRadio = radios?.[1] as HTMLInputElement | undefined;
    customRadio?.click();
  }, { modelId, endpoint });
  await page.waitForFunction(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    return Boolean(shadow?.querySelector('.bello-model-card.arbiter input[placeholder="e.g. openai/gpt-5-mini"]'));
  }, { timeout: 5000 });
  await page.evaluate(({ modelId, endpoint }) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const arbiterCard = shadow?.querySelector(".bello-model-card.arbiter");
    const modelInput = arbiterCard?.querySelector('input[placeholder="e.g. openai/gpt-5-mini"]') as HTMLInputElement | null;
    if (modelInput) {
      modelInput.value = modelId;
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const baseInput = arbiterCard?.querySelector('input[placeholder="https://api.example.com/v1"]') as HTMLInputElement | null;
    if (baseInput) {
      baseInput.value = endpoint;
      baseInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, { modelId, endpoint });
}

async function saveConfig(page: Page) {
  const preClick = await page.evaluate(() => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
    const primary = (btns.find((b) => b.textContent?.includes("Check connectivity")) ??
      btns.find((b) => b.textContent?.includes("Save Configuration"))) as HTMLButtonElement | undefined;
    const disabled = Boolean(primary?.disabled);
    const view = document.querySelector("#bello-sidepanel-host")?.getAttribute("data-view");
    const models = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="e.g. openai/gpt-5-mini"]') ?? []).map(
      (el) => (el as HTMLInputElement).value
    );
    const bases = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="https://api.example.com/v1"]') ?? []).map(
      (el) => (el as HTMLInputElement).value
    );
    primary?.click();
    const errorText = shadow?.querySelector(".bello-error-card")?.textContent ?? "";
    return { disabled, view, errorText, models, bases, primaryText: primary?.textContent ?? "" };
  });
  console.log("[model-config] save clicked", preClick);
  await page.waitForTimeout(300);
  const handle = await page
    .waitForFunction(() => {
      const host = document.querySelector("#bello-sidepanel-host");
      const shadow = host?.shadowRoot;
      const btns = Array.from(shadow?.querySelectorAll("button") ?? []);
      const save = btns.find((b) => b.textContent?.includes("Save Configuration"));
      if (save) return "readyToSave";
      if (shadow?.querySelector(".bello-error-card")) return "error";
      return null;
    }, {}, { timeout: 15000 })
    .catch(() => null);
  if (!handle) {
    const snapshot = await page.evaluate(() => {
      const host = document.querySelector("#bello-sidepanel-host");
      const shadow = host?.shadowRoot;
      return {
        view: host?.getAttribute("data-view"),
        errorCard: shadow?.querySelector(".bello-error-card")?.textContent ?? null
      };
    });
    console.log("[model-config] save wait timeout", snapshot);
    return "timeout";
  }
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

async function removeReviewerAt(page: Page, index: number) {
  await page.evaluate((idx) => {
    const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
    const cards = Array.from(shadow?.querySelectorAll(".bello-model-card:not(.arbiter)") ?? []);
    const card = cards[idx] as HTMLElement | undefined;
    const btn = card?.querySelector(".bello-icon-btn.delete") as HTMLButtonElement | null;
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, index);
}

async function setupFixtureRoutes(page: Page) {
  await page.route("**/AInoob/NooBox/pull/98.diff", (route) => {
    route.fulfill({ status: 200, contentType: "text/plain", body: FIXTURE_DIFF });
  });
  await page.route("**/AInoob/NooBox/pull/98**", (route) => {
    route.fulfill({ status: 200, contentType: "text/html", body: FIXTURE_HTML });
  });
}

test.describe("Model configuration ensembles", () => {
  const extensionPath = path.resolve(__dirname, "../../dist-debug");

  test.beforeAll(() => {
    buildExtension();
  });

  test("enforces consolidation for ensembles and allows reviewer removal", async () => {
    const { context, userDataDir } = await launchContext(extensionPath);
    try {
      const page = await context.newPage();
      await setupFixtureRoutes(page);
      await page.goto(PR_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForSidebar(page);
      await openConfig(page);
      console.log("[model-config] opened config");
      await page.waitForTimeout(500);

      await addReviewerCard(page);
      await waitForReviewerCount(page, 2);
      await setReviewerBaseUrls(page, "mock://ok");
      await setReviewerBaseUrlAt(page, 1, "mock://ok");
      await setReviewerModels(page, ["openai/gpt-5.1-codex-mini", "openai/gpt-5-mini"]);
      const precheck = await page.evaluate(() => {
        const shadow = document.querySelector("#bello-sidepanel-host")?.shadowRoot;
        const models = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="e.g. openai/gpt-5-mini"]') ?? []).map(
          (el) => (el as HTMLInputElement).value
        );
        const bases = Array.from(shadow?.querySelectorAll('.bello-model-card:not(.arbiter) input[placeholder="https://api.example.com/v1"]') ?? []).map(
          (el) => (el as HTMLInputElement).value
        );
        return { models, bases };
      });
      console.log("[model-config] models/bases before save", precheck);
      console.log("[model-config] added second reviewer");

      const selectedMode = await getSelectedMode(page);
      expect(selectedMode?.toLowerCase()).toContain("ensemble");
      console.log("[model-config] ensemble auto-selected");

      await clickConsolidationToggle(page);
      expect(await isConsolidationOn(page)).toBeTruthy();
      console.log("[model-config] consolidation on");

      await selectCustomArbiter(page, "openai/gpt-5-mini", "mock://ok");
      console.log("[model-config] custom arbiter filled");
      await page.waitForTimeout(200);
      const firstSave = await saveConfig(page);
      expect(firstSave).toBe("saved");
      console.log("[model-config] saved ensemble config");

      await openConfigureModels(page);
      console.log("[model-config] reopened config");
      let count = await getReviewerCount(page);
      if (count < 2) {
        await addReviewerCard(page);
        await waitForReviewerCount(page, 2);
        await setReviewerBaseUrlAt(page, 1, "mock://ok");
        await setReviewerModels(page, ["openai/gpt-5.1-codex-mini", "openai/gpt-5-mini"]);
        count = await getReviewerCount(page);
        console.log("[model-config] replenished second reviewer", count);
      } else {
        await waitForReviewerCount(page, 2);
      }
      await removeReviewerAt(page, 1);
      await waitForReviewerCount(page, 1);
      console.log("[model-config] removed duplicate reviewer");
      const modeAfterRemoval = await getSelectedMode(page);
      expect(modeAfterRemoval?.toLowerCase()).toContain("single");
      console.log("[model-config] removed extra reviewer");
      return;
    } finally {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
