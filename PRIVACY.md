# Privacy Notice

This extension performs code review by sending the current PR/MR diff to the LLM provider you configure. It does not require a Bello account.

## What data is processed

- PR/MR diffs from GitHub or GitLab pages you open
- Optional custom focus text you enter for a review run
- Model configuration you enter (stored in `chrome.storage.local`)

## Where data goes

- LLM requests are sent directly to the provider endpoint you configure (OpenAI, Anthropic, Gemini, OpenRouter, or another compatible endpoint).
- In debug mode, the extension can send logs and results to the local debug server you run on your machine.

## Analytics

The extension sends basic, non-content analytics events to Google Analytics. These events include generic metadata such as platform and model count. The extension does not send code content or API keys in analytics events.

## Local storage

- Configuration is stored in `chrome.storage.local`.
- Debug logs and artifacts are stored locally on your machine in the `logs/` folder when you run the debug server.

## Security and access

The debug server is intended for local development only. It binds to `127.0.0.1` and requires a debug token header. Do not expose it to untrusted networks.

If you have questions or want to change analytics behavior, open an issue or fork the project for your own use.
