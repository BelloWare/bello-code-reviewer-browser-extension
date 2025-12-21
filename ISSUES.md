## 1) Debug server serves the UI from the wrong directory (UI won’t load)

**File:** `debug-server/server.ts`
**Lines:** ~206–209 (and the `app.get('*')` right after)

```ts
app.use('/', express.static(path.resolve(rootDir, 'web-ui', 'dist')));
app.get('*', (_req, res) => {
  const indexPath = path.resolve(rootDir, 'web-ui', 'dist', 'index.html');
  ...
});
```

But your UI lives at **`debug-server/web-ui/dist`**, not `${repoRoot}/web-ui/dist`.

### Symptoms

* You run the debug server and build the UI, but browsing to `http://localhost:3030` still shows the fallback message (“Build web-ui for UI.”), or 404s, because it’s looking in a folder that doesn’t exist.

### Fix

Use `__dirname` (debug-server folder) when serving the UI:

```ts
const uiDistDir = path.resolve(__dirname, 'web-ui', 'dist');
app.use('/', express.static(uiDistDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(uiDistDir, 'index.html'), (err) => {
    if (err) res.status(200).send('Debug server running. Build web-ui for UI.');
  });
});
```

---

## 2) Playwright “launch browser with extension” script likely doesn’t load the extension

**File:** `scripts/launch-browser-with-extension.js`
**Issue:** missing `ignoreDefaultArgs: ["--disable-extensions"]`

Your e2e helper `tests/e2e/...` does this correctly:

```ts
ignoreDefaultArgs: ["--disable-extensions"]
```

…but the manual launcher script does **not**, so Playwright’s default `--disable-extensions` can prevent the extension from loading.

### Symptoms

* Script prints: “no extension service worker seen (extension may not have loaded)”
* The extension never injects.

### Fix

Add:

```js
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    ...
  ],
  ignoreDefaultArgs: ["--disable-extensions"],
});
```

---

## 3) “Base URL” placeholder misleads users into entering `/v1` — which breaks all real endpoints

**File:** `extension/src/content/sidePanel.tsx`
**Lines:** ~800–812 (and again ~1057)
**Current placeholder:** `"https://api.example.com/v1"`

But your request code treats `endpoint` as an **origin/base** and appends its own `/v1/...` (OpenAI/Anthropic) or `/api/v1/...` (OpenRouter):

* **OpenAI**: `const url = `${endpoint}/v1/responses`;`
* **OpenRouter**: `const url = `${endpoint}/api/v1/chat/completions`;`
* **Anthropic**: `const url = `${endpoint}/v1/messages`;`
* **Gemini**: appends `/v1beta/...`

So if a user follows the placeholder and enters `https://api.openai.com/v1`, you’ll call:

* `https://api.openai.com/v1/v1/responses` ✅ **wrong**
* `https://openrouter.ai/api/v1/api/v1/chat/completions` ✅ **wrong**
* `https://api.anthropic.com/v1/v1/messages` ✅ **wrong**

### Symptoms

* “Check connectivity” fails with 404 / unexpected endpoint even with a valid key.
* Reviews fail even though the base URL looks correct to the user.

### Fix options

**: change the placeholder text** to not include `/v1`:

```tsx
placeholder="https://api.example.com"
```

…and maybe label it “Base origin (no /v1)”.

---

## 4) `pingModel()` has a couple logic bugs (false positives + wrong mock check)

**File:** `extension/src/background/reviewEngine.ts`
**Function:** `pingModel` around lines ~1013+

### 4a) Wrong field checked for mock failure

```ts
if (model.model.startsWith("mock://fail")) {
  return { ok: false, error: "Mock endpoint failure" };
}
```

Everywhere else, “mock://…” is treated as the **endpoint**, not the model name.

**Fix:** delete this.

### 4b) Ping success check uses substring match `"hi"` → tons of false positives

Example:

```ts
return text.toLowerCase().includes(expected) ? { ok: true } : ...
```

If the model returns `"This worked"` it contains `"hi"` (`t**hi**s`) → ping passes even though it did not follow the instruction.

**Fix:**

```ts
const normalized = text.trim().toLowerCase();
return normalized === "hi" ? { ok: true } : { ok: false, error: `Unexpected response: ${text}` };
```

### Why this matters

This “Check connectivity” is used to gate saving config. With current logic it can:

* incorrectly pass bad configs, and
* incorrectly fail good ones (see also seed param note below).

---

## 5) “Connectivity test” uses different OpenAI endpoint than real review

**Files:**

* `pingModel()` uses: `/v1/chat/completions` for OpenAI
* Real review uses: `/v1/responses` in `callOpenAI()`

If a user config is valid for Responses API but chat completions behaves differently (or vice versa), the “connectivity test” can be misleading.

### Fix idea

Either:

* make pingModel use /v1/responses as well 

---

## 6) Type-level bug: pending “go to code” type doesn’t match usage

**File:** `extension/src/content/sidePanel.tsx`
In the “pending go-to-code” restore logic, you declare:

```ts
let pending: { ... pr?: { repo?: string; number?: number }; ... } | null = null;
```

…but later check:

```ts
pending.pr?.host !== prMeta.host ||
pending.pr?.platform !== prMeta.platform
```

At runtime it works (because you store `host/platform`), but TypeScript will complain if you ever turn on typechecking in CI.

### Fix

Update the type to include `host` and `platform`.

---
