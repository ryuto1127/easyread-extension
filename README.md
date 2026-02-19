# EasyRead

EasyRead is a Manifest V3 Chrome extension that explains selected text in simple English for learners.

## Architecture

- Extension sends selected text to your EasyRead backend.
- Backend calls OpenAI using your server-side API key.
- End users do not provide their own OpenAI key.

## Features

- Select text on any webpage and click floating `Explain`
- Right-click selection menu: `Explain in Simple English`
- On-page overlay with:
  - Explanation (`simple_explanation`)
  - Word list above B1 (`B2/C1/C2`) with CEFR, definition, and example
- Buttons: `Copy`, `Pin/Unpin`, `Close`
- Local-only settings and cache (7-day TTL)
- Optional moderation checks
- Explanation length auto-scales with selection length
- Backend rate limiting (per anonymous client ID + IP)

## Backend Setup

1. Go to `/Users/ryuto/Documents/easyread-extension/server`.
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
3. Start backend:

```bash
cd /Users/ryuto/Documents/easyread-extension/server
npm run start:env
```

By default, backend runs on `http://localhost:8787`.

## Extension Setup (Unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select folder:
   - `/Users/ryuto/Documents/easyread-extension`
5. Open extension options and set `API Server URL`.
   - local dev: `http://localhost:8787`
   - production: your deployed backend URL

## Settings

- API server URL (`proxyBaseUrl`)
- Model name (default `gpt-4.1-mini`)
- Optional moderation toggle
- Clear cache

## Security Notes

- Never put OpenAI API keys inside extension code.
- Backend keeps API key in env vars.
- Use backend rate limits and optional extension ID allowlist (`ALLOWED_EXTENSION_IDS`).

## Storage

- `easyread_settings_v1`: extension settings (local)
- `easyread_cache_v1`: cached model responses keyed by hash of origin + text + model

## File Layout

- `/Users/ryuto/Documents/easyread-extension/manifest.json`
- `/Users/ryuto/Documents/easyread-extension/src/background.js`
- `/Users/ryuto/Documents/easyread-extension/src/content.js`
- `/Users/ryuto/Documents/easyread-extension/src/content.css`
- `/Users/ryuto/Documents/easyread-extension/src/lib/constants.js`
- `/Users/ryuto/Documents/easyread-extension/src/lib/schema.js`
- `/Users/ryuto/Documents/easyread-extension/src/lib/simplicity.js`
- `/Users/ryuto/Documents/easyread-extension/src/lib/storage.js`
- `/Users/ryuto/Documents/easyread-extension/src/data/a1a2Words.js`
- `/Users/ryuto/Documents/easyread-extension/options/options.html`
- `/Users/ryuto/Documents/easyread-extension/options/options.css`
- `/Users/ryuto/Documents/easyread-extension/options/options.js`
- `/Users/ryuto/Documents/easyread-extension/server/index.mjs`
- `/Users/ryuto/Documents/easyread-extension/server/.env.example`
