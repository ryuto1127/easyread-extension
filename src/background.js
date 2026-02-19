import { A1_A2_WORD_SET } from "./data/a1a2Words.js";
import { EASYREAD_JSON_SCHEMA, MODEL_VERSION } from "./lib/constants.js";
import {
  parseAndNormalizeResponse,
  parseAndNormalizeWordCoverage,
  extractOutputText,
  isOutputUsable
} from "./lib/schema.js";
import { extractA2PlusCandidates } from "./lib/simplicity.js";
import {
  clearCache,
  getCachedResponse,
  getSettings,
  pruneExpiredCacheEntries,
  saveCachedResponse,
  saveSettings
} from "./lib/storage.js";

const DEFAULT_PROXY_BASE_URL = "http://localhost:8787";
const PROXY_EXPLAIN_PATH = "/api/explain";
const CONTEXT_MENU_ID = "easyread_explain";
const MAX_A2_CANDIDATES = 80;
const MAX_OUTPUT_TOKENS = 900;
const inflightRequests = new Map();
const B2_PLUS_LEVELS = new Set(["B2", "C1", "C2"]);
const WORD_COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["a2_plus_words"],
  properties: {
    a2_plus_words: EASYREAD_JSON_SCHEMA.properties.a2_plus_words
  }
};

const CORE_SYSTEM_PROMPT = `
You are EasyRead, a reading helper for English learners.
Always output valid JSON only.
Write clear and natural English that is easy to understand.
Give enough detail so the learner can understand difficult text without opening another tab.
Stay faithful to the selected text and do not invent details.
Identify words above B1 (B2/C1/C2) in the selected text and return short clear meanings and examples.
If the input is unclear or too long, explain that in notes and lower confidence.
`;

class EasyReadError extends Error {
  constructor(message, code = "GENERIC", retriable = false) {
    super(message);
    this.name = "EasyReadError";
    this.code = code;
    this.retriable = retriable;
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await pruneExpiredCacheEntries();
  await createContextMenu();
});

chrome.runtime.onStartup.addListener(async () => {
  await createContextMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: "easyread-context-explain",
    selectionText: info.selectionText || ""
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "easyread-explain") {
    handleExplainRequest(message.payload || {}, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserErrorMessage(error) }));
    return true;
  }

  if (message?.type === "easyread-clear-cache") {
    clearCache()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: toUserErrorMessage(error) }));
    return true;
  }

  return false;
});

async function ensureSettings() {
  const settings = await getSettings();
  await saveSettings(settings);
}

async function createContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Explain in Simple English",
    contexts: ["selection"]
  });
}

