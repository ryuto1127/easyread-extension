import http from "node:http";
import { URL } from "node:url";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_BODY_BYTES = 512 * 1024;
const RENDER_BASE_URL = "https://easyread-extension.onrender.com";

const config = {
  port: toInt(process.env.PORT, 8787),
  openAiKey: process.env.OPENAI_API_KEY || "",
  allowedExtensionIds: splitCsv(process.env.ALLOWED_EXTENSION_IDS),
  allowedModels: splitCsv(process.env.ALLOWED_MODELS),
  maxProxyOutputTokens: toInt(process.env.MAX_PROXY_OUTPUT_TOKENS, 8192),
  rateWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  rateWindowMax: toInt(process.env.RATE_LIMIT_MAX_PER_WINDOW, 20),
  rateDayMax: toInt(process.env.RATE_LIMIT_MAX_PER_DAY, 300)
};

if (config.allowedModels.length === 0) {
  config.allowedModels = ["gpt-5-mini", "gpt-4o-mini"];
}

if (!config.openAiKey) {
  console.error("Missing OPENAI_API_KEY in environment.");
  process.exit(1);
}

const rateMap = new Map();

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestHost = String(req.headers.host || "").trim();
  const baseOrigin = requestHost ? `http://${requestHost}` : RENDER_BASE_URL;
  const parsedUrl = new URL(req.url || "/", baseOrigin);

  if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, service: "easyread-proxy" });
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/explain") {
    await handleExplain(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/explain-stream") {
    await handleExplainStream(req, res);
    return;
  }

  if (req.method === "POST" && parsedUrl.pathname === "/api/moderate") {
    await handleModerate(req, res);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(config.port, () => {
  console.log(`EasyRead proxy listening on port ${config.port}`);
});

async function handleExplain(req, res) {
  if (!isAllowedExtension(req, res)) {
    return;
  }

  const rate = checkRateLimit(req);
  if (!rate.ok) {
    sendJson(res, 429, {
      error: "Rate limit exceeded",
      retryAfterSec: rate.retryAfterSec
    }, {
      "Retry-After": String(rate.retryAfterSec)
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid JSON body" });
    return;
  }

  const payload = sanitizeResponsesPayload(body?.payload);
  if (!payload) {
    sendJson(res, 400, { error: "Missing payload object" });
    return;
  }

  const model = String(payload.model || "").trim();
  if (!config.allowedModels.includes(model)) {
    sendJson(res, 400, {
      error: `Model is not allowed. Use one of: ${config.allowedModels.join(", ")}`
    });
    return;
  }
  payload.model = model;

  try {
    const openAiRes = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openAiKey}`
      },
      body: JSON.stringify(payload)
    });

    const text = await openAiRes.text();
    if (!openAiRes.ok) {
      sendJson(res, openAiRes.status, {
        error: `OpenAI responses failed (${openAiRes.status})`,
        detail: text.slice(0, 2000)
      });
      return;
    }

    sendRawJson(res, 200, text);
  } catch (_error) {
    sendJson(res, 502, { error: "Upstream network error" });
  }
}

async function handleExplainStream(req, res) {
  if (!isAllowedExtension(req, res)) {
    return;
  }

  const rate = checkRateLimit(req);
  if (!rate.ok) {
    sendJson(res, 429, {
      error: "Rate limit exceeded",
      retryAfterSec: rate.retryAfterSec
    }, {
      "Retry-After": String(rate.retryAfterSec)
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid JSON body" });
    return;
  }

  const payload = sanitizeResponsesPayload(body?.payload);
  if (!payload) {
    sendJson(res, 400, { error: "Missing payload object" });
    return;
  }

  const model = String(payload.model || "").trim();
  if (!config.allowedModels.includes(model)) {
    sendJson(res, 400, {
      error: `Model is not allowed. Use one of: ${config.allowedModels.join(", ")}`
    });
    return;
  }
  payload.model = model;
  payload.stream = true;

  try {
    const openAiRes = await fetch(`${OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openAiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!openAiRes.ok) {
      const text = await openAiRes.text();
      sendJson(res, openAiRes.status, {
        error: `OpenAI responses failed (${openAiRes.status})`,
        detail: text.slice(0, 2000)
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive"
    });
    res.flushHeaders?.();

    if (!openAiRes.body) {
      res.end();
      return;
    }

    for await (const chunk of openAiRes.body) {
      res.write(chunk);
    }
    res.end();
  } catch (_error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendJson(res, 502, { error: "Upstream network error" });
  }
}

async function handleModerate(req, res) {
  if (!isAllowedExtension(req, res)) {
    return;
  }

  const rate = checkRateLimit(req);
  if (!rate.ok) {
    sendJson(res, 429, {
      error: "Rate limit exceeded",
      retryAfterSec: rate.retryAfterSec
    }, {
      "Retry-After": String(rate.retryAfterSec)
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Invalid JSON body" });
    return;
  }

  const textInput = String(body?.text || "").trim();
  if (!textInput) {
    sendJson(res, 200, { flagged: false });
    return;
  }

  try {
    const openAiRes = await fetch(`${OPENAI_BASE_URL}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openAiKey}`
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: textInput
      })
    });

    if (!openAiRes.ok) {
      sendJson(res, 200, { flagged: false });
      return;
    }

    const data = await openAiRes.json();
    const flagged = Boolean(data?.results?.[0]?.flagged);
    sendJson(res, 200, { flagged });
  } catch (_error) {
    sendJson(res, 200, { flagged: false });
  }
}

function sanitizeResponsesPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const next = { ...payload };
  next.store = false;
  delete next.temperature;
  delete next.top_p;
  delete next.frequency_penalty;
  delete next.presence_penalty;

  const safeMaxProxyOutputTokens = Math.max(256, Math.min(16384, Math.floor(config.maxProxyOutputTokens)));
  if (typeof next.max_output_tokens === "number") {
    next.max_output_tokens = Math.max(64, Math.min(safeMaxProxyOutputTokens, Math.floor(next.max_output_tokens)));
  }

  return next;
}

function isAllowedExtension(req, res) {
  if (config.allowedExtensionIds.length === 0) {
    return true;
  }

  const extensionId = String(req.headers["x-easyread-extension-id"] || "").trim();
  if (!extensionId || !config.allowedExtensionIds.includes(extensionId)) {
    sendJson(res, 403, { error: "Extension is not allowed" });
    return false;
  }
  return true;
}

function checkRateLimit(req) {
  const clientHeader = String(req.headers["x-easyread-client-id"] || "").trim() || "anon";
  const ip = String(req.socket.remoteAddress || "ip-unknown");
  const key = `${clientHeader}|${ip}`;
  const now = Date.now();
  const dayKey = new Date(now).toISOString().slice(0, 10);

  let entry = rateMap.get(key);
  if (!entry) {
    entry = {
      windowResetAt: now + config.rateWindowMs,
      windowCount: 0,
      dayKey,
      dayCount: 0
    };
    rateMap.set(key, entry);
  }

  if (now >= entry.windowResetAt) {
    entry.windowResetAt = now + config.rateWindowMs;
    entry.windowCount = 0;
  }

  if (entry.dayKey !== dayKey) {
    entry.dayKey = dayKey;
    entry.dayCount = 0;
  }

  if (entry.windowCount >= config.rateWindowMax || entry.dayCount >= config.rateDayMax) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.windowResetAt - now) / 1000));
    return { ok: false, retryAfterSec };
  }

  entry.windowCount += 1;
  entry.dayCount += 1;
  return { ok: true, retryAfterSec: 0 };
}

async function readJsonBody(req, maxBytes) {
  let bytes = 0;
  const chunks = [];

  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (_error) {
    throw new Error("Invalid JSON body");
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendRawJson(res, status, rawJson, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(rawJson);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-EasyRead-Client-Id,X-EasyRead-Extension-Id");
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
