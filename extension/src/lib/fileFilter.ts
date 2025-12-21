import type { ReviewFile } from "../types";

export type SkippedFile = { path: string; reason: string };

const MAX_DATA_CHARS = 50_000;
const MAX_FILE_CHARS = 80_000;

const LOCKFILE_REGEX = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const BUILD_DIR_REGEX = /(^|\/)(node_modules|dist|build|coverage|out|vendor|third_party|\.next|\.nuxt)\//;
const MINIFIED_REGEX = /\.(?:min\.js|min\.css|bundle\.js|chunk\.js)$/i;
const SOURCE_MAP_REGEX = /\.map$/i;
const BINARY_REGEX = /\.(png|jpe?g|gif|webp|ico|bmp|svg|mp3|wav|ogg|mp4|mov|webm|ttf|otf|woff2?)$/i;
const SNAPSHOT_REGEX = /(__snapshots__\/|\.snap$)/;

function estimateHunkChars(file: ReviewFile): number {
  return (file.hunks ?? []).reduce((sum, hunk) => {
    const oldTextLen = (hunk.oldLines ?? []).reduce((len, line) => len + line.length + 1, 0);
    const newTextLen = (hunk.newLines ?? []).reduce((len, line) => len + line.length + 1, 0);
    return sum + Math.max(oldTextLen, newTextLen);
  }, 0);
}

function getSkipReason(file: ReviewFile): string | null {
  const path = file.path;

  if (LOCKFILE_REGEX.test(path)) {
    return "dependency lockfile";
  }

  if (BUILD_DIR_REGEX.test(path)) {
    return "generated or vendored code";
  }

  if (MINIFIED_REGEX.test(path)) {
    return "minified or bundled asset";
  }

  if (SOURCE_MAP_REGEX.test(path)) {
    return "source map";
  }

  if (BINARY_REGEX.test(path)) {
    return "binary or media asset";
  }

  if (SNAPSHOT_REGEX.test(path)) {
    return "test snapshot file";
  }

  const approxChars = estimateHunkChars(file);
  const ext = path.split(".").pop()?.toLowerCase();
  const isDataFile = ext ? ["json", "csv", "tsv", "ndjson"].includes(ext) : false;

  if (isDataFile && approxChars > MAX_DATA_CHARS) {
    return "large data fixture";
  }

  if (approxChars > MAX_FILE_CHARS) {
    return "diff too large for LLM budget";
  }

  return null;
}

export function filterFilesForReview(files: ReviewFile[]): { included: ReviewFile[]; skipped: SkippedFile[] } {
  const included: ReviewFile[] = [];
  const skipped: SkippedFile[] = [];

  files.forEach((file) => {
    const reason = getSkipReason(file);
    if (reason) {
      skipped.push({ path: file.path, reason });
    } else {
      included.push(file);
    }
  });

  return { included, skipped };
}
