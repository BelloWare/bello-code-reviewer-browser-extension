import type { ReviewFile, ReviewPolicy, ReviewRequest } from "../types";
import { filterFilesForReview } from "../lib/fileFilter";

type PrMeta = ReviewRequest["pr"];

export async function fetchGitHubDiff(pr: PrMeta): Promise<string> {
  const [owner, repo] = pr.repo.split("/");
  const base = pr.origin || `https://${pr.host || "github.com"}`;
  const url = `${base}/${owner}/${repo}/pull/${pr.number}.diff`;
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) {
    throw new Error(`Failed to fetch diff: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

export async function fetchGitLabDiff(pr: PrMeta): Promise<string> {
  const base = pr.origin || `https://${pr.host}`;
  const url = `${base}/${pr.repo}/-/merge_requests/${pr.number}.diff`;
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) {
    throw new Error(`GitLab diff fetch failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

async function fetchDiffForPlatform(pr: PrMeta): Promise<string> {
  if (pr.platform === "github") return fetchGitHubDiff(pr);
  if (pr.platform === "gitlab") return fetchGitLabDiff(pr);
  throw new Error(`Unsupported platform: ${pr.platform}`);
}

export function parseUnifiedDiff(diffText: string): ReviewFile[] {
  const files: ReviewFile[] = [];
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");

  let currentFile: ReviewFile | null = null;
  let currentHunk: ReviewFile["hunks"][number] | null = null;
  let oldLine = 0;
  let newLine = 0;
  let lastOldPath: string | null = null;

  const flushHunk = () => {
    if (!currentFile || !currentHunk) return;
    if (currentHunk.oldLines.length === 0 && currentHunk.newLines.length === 0) return;
    currentFile.hunks.push(currentHunk);
    currentHunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (currentFile && currentFile.path && currentFile.hunks.length) {
      files.push(currentFile);
    }
    currentFile = null;
    lastOldPath = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      currentFile = {
        path: "",
        hunks: [],
        addedLines: 0,
        removedLines: 0,
        sizeBytes: 0
      };
      continue;
    }

    if (line.startsWith("--- ")) {
      const path = normalizePath(line.slice(4).trim());
      lastOldPath = path === "/dev/null" ? null : path;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const path = normalizePath(line.slice(4).trim());
      if (currentFile) {
        currentFile.path = path === "/dev/null" ? lastOldPath ?? "" : path;
        currentFile.language = guessLanguage(currentFile.path);
      }
      continue;
    }

    if (line.startsWith("@@")) {
      flushHunk();
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      oldLine = match ? parseInt(match[1], 10) : 0;
      newLine = match ? parseInt(match[3], 10) : 0;
      currentHunk = {
        startLineOld: oldLine,
        startLineNew: newLine,
        oldLines: [],
        newLines: []
      };
      continue;
    }

    if (!currentFile || !currentHunk) {
      continue;
    }

    if (line.startsWith("+")) {
      const text = line.slice(1);
      currentHunk.newLines.push(text);
      currentFile.addedLines = (currentFile.addedLines ?? 0) + 1;
      currentFile.sizeBytes = (currentFile.sizeBytes ?? 0) + text.length;
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      const text = line.slice(1);
      currentHunk.oldLines.push(text);
      currentFile.removedLines = (currentFile.removedLines ?? 0) + 1;
      currentFile.sizeBytes = (currentFile.sizeBytes ?? 0) + text.length;
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      const text = line.slice(1);
      currentHunk.oldLines.push(text);
      currentHunk.newLines.push(text);
      currentFile.sizeBytes = (currentFile.sizeBytes ?? 0) + text.length;
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }
  }

  flushFile();
  return files.filter((f) => f.path && f.hunks.length);
}

export async function loadReviewFilesForPR(
  pr: PrMeta,
  options?: { onlyPaths?: Set<string>; skip?: ReviewPolicy["skipPatterns"] }
): Promise<{ files: ReviewFile[]; skipped: Array<{ path: string; reason: string }> }> {
  const diffText = await fetchDiffForPlatform(pr);
  let files = parseUnifiedDiff(diffText);
  if (options?.onlyPaths?.size) {
    files = files.filter((f) => options.onlyPaths?.has(f.path));
  }
  const { filtered, skipped } = applySkipPatterns(files, options?.skip);
  const { included, skipped: autoSkipped } = filterFilesForReview(filtered);
  return { files: included, skipped: [...skipped, ...autoSkipped] };
}

function applySkipPatterns(
  files: ReviewFile[],
  skip?: ReviewPolicy["skipPatterns"]
): { filtered: ReviewFile[]; skipped: Array<{ path: string; reason: string }> } {
  if (!skip) return { filtered: files, skipped: [] };
  const skipped: Array<{ path: string; reason: string }> = [];
  const filtered = files.filter((file) => {
    const path = file.path;
    const base = path.split("/").pop() ?? path;
    if (skip.paths.some((p) => path.startsWith(p))) {
      skipped.push({ path, reason: "Skipped by path pattern" });
      return false;
    }
    if (skip.names.some((n) => base === n)) {
      skipped.push({ path, reason: "Skipped by file name" });
      return false;
    }
    if (skip.extensions.some((ext) => base.toLowerCase().endsWith(`.${ext.toLowerCase()}`))) {
      skipped.push({ path, reason: "Skipped by extension" });
      return false;
    }
    if (typeof skip.maxFileBytes === "number" && (file.sizeBytes ?? 0) > skip.maxFileBytes) {
      skipped.push({ path, reason: "Skipped: file too large" });
      return false;
    }
    if (typeof skip.maxAddedLines === "number" && (file.addedLines ?? 0) > skip.maxAddedLines) {
      skipped.push({ path, reason: "Skipped: too many added lines" });
      return false;
    }
    return true;
  });
  return { filtered, skipped };
}

function normalizePath(raw: string): string {
  return raw.replace(/^a\//, "").replace(/^b\//, "");
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
