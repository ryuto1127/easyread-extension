<<<<<<< HEAD
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
=======
# EasyRead Proxy Server

Backend proxy for EasyRead Chrome extension.

## Purpose

- Keeps `OPENAI_API_KEY` on server (not in extension)
- Proxies `/api/explain` to OpenAI Responses API
- Proxies `/api/moderate` to OpenAI Moderations API
- Applies anonymous rate limits

## Run

```bash
cd /Users/ryuto/Documents/easyread-extension/server
cp .env.example .env
# set OPENAI_API_KEY in .env
npm run start:env
```

## Environment variables

- `OPENAI_API_KEY` (required)
- `PORT` (default `8787`)
- `ALLOWED_EXTENSION_IDS` (optional CSV)
- `ALLOWED_MODELS` (optional CSV)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX_PER_WINDOW` (default `20`)
- `RATE_LIMIT_MAX_PER_DAY` (default `300`)
>>>>>>> c4478046b7e2db8c0e6e0a11a92f468cb306e421
