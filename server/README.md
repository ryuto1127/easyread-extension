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
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX_PER_WINDOW` (default `20`)
- `RATE_LIMIT_MAX_PER_DAY` (default `300`)

Model policy is fixed in code and only allows:
- `gpt-5-nano`
- `gpt-5-mini`
