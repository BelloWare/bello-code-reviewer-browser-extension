import type { ReviewFile, ReviewPrMeta } from "../types";
import type { Platform } from "../shared/storage";
import { getHostConfig } from "../shared/storage";
import { resolvePlatformForHost } from "../shared/hostResolver";

export function detectGithubPrMeta(): ReviewPrMeta | null {
  const match = window.location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  const branch = document.querySelector<HTMLSpanElement>("span.commit-ref")?.innerText.trim() ?? "unknown";
  return {
    platform: "github",
    host: window.location.hostname,
    origin: window.location.origin,
    repo: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
    branch
  };
}

export function detectGitlabMrMeta(): ReviewPrMeta | null {
  const match = window.location.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)/);
  if (!match) return null;
  const branchNode =
    (document.querySelector<HTMLElement>('[data-qa-selector="source-branch"]') as HTMLElement | null) ??
    (document.querySelector<HTMLElement>('[data-testid="source-branch"]') as HTMLElement | null);
  const branch = branchNode?.textContent?.trim() ?? "unknown";
  return {
    platform: "gitlab",
    host: window.location.hostname,
    origin: window.location.origin,
    repo: match[1],
    number: Number(match[2]),
    branch
  };
}

export async function getCurrentPlatform(): Promise<Platform | null> {
  const hostConfig = await getHostConfig();
  return resolvePlatformForHost(hostConfig, window.location.hostname);
}

export async function detectCurrentPrMeta(): Promise<ReviewPrMeta | null> {
  const platform = await getCurrentPlatform();
  if (!platform) {
    console.log("[bello] detectCurrentPrMeta: no platform configured for host", window.location.hostname);
    return null;
  }
  if (platform === "github") {
    const meta = detectGithubPrMeta();
    if (!meta) console.log("[bello] detectCurrentPrMeta: platform github but path not a PR", window.location.pathname);
    else console.log("[bello] detectCurrentPrMeta: github PR detected", meta);
    return meta;
  }
  if (platform === "gitlab") {
    const meta = detectGitlabMrMeta();
    if (!meta) console.log("[bello] detectCurrentPrMeta: platform gitlab but path not an MR", window.location.pathname);
    else console.log("[bello] detectCurrentPrMeta: gitlab MR detected", meta);
    return meta;
  }
  console.log("[bello] detectCurrentPrMeta: unsupported platform", platform);
  return null;
}

export function collectDiff(doc: Document = document): ReviewFile[] {
  const fileNodes = Array.from(doc.querySelectorAll<HTMLElement>("[data-path], .js-file"));

  return fileNodes
    .map((node) => {
      const path = node.getAttribute("data-path");
      if (!path) return null;
      const { hunks, addedLines, removedLines, sizeBytes } = extractHunks(node);
      return {
        path,
        language: guessLanguage(path),
        sizeBytes,
        addedLines,
        removedLines,
        hunks
      };
    })
    .filter(Boolean) as ReviewFile[];
}

function extractHunks(
  node: HTMLElement
): { hunks: ReviewFile["hunks"]; addedLines: number; removedLines: number; sizeBytes: number } {
  const hunks: ReviewFile["hunks"] = [];
  let addedLines = 0;
  let removedLines = 0;
  let sizeBytes = 0;

  const rows = Array.from(node.querySelectorAll("tr"));
  rows.forEach((row) => {
    const lineCell = row.querySelector<HTMLElement>(
      "td.blob-num-addition, td.blob-num-deletion, td.blob-num-context, td.blob-num-modified"
    );
    const codeCell = row.querySelector<HTMLElement>("td.blob-code");
    if (!lineCell || !codeCell) return;
    const newLineNumber = Number(lineCell.getAttribute("data-line-number") ?? lineCell.textContent ?? "0");
    const oldLineNumberAttr = lineCell.getAttribute("data-line-number-old");
    const oldLineNumber = oldLineNumberAttr ? Number(oldLineNumberAttr) : newLineNumber;
    const code = codeCell.innerText ?? "";
    if (code.trim().length === 0) return;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    if (lineCell.classList.contains("blob-num-addition")) {
      addedLines += 1;
      newLines.push(code);
    } else if (lineCell.classList.contains("blob-num-deletion")) {
      removedLines += 1;
      oldLines.push(code);
    } else {
      newLines.push(code);
      oldLines.push(code);
    }
    sizeBytes += code.length;
    hunks.push({
      startLineOld: oldLineNumber,
      startLineNew: newLineNumber,
      oldLines,
      newLines
    });
  });

  if (hunks.length === 0) {
    const blocks = Array.from(node.querySelectorAll<HTMLElement>("pre"));
    blocks.forEach((block, idx) => {
      const lines = block.innerText.split("\n").length;
      const payload = block.innerText.split("\n");
      hunks.push({
        startLineOld: idx * 100,
        startLineNew: idx * 100,
        oldLines: payload,
        newLines: payload
      });
      addedLines += lines;
      sizeBytes += block.innerText.length;
    });
  }

  return { hunks: mergeHunks(hunks), addedLines, removedLines, sizeBytes };
}

function mergeHunks(hunks: ReviewFile["hunks"]) {
  const sorted = [...hunks].sort((a, b) => a.startLineNew - b.startLineNew);
  const merged: typeof hunks = [];
  sorted.forEach((h) => {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.startLineNew + last.newLines.length >= h.startLineNew - 1 &&
      last.startLineOld + last.oldLines.length >= h.startLineOld - 1
    ) {
      last.newLines = [...last.newLines, ...h.newLines];
      last.oldLines = [...last.oldLines, ...h.oldLines];
    } else {
      merged.push({ ...h });
    }
  });
  return merged;
}

function guessLanguage(path: string): string | undefined {
  const ext = path.split(".").pop();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    java: "java",
    cs: "csharp"
  };
  return map[ext];
}
