# Bello Code Reviewer Browser Extension — Agent Notes

## What this repo is
- A Chrome/Chromium **Manifest V3** extension that injects a Bello side panel into PR/MR pages (GitHub + GitLab) and runs an LLM-powered code review.
- A small **debug server** (Express) that receives logs/results from the extension when debug mode is enabled.
- Optional **OpenRouter proxy** to inject API keys and avoid CORS friction during local dev.

## Repo layout
- `extension/`: the browser extension source (TypeScript + Preact).
  - Source lives in `extension/src/`.
  - Build outputs go to repo-root `dist/` (prod) or `dist-debug/` (debug).
- `debug-server/`: Express server used by the debug client in the extension.
  - Stores session logs/artifacts under repo-root `logs/`.
  - Serves a static UI from `debug-server/web-ui/dist` (or run the UI dev server).
- `debug-server/web-ui/`: Vite + Preact UI for the debug server.
- `openrouter-proxy/`: single-file Node HTTP proxy (`openrouter-proxy/server.js`) that forwards to `https://openrouter.ai` and injects auth headers.
- `scripts/`: local dev/test helpers (Playwright launcher, debug-client smoke script, content rebundler).
- `tests/`: Playwright E2E tests and fixtures.

## Common commands (run from repo root)
- Install deps: `npm install`
- Dev (recommended): `npm run dev`
  - runs `debug-server` (default `http://localhost:3030`)
  - builds the extension in watch mode to `dist-debug/`
  - launches Playwright Chromium with the unpacked extension loaded
- Launch browser with the already-built debug extension: `npm run dev:browser`
- Build extension:
  - prod: `npm run build` (outputs `dist/`)
  - debug: `npm --prefix extension run build:debug` (outputs `dist-debug/`)
- Debug server only: `npm --prefix debug-server run dev`
- Debug server UI only: `npm --prefix debug-server/web-ui run dev` (default `http://localhost:4173`)
- OpenRouter proxy: `npm run openrouter:proxy`
- Tests:
  - E2E: `npm run test:e2e`
  - Debug-client smoke: `npm run test:extension` (requires debug build + debug server running)

## Environment variables
- `DEBUG_SERVER_PORT`: debug server port (default `3030`) used by `debug-server/server.ts`.
- `DEBUG_SERVER_URL`: used by `scripts/run-tests.ts` (default `http://localhost:3030`).
- `VITE_DEBUG_API`: debug-server web UI API base (defaults to `http://localhost:3030`).
- Note: the extension debug client targets the debug server via `extension/src/shared/debugConstants.ts`; keep this aligned if you change ports/hosts.
- `EXT_MODE`: extension build mode (`debug` or `prod`) used by `extension/vite.config.ts`.
- OpenRouter proxy:
  - `OPEN_ROUTER_KEY` (or `OPENROUTER_KEY`): required.
  - `OPENROUTER_PROXY_PORT` (default `8803`), `OPENROUTER_PROXY_TARGET`, `OPENROUTER_REFERER`, `OPENROUTER_TITLE`.

## Coding conventions / gotchas
- This is an **ESM** repo (`"type": "module"`). Prefer `import`/`export` and avoid CommonJS patterns.
- `debug-server/` runs TS via `ts-node/esm` and also compiles via `tsc`.
  - Keep the existing pattern of **`.js` extensions in relative imports** (e.g. `./apiTypes.js`) so both `ts-node` and compiled output work.
- Extension architecture:
  - MV3 background is a service worker module: `extension/src/background.ts` and `extension/src/background.debug.ts`.
  - Content script must be **classic (non-module)** for Chrome; the build bundles `contentMain` into an **IIFE** (see `extension/vite.config.ts`). Don’t change `contentMain` entry/output semantics without validating in Chrome.
  - The content script runs on all URLs per manifest, but `mount()` exits early unless the current hostname is enabled in `HostConfig` (see `extension/src/shared/hostResolver.ts` + `extension/src/shared/storage.ts`).
  - Avoid Node-only APIs in extension code; use Web/Chrome extension APIs.
  - Persist user config via `chrome.storage.local` (see `extension/src/shared/storage.ts`); never hardcode or log real API keys.
- Diff fetching/parsing lives in `extension/src/background/githubDiff.ts` (GitHub/GitLab unified diff) and is filtered before sending to the LLM.
  - Automatic skip rules: `extension/src/lib/fileFilter.ts`.
  - User skip rules: `ReviewPolicy.skipPatterns` in `extension/src/types.ts`.

## Debugging workflow
- Debug mode is stored in `chrome.storage.local` (`debugMode`) and can be toggled from the extension popup (`popup.html`).
- In debug builds, the background starts a polling debug client (`extension/src/shared/debugClient.ts`) that:
  - heartbeats to the debug server
  - pulls `/command` jobs and posts `/result`
  - posts structured logs via `extension/src/shared/debugReporter.ts`
- Debug server endpoints are in `debug-server/server.ts` (`/log`, `/heartbeat`, `/status`, `/command`, `/result`, `/results`, `/logs`, `/session/reset`).

## Tests notes
- Playwright E2E tests live in `tests/e2e/` and build/load `dist-debug/`.
- Many tests route a fixture PR HTML (`tests/e2e/fixtures/pr.html`) and stub an OpenRouter-like server on `http://localhost:8803`.
- Note: background diff fetching currently hits `*.diff` endpoints on the real host unless you also stub those requests in tests.
- `tests/e2e/github-live.spec.ts` is intentionally skipped and requires a real GitHub session and local Chrome permissions.

## Don’t edit generated artifacts
- Treat `dist/`, `dist-debug/`, `debug-server/dist/`, `node_modules/`, and `logs/` as build/runtime artifacts (they’re ignored in `.gitignore`).
- Zip artifacts in repo root are not part of source-of-truth.
