# EasyRead

EasyRead is a Manifest V3 Chrome extension that explains selected text in simple English for learners.

## Architecture

- Extension sends selected text to `https://easyread-extension.onrender.com`.
- Backend calls OpenAI using your server-side API key.
- End users do not provide their own OpenAI key.

## Features

- Select text on any webpage and click floating `Explain`
- Right-click selection menu: `Explain in Simple English`
- On-page overlay with:
  - Explanation (`simple_explanation`)
  - Word list above B1 (`B2/C1/C2`) with CEFR, definition, and example
- Buttons: `Copy`, `Pin/Unpin`, `Close`
- Local-only cache (7-day TTL)
- Explanation length auto-scales with selection length
- Long selections are automatically processed in chunks (up to 12,000 chars)
- Auto model routing:
  - `gpt-5-nano` for short selections (`<= 1200` chars)
  - `gpt-5-mini` for longer selections (`> 1200` chars)
- Backend rate limiting (per anonymous client ID + IP)

## Backend Setup

Canonical backend code is in:
`/Users/ryuto/Documents/easyread-extension/server`

1. Go to `/Users/ryuto/Documents/easyread-extension/server`.
2. Copy `.env.example` to `.env` and set `OPENAI_API_KEY`.
3. Start backend:

```bash
cd /Users/ryuto/Documents/easyread-extension/server
npm run start:env
```

From the repo root, this also works:

```bash
cd /Users/ryuto/Documents/easyread-extension
npm run start:env
```

If you deploy to Render, use your deployed URL (current production target:
`https://easyread-extension.onrender.com`).

## Extension Setup (Unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select folder:
   - `/Users/ryuto/Documents/easyread-extension`
5. The extension is preconfigured. No API/model settings are needed in Options.
6. Options page only provides `Clear Cache`.

## Security Notes

- Never put OpenAI API keys inside extension code.
- Backend keeps API key in env vars.
- Use backend rate limits and optional extension ID allowlist (`ALLOWED_EXTENSION_IDS`).

## Storage

- `easyread_settings_v1`: anonymous client ID (local)
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