async function handleExplainRequest(payload) {
  const settings = await getSettings();
  const selectedText = normalizeSelection(payload.selectedText);

  if (!selectedText) {
    throw new EasyReadError("Please select text first.", "NO_SELECTION");
  }
  if (selectedText.length > settings.maxChars) {
    throw new EasyReadError(
      `Selection is too long (${selectedText.length} chars). Max is ${settings.maxChars}.`,
      "SELECTION_TOO_LONG"
    );
  }

  const proxyBaseUrl = getProxyBaseUrl(settings.proxyBaseUrl);
  const clientId = await getOrCreateAnonymousClientId(settings);

  const pageOrigin = getPageOrigin(payload.pageUrl, payload.pageOrigin);
  const cacheKey = await buildCacheKey({
    pageOrigin,
    selectedText,
    model: settings.model,
    modelVersion: MODEL_VERSION
  });

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    return {
      cached: true,
      result: cached
    };
  }

  if (settings.enableModeration) {
    const inputModeration = await moderateText({
      proxyBaseUrl,
      clientId,
      text: selectedText
    });
    if (inputModeration.flagged) {
      throw new EasyReadError(
        "This text cannot be processed due to safety policy.",
        "INPUT_MODERATED"
      );
    }
  }

  if (inflightRequests.has(cacheKey)) {
    const sharedResult = await inflightRequests.get(cacheKey);
    return {
      cached: false,
      result: sharedResult
    };
  }

  const workPromise = (async () => {
    const candidates = extractA2PlusCandidates(selectedText, A1_A2_WORD_SET, MAX_A2_CANDIDATES);
    const primaryPrompt = buildUserPrompt({
      selectedText,
      candidates
    });

    let parsed = await callModelForEasyRead({
      proxyBaseUrl,
      clientId,
      model: settings.model,
      userPrompt: primaryPrompt
    });

    parsed.a2_plus_words = keepB2PlusWords(parsed.a2_plus_words);

    const needsSupplementalWords = shouldRunSupplementalWordPass({
      currentWords: parsed.a2_plus_words,
      candidateCount: candidates.length,
      selectedTextLength: selectedText.length
    });

    if (needsSupplementalWords) {
      const supplemental = await callModelForB2PlusWords({
        proxyBaseUrl,
        clientId,
        model: settings.model,
        selectedText,
        candidateHints: candidates
      });
      if (supplemental.length > 0) {
        parsed.a2_plus_words = mergeWordEntries(parsed.a2_plus_words, supplemental);
        parsed.a2_plus_words = keepB2PlusWords(parsed.a2_plus_words);
      }
    }

    if (parsed.a2_plus_words.length === 0 && candidates.length > 0) {
      const note = "No words above B1 were detected with enough confidence.";
      parsed.notes = parsed.notes ? `${parsed.notes} ${note}` : note;
    }

    if (!isOutputUsable(parsed)) {
      throw new EasyReadError("Model output is empty. Please try again.", "EMPTY_RESULT");
    }

    if (settings.enableModeration) {
      const outputModeration = await moderateText(
        {
          proxyBaseUrl,
          clientId,
          text: `${parsed.simple_explanation}\n${parsed.notes || ""}`
        }
      );
      if (outputModeration.flagged) {
        throw new EasyReadError(
          "The generated result was blocked by safety policy. Try a different selection.",
          "OUTPUT_MODERATED"
        );
      }
    }

    await saveCachedResponse(
      cacheKey,
      {
        selectedText,
        model: settings.model
      },
      parsed
    );

    return parsed;
  })();

  inflightRequests.set(cacheKey, workPromise);
  try {
    const parsed = await workPromise;
    return {
      cached: false,
      result: parsed
    };
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

function normalizeSelection(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getPageOrigin(pageUrl, fallbackOrigin) {
  if (typeof fallbackOrigin === "string" && fallbackOrigin) {
    return fallbackOrigin;
  }
  if (typeof pageUrl === "string" && pageUrl) {
    try {
      return new URL(pageUrl).origin;
    } catch (_err) {
      return "";
    }
  }
  return "";
}

async function buildCacheKey(parts) {
  const serialized = [
    parts.pageOrigin || "",
    parts.selectedText || "",
    parts.model || "",
    parts.modelVersion || ""
  ].join("||");
  return sha256(serialized);
}

async function sha256(input) {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = new Uint8Array(digest);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function buildUserPrompt({ selectedText, candidates }) {
  const explanationGuidance = getExplanationLengthGuidance(selectedText.length);
  return `
Return JSON only that follows the schema.
Write a useful explanation for learners.
${explanationGuidance}

Selected text:
"""${selectedText}"""

Candidate words that may be above B1:
${JSON.stringify(candidates)}

Rules:
1) Put the full explanation in simple_explanation.
2) Keep the explanation strictly grounded in the selected text; do not add outside facts.
3) Follow the same idea order as the selected text.
4) Include only words above B1 in a2_plus_words (B2/C1/C2 only).
5) Do not include A1, A2, or B1 words (for example do not include common words like "has" or "been").
6) Cover difficult words from all parts of speech, not only nouns.
7) Use pos values from: noun, verb, adj, adv, prep, pron, det, conj, other.
8) Every a2_plus_words item must have non-empty definition_simple and example_simple.
9) confidence must be 0.0 to 1.0.
10) Keep notes short, only when needed.
`;
}

function getExplanationLengthGuidance(selectionLength) {
  if (selectionLength <= 120) {
    return "Write 3 to 4 short sentences.";
  }
  if (selectionLength <= 320) {
    return "Write 5 to 7 sentences.";
  }
  if (selectionLength <= 700) {
    return "Write 7 to 10 sentences.";
  }
  return "Write 9 to 12 sentences.";
}

function normalizeWordKey(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^'+|'+$/g, "");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isB2PlusWordEntry(item) {
  if (!item || typeof item !== "object") {
    return false;
  }
  const cefr = String(item.cefr || "").toUpperCase();
  return B2_PLUS_LEVELS.has(cefr) && hasText(item.definition_simple) && hasText(item.example_simple);
}

function keepB2PlusWords(entries) {
  return (entries || []).filter(isB2PlusWordEntry);
}

function shouldRunSupplementalWordPass({ currentWords, candidateCount, selectedTextLength }) {
  if (candidateCount <= 0 || selectedTextLength < 40) {
    return false;
  }
  if ((currentWords || []).length === 0) {
    return true;
  }
  if (candidateCount >= 10 && (currentWords || []).length <= 1) {
    return true;
  }
  return false;
}

function mergeWordEntries(existingEntries, supplementalEntries) {
  const merged = [];
  const seen = new Set();

  for (const item of [...(existingEntries || []), ...(supplementalEntries || [])]) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const keyWord = normalizeWordKey(item.word);
    const keyLemma = normalizeWordKey(item.lemma);
    const key = keyWord || keyLemma;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

async function callModelForB2PlusWords({
  proxyBaseUrl,
  clientId,
  model,
  selectedText,
  candidateHints
}) {
  const response = await requestResponsesApi({
    proxyBaseUrl,
    clientId,
    model,
    systemPrompt: `
You extract difficult words and explain them for learners.
Return JSON only.
Return only words above B1 (B2, C1, C2).
Include any part of speech: noun, verb, adjective, adverb, preposition, pronoun, determiner, conjunction.
`,
    userPrompt: `
Return JSON only with key "a2_plus_words".

Selected text:
"""${selectedText}"""

Candidate hints (not all are hard enough):
${JSON.stringify(candidateHints || [])}

Rules:
1) Include every word above B1 that appears in the selected text.
2) Do not include A1, A2, or B1 words.
3) Set cefr only to B2, C1, or C2.
4) Fill lemma, pos, cefr, definition_simple, example_simple.
5) definition_simple and example_simple must not be empty.
`,
    schema: WORD_COVERAGE_SCHEMA,
    schemaName: "easyread_word_coverage"
  });

  const rawText = extractOutputText(response);
  if (!rawText) {
    return [];
  }

  try {
    return parseAndNormalizeWordCoverage(rawText);
  } catch (_error) {
    return [];
  }
}

async function callModelForEasyRead({
  proxyBaseUrl,
  clientId,
  model,
  userPrompt,
  correctionHint = ""
}) {
  const response = await requestResponsesApi({
    proxyBaseUrl,
    clientId,
    model,
    systemPrompt: CORE_SYSTEM_PROMPT,
    userPrompt: `${userPrompt}\n${correctionHint}`.trim()
  });

  const rawText = extractOutputText(response);
  if (!rawText) {
    throw new EasyReadError("Model returned empty output.", "EMPTY_OUTPUT", true);
  }

  try {
    return parseAndNormalizeResponse(rawText);
  } catch (_error) {
    if (correctionHint) {
      throw new EasyReadError("Failed to parse model output JSON.", "BAD_JSON");
    }
    return callModelForEasyRead({
      proxyBaseUrl,
      clientId,
      model,
      userPrompt,
      correctionHint:
        "Your previous answer was not valid JSON. Return JSON only, no markdown, no extra text."
    });
  }
}

async function requestResponsesApi({
  proxyBaseUrl,
  clientId,
  model,
  systemPrompt,
  userPrompt,
  schema = EASYREAD_JSON_SCHEMA,
  schemaName = "easyread_output"
}) {
  const payload = {
    model,
    store: false,
    temperature: 0.2,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true
      }
    }
  };

  try {
    return await postResponsesPayload({ proxyBaseUrl, clientId, payload });
  } catch (error) {
    const schemaIssue =
      error instanceof EasyReadError &&
      error.code === "PROXY_ERROR" &&
      /text\.format|json_schema|schema|strict/i.test(error.message);
    if (!schemaIssue) {
      throw error;
    }

    const fallbackPayload = { ...payload };
    delete fallbackPayload.text;
    return postResponsesPayload({ proxyBaseUrl, clientId, payload: fallbackPayload });
  }
}

async function postResponsesPayload({ proxyBaseUrl, clientId, payload }) {
  return withExponentialBackoff(async () => {
    return postProxyJson({
      proxyBaseUrl,
      clientId,
      path: PROXY_EXPLAIN_PATH,
      body: {
        payload
      }
    });
  }, 3);
}

async function withExponentialBackoff(action, maxAttempts) {
  let waitMs = 600;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      const retriable = Boolean(error?.retriable);
      if (!retriable || attempt === maxAttempts) {
        break;
      }
      await sleep(waitMs + Math.floor(Math.random() * 150));
      waitMs *= 2;
    }
  }

  throw lastError || new EasyReadError("Request failed.", "UNKNOWN");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moderateText({ proxyBaseUrl, clientId, text }) {
  try {
    const data = await postProxyJson({
      proxyBaseUrl,
      clientId,
      path: "/api/moderate",
      body: { text }
    });
    return {
      flagged: Boolean(data?.flagged)
    };
  } catch (_error) {
    return { flagged: false };
  }
}

function getProxyBaseUrl(value) {
  const raw = String(value || DEFAULT_PROXY_BASE_URL).trim();
  if (!raw) {
    throw new EasyReadError("Missing API server URL in settings.", "MISSING_PROXY_URL");
  }
  return raw.replace(/\/+$/, "");
}

async function getOrCreateAnonymousClientId(settings) {
  if (settings.anonymousClientId) {
    return settings.anonymousClientId;
  }
  const nextId =
    typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID()
      : `anon-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const nextSettings = {
    ...settings,
    anonymousClientId: nextId
  };
  await saveSettings(nextSettings);
  return nextId;
}

function buildProxyUrl(proxyBaseUrl, path) {
  return `${proxyBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

async function postProxyJson({ proxyBaseUrl, clientId, path, body }) {
  let response;
  try {
    response = await fetch(buildProxyUrl(proxyBaseUrl, path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-EasyRead-Client-Id": clientId,
        "X-EasyRead-Extension-Id": chrome.runtime.id
      },
      body: JSON.stringify(body)
    });
  } catch (_error) {
    throw new EasyReadError("Network error while contacting EasyRead server.", "NETWORK_RETRYABLE", true);
  }

  if (response.status === 429 || response.status >= 500) {
    throw new EasyReadError(
      `EasyRead server temporary error (${response.status}).`,
      "PROXY_RETRYABLE",
      true
    );
  }

  if (!response.ok) {
    const bodyText = await response.text();
    throw new EasyReadError(
      `EasyRead server error (${response.status}). ${bodyText.slice(0, 180)}`,
      "PROXY_ERROR"
    );
  }

  return response.json();
}

function toUserErrorMessage(error) {
  if (error instanceof EasyReadError) {
    return error.message;
  }
  return "EasyRead failed. Please try again.";
}
