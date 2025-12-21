# Bello Code Reviewer Browser Extension

Bello is a Chrome/Chromium Manifest V3 extension that injects a side panel on GitHub and GitLab PR/MR pages and runs an LLM-powered code review. This repo also includes a local debug server + web UI and an optional OpenRouter proxy for development.

## Repo layout

- `extension/`: MV3 extension source (TypeScript + Preact)
- `debug-server/`: local Express debug server
- `debug-server/web-ui/`: Vite + Preact debug UI
- `openrouter-proxy/`: local OpenRouter proxy (optional)
- `scripts/`: dev helpers
- `tests/`: Playwright E2E tests

## Quick start

```bash
npm install
```

### Debug development (recommended)

The debug server is locked to localhost and requires a token.

```bash
export X_DEBUG_TOKEN_BLLO_CODE_REVIEWER="change-me-to-a-long-token"
npm run dev
```

This will:
- run the debug server on `http://127.0.0.1:3030`
- build the debug extension to `dist-debug/`
- launch Playwright Chromium with the extension loaded

### Build the extension

```bash
npm run build
```

Output: `dist/`

### Run only the debug server

```bash
export X_DEBUG_TOKEN_BLLO_CODE_REVIEWER="change-me-to-a-long-token"
npm --prefix debug-server run dev
```

### Run the debug server UI

```bash
export X_DEBUG_TOKEN_BLLO_CODE_REVIEWER="change-me-to-a-long-token"
npm --prefix debug-server/web-ui run dev
```

Set `VITE_DEBUG_API` if you use a non-default server URL.

### Optional: OpenRouter proxy

```bash
export OPEN_ROUTER_KEY="..."
npm run openrouter:proxy
```

### Tests

```bash
npm run test:e2e
npm run test:extension
```

## Environment variables

- `X_DEBUG_TOKEN_BLLO_CODE_REVIEWER`: required for debug server and debug builds (must be > 10 chars)
- `DEBUG_SERVER_PORT`: debug server port (default 3030)
- `DEBUG_SERVER_URL`: used by `scripts/run-tests.ts` (default `http://localhost:3030`)
- `VITE_DEBUG_API`: debug web UI API base (default `http://localhost:3030`)
- `EXT_MODE`: `debug` or `prod` for extension builds
- `OPEN_ROUTER_KEY`/`OPENROUTER_KEY`: for the OpenRouter proxy

## Security note (debug only)

The debug server is for local development only. It binds to `127.0.0.1`, enforces an allowlist CORS policy, and requires `X-Debug-Token` on all API requests. Do not expose it to untrusted networks.
