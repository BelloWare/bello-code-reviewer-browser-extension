import { defineConfig } from 'vite';
import { build as esbuild } from 'esbuild';
import { resolve } from 'path';
import fs from 'fs';

const mode = process.env.EXT_MODE === 'debug' ? 'debug' : 'prod';
const debugToken = process.env.X_DEBUG_TOKEN_BLLO_CODE_REVIEWER ?? '';
if (mode === 'debug' && debugToken.length <= 10) {
  throw new Error('X_DEBUG_TOKEN_BLLO_CODE_REVIEWER must be set to a value longer than 10 characters for debug builds.');
}
const outDir = resolve(__dirname, mode === 'debug' ? '../dist-debug' : '../dist');
const manifestPath = mode === 'debug' ? 'manifest.debug.json' : 'manifest.prod.json';
const rootDir = resolve(__dirname, 'src');

function copyManifest() {
  return {
    name: 'copy-manifest',
    closeBundle() {
      const manifest = JSON.parse(fs.readFileSync(resolve(__dirname, manifestPath), 'utf-8'));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
  };
}

// Inline the content script into a single classic bundle so Chrome treats it as a non-module script.
function bundleContentAsIife() {
  return {
    name: 'bundle-content-iife',
    async writeBundle(_, bundle) {
      const contentChunk = Object.values(bundle).find(
        (output) => output.type === 'chunk' && output.name === 'contentMain'
      );
      if (!contentChunk) return;

      const filePath = resolve(outDir, contentChunk.fileName);
      const bundledPath = `${filePath}.bundle`;

      fs.rmSync(`${filePath}.map`, { force: true });

      await esbuild({
        entryPoints: [filePath],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        outfile: bundledPath,
        target: 'es2020',
        sourcemap: false
      });

      fs.renameSync(bundledPath, filePath);
    }
  };
}

export default defineConfig({
  root: rootDir,
  publicDir: resolve(__dirname, 'public'),
  define: {
    __BELLO_DEBUG_BUILD__: JSON.stringify(mode === 'debug'),
    __BELLO_DEBUG_TOKEN__: JSON.stringify(mode === 'debug' ? debugToken : '')
  },
  build: {
    outDir,
    emptyOutDir: mode !== 'debug',
    sourcemap: mode === 'debug',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src', mode === 'debug' ? 'background.debug.ts' : 'background.ts'),
        contentMain: resolve(__dirname, 'src/content/contentMain.tsx'),
        popup: resolve(__dirname, 'src/popup.html')
      },
      output: {
        format: 'es',
        entryFileNames: (chunk) => {
          if (chunk.name === 'background') return mode === 'debug' ? 'background.debug.js' : 'background.js';
          if (chunk.name === 'contentMain') return 'contentMain.js';
          if (chunk.name === 'popup') return 'popup.js';
          return 'chunks/[name]-[hash].js';
        },
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'chunks/[name]-[hash].js'
      }
    }
  },
  plugins: [copyManifest(), bundleContentAsIife()]
});
