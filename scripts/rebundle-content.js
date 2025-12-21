import { build } from "esbuild";
import { existsSync, renameSync } from "fs";
import path from "path";

const targetDir = process.argv[2];
if (!targetDir) {
  console.error("Usage: node scripts/rebundle-content.js <dist-dir>");
  process.exit(1);
}

const contentPath = path.resolve(targetDir, "contentMain.js");
if (!existsSync(contentPath)) {
  console.warn(`[rebundle] no contentMain.js found in ${targetDir}, skipping`);
  process.exit(0);
}

const outfile = path.resolve(targetDir, "contentMain.bundle.js");

await build({
  entryPoints: [contentPath],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile,
  sourcemap: false,
  target: "es2020"
});

renameSync(outfile, contentPath);
console.log(`[rebundle] bundled contentMain.js for ${targetDir}`);
