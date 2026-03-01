import { A1_A2_WORD_SET } from "./data/a1a2Words.js";
import { CEFR_WORD_LEVEL_MAP } from "./data/cefrWordLevels.js";
import { EASYREAD_JSON_SCHEMA, MODEL_VERSION, WORD_LEVEL_VALUES } from "./lib/constants.js";
import {
  parseAndNormalizeWordCoverage,
  extractOutputText,
  isOutputUsable
} from "./lib/schema.js";
import {
  clearCache,
  getCachedResponse,
  getSettings,
  pruneExpiredCacheEntries,
  saveCachedResponse,
  saveSettings
} from "./lib/storage.js";

const PROXY_BASE_URL = "https://easyread-extension.onrender.com";
const PROXY_EXPLAIN_PATH = "/api/explain";
const PROXY_EXPLAIN_STREAM_PATH = "/api/explain-stream";
const PROXY_HEALTH_PATH = "/api/health";
const CONTEXT_MENU_ID = "easyread_explain";
const EXPLAIN_MODEL = "gpt-5-mini";
const EXPLANATION_MODES = new Set(["simple", "balanced", "detailed"]);
const DEFAULT_EXPLANATION_MODE = "balanced";
const DEFAULT_WORD_LEVEL_THRESHOLD = "B2";
const WORD_DISCOVERY_BASE_THRESHOLD = DEFAULT_WORD_LEVEL_THRESHOLD;
const WORD_LEVEL_THRESHOLD_VALUES = new Set(WORD_LEVEL_VALUES);
const TOKEN_REGEX = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const CEFR_RANK = {
  A1: 0,
  A2: 1,
  B1: 2,
  B2: 3,
  C1: 4,
  C2: 5,
  unknown: 0
};
const MAX_A2_CANDIDATES = 40;
const MAX_OUTPUT_TOKENS = 2600;
const HARD_MAX_CHARS = 20000;
const WORD_FETCH_TIMEOUT_MS = 20000;
const WORD_MAX_OUTPUT_TOKENS = 1800;
const WARMUP_COOLDOWN_MS = 45_000;
const POS_VALUE_SET = new Set(["noun", "verb", "adj", "adv", "prep", "pron", "det", "conj", "other"]);
const LOW_VALUE_WORD_SET = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "him",
  "his",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "said",
  "she",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "soldier",
  "soldiers"
]);
const WORD_COVERAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["a2_plus_words"],
  properties: {
    a2_plus_words: EASYREAD_JSON_SCHEMA.properties.a2_plus_words
  }
};
const EASY_WORD_REPLACEMENTS = {
  "small details": "small things",
  "daily life": "everyday life",
  details: "small things",
  closely: "very carefully",
  emulated: "copied",
  hometown: "home town",
  souvenir: "gift",
  emblazoned: "with words on it",
  slogans: "short words",
  stationery: "paper and pens",
  bearing: "with",
  likeness: "face",
  alongside: "next to",
  political: "government",
  idol: "hero",
  former: "past",
  minister: "leader",
  confidence: "clear sign",
  detected: "found",
  incomplete: "not done"
};

const EXPLANATION_SYSTEM_PROMPT = `
You are EasyRead, a reading helper for English learners.
Write clear and natural English that is easy to understand.
Give enough detail so the learner can understand difficult text without opening another tab.
Stay faithful to the selected text and do not invent details.
Return plain text only for the explanation.
`;

class EasyReadError extends Error {
  constructor(message, code = "GENERIC", retriable = false) {
    super(message);
    this.name = "EasyReadError";
    this.code = code;
    this.retriable = retriable;
  }
}

let proxyWarmupInFlight = null;
let lastProxyWarmupAt = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await pruneExpiredCacheEntries();
  await createContextMenu();
  void warmProxyConnection(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await createContextMenu();
  void warmProxyConnection(true);
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

  if (message?.type === "easyread-fetch-words") {
    handleFetchWordsRequest(message.payload || {}, sender)
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

  if (message?.type === "easyread-get-settings") {
    getSettings()
      .then((settings) => {
        const visibility = normalizeVisibilityPair(settings);
        return (
        sendResponse({
          ok: true,
          data: {
            wordLevelThreshold: normalizeWordLevelThreshold(settings.wordLevelThreshold),
            showExplanation: visibility.showExplanation,
            showWords: visibility.showWords
          }
        })
      );
      })
      .catch((error) => sendResponse({ ok: false, error: toUserErrorMessage(error) }));
    return true;
  }

  if (message?.type === "easyread-update-settings") {
    updateRuntimeSettings(message.payload || {})
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: toUserErrorMessage(error) }));
    return true;
  }

  if (message?.type === "easyread-warmup") {
    warmProxyConnection()
      .then((warmed) => sendResponse({ ok: true, warmed }))
      .catch(() => sendResponse({ ok: true, warmed: false }));
    return true;
  }

  return false;
});

async function ensureSettings() {
  const settings = await getSettings();
  const visibility = normalizeVisibilityPair(settings);
  await saveSettings({
    ...settings,
    wordLevelThreshold: normalizeWordLevelThreshold(settings.wordLevelThreshold),
    showExplanation: visibility.showExplanation,
    showWords: visibility.showWords
  });
}

async function updateRuntimeSettings(payload) {
  const current = await getSettings();
  const patch = payload && typeof payload === "object" ? payload : {};
  const visibility = normalizeVisibilityPair({
    showExplanation: patch.showExplanation ?? current.showExplanation,
    showWords: patch.showWords ?? current.showWords
  });
  const next = {
    ...current,
    wordLevelThreshold: normalizeWordLevelThreshold(patch.wordLevelThreshold ?? current.wordLevelThreshold),
    showExplanation: visibility.showExplanation,
    showWords: visibility.showWords
  };
  await saveSettings(next);
  return {
    wordLevelThreshold: next.wordLevelThreshold,
    showExplanation: next.showExplanation,
    showWords: next.showWords
  };
}

async function createContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Explain in Simple English",
    contexts: ["selection"]
  });
}

async function handleExplainRequest(payload, sender) {
  const settings = await getSettings();
  const selectedText = normalizeSelection(payload.selectedText);
  const requestId = normalizeRequestId(payload.requestId);
  const explanationMode = normalizeExplanationMode(payload.explanationMode);
  const wordLevelThreshold = normalizeWordLevelThreshold(settings.wordLevelThreshold);
  const discoveryThreshold = WORD_DISCOVERY_BASE_THRESHOLD;

  if (!selectedText) {
    throw new EasyReadError("Please select text first.", "NO_SELECTION");
  }
  if (selectedText.length > HARD_MAX_CHARS) {
    throw new EasyReadError(
      `Selection is too long (${selectedText.length} chars). Max is ${HARD_MAX_CHARS}.`,
      "SELECTION_TOO_LONG"
    );
  }
  const selectedModel = EXPLAIN_MODEL;
  const clientId = await getOrCreateAnonymousClientId(settings);

  const pageOrigin = getPageOrigin(payload.pageUrl, payload.pageOrigin);
  const cacheKey = await buildCacheKey({
    pageOrigin,
    selectedText,
    explanationMode,
    wordLevelThreshold: discoveryThreshold,
    model: selectedModel,
    modelVersion: MODEL_VERSION
  });

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    const safeCachedRaw = normalizeResultShape(cached);
    const safeCached = enforceEasyLanguage(
      {
        ...safeCachedRaw,
        a2_plus_words: Array.isArray(safeCachedRaw.a2_plus_words) ? safeCachedRaw.a2_plus_words : []
      },
      selectedText
    );
    if (!isOutputUsable(safeCached)) {
      // Ignore invalid cached payload and fetch a fresh model result.
    } else {
      const cachedWords = Array.isArray(safeCached.a2_plus_words) ? safeCached.a2_plus_words : [];
      const filteredCached = filterResultByWordLevel(safeCached, wordLevelThreshold);
      const cachedHasWords = cachedWords.length > 0;
      if (!cachedHasWords) {
        const cachedCandidates = extractWordCandidates(selectedText, discoveryThreshold, MAX_A2_CANDIDATES);
        if (cachedCandidates.length > 0) {
          return {
            cached: true,
            result: filteredCached,
            requestId,
            wordsPending: true,
            explanationMode,
            wordLevelThreshold
          };
        }
      }
      return {
        cached: true,
        result: filteredCached,
        requestId,
        wordsPending: false,
        explanationMode,
        wordLevelThreshold
      };
    }
  }

  const explanationOnly = await analyzeExplanationOnlySelection({
    selectedText,
    clientId,
    model: selectedModel,
    explanationMode,
    wordLevelThreshold: discoveryThreshold,
    requestId,
    streamTabId: typeof sender?.tab?.id === "number" ? sender.tab.id : null
  });
  const wordsPending = explanationOnly.candidateCount > 0;
  const immediateResult = enforceEasyLanguage(
    {
      ...explanationOnly.parsed,
      a2_plus_words: []
    },
    selectedText
  );
  const safeImmediateResult = normalizeResultShape(immediateResult);

  if (!isOutputUsable(safeImmediateResult)) {
    throw new EasyReadError("Model did not return a usable explanation. Please try again.", "EMPTY_RESULT");
  }

  await saveCachedResponse(
    cacheKey,
    {
      selectedText,
      explanationMode,
      wordLevelThreshold: discoveryThreshold,
      model: selectedModel
    },
    safeImmediateResult
  );

  return {
    cached: false,
    result: safeImmediateResult,
    requestId,
    wordsPending,
    explanationMode,
    wordLevelThreshold
  };
}

async function handleFetchWordsRequest(payload, _sender) {
  const settings = await getSettings();
  const selectedText = normalizeSelection(payload.selectedText);
  const requestId = normalizeRequestId(payload.requestId);
  const explanationMode = normalizeExplanationMode(payload.explanationMode);
  const wordsOnly = Boolean(payload?.wordsOnly);
  const wordLevelThreshold = normalizeWordLevelThreshold(settings.wordLevelThreshold);
  const discoveryThreshold = WORD_DISCOVERY_BASE_THRESHOLD;

  if (!selectedText) {
    throw new EasyReadError("Please select text first.", "NO_SELECTION");
  }
  if (selectedText.length > HARD_MAX_CHARS) {
    throw new EasyReadError(
      `Selection is too long (${selectedText.length} chars). Max is ${HARD_MAX_CHARS}.`,
      "SELECTION_TOO_LONG"
    );
  }

  const selectedModel = EXPLAIN_MODEL;
  const clientId = await getOrCreateAnonymousClientId(settings);
  const pageOrigin = getPageOrigin(payload.pageUrl, payload.pageOrigin);
  const cacheKey = await buildCacheKey({
    pageOrigin,
    selectedText,
    explanationMode,
    wordLevelThreshold: discoveryThreshold,
    model: selectedModel,
    modelVersion: MODEL_VERSION
  });

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    const safeCachedRaw = normalizeResultShape(cached);
    const safeCached = enforceEasyLanguage(
      {
        ...safeCachedRaw,
        a2_plus_words: Array.isArray(safeCachedRaw.a2_plus_words) ? safeCachedRaw.a2_plus_words : []
      },
      selectedText
    );
    if (Array.isArray(safeCached.a2_plus_words) && safeCached.a2_plus_words.length > 0) {
      const displayCached = filterResultByWordLevel(safeCached, wordLevelThreshold);
      return {
        cached: true,
        result: displayCached,
        requestId,
        wordsPending: false,
        explanationMode,
        wordLevelThreshold
      };
    }
  }

  const baseResult =
    cached && typeof cached === "object"
      ? cached
      : payload?.baseResult && typeof payload.baseResult === "object"
        ? payload.baseResult
        : wordsOnly
          ? {
              simple_explanation: "",
              a2_plus_words: [],
              notes: "",
              confidence: 0.5
            }
          : null;
  if (!baseResult || (!wordsOnly && !hasText(baseResult.simple_explanation))) {
    throw new EasyReadError("Base explanation is missing. Please click Explain again.", "MISSING_BASE_RESULT");
  }

  const candidates = extractWordCandidates(selectedText, discoveryThreshold, MAX_A2_CANDIDATES);
  if (candidates.length === 0) {
    const noWordsResult = enforceEasyLanguage(
      {
        ...baseResult,
        a2_plus_words: [],
        notes: baseResult.notes || ""
      },
      selectedText
    );
    const safeNoWords = normalizeResultShape(noWordsResult);
    await saveCachedResponse(
      cacheKey,
      {
        selectedText,
        explanationMode,
        wordLevelThreshold: discoveryThreshold,
        model: selectedModel
      },
      safeNoWords
    );
    return {
      cached: false,
      result: filterResultByWordLevel(safeNoWords, wordLevelThreshold),
      requestId,
      wordsPending: false,
      explanationMode,
      wordLevelThreshold
    };
  }

  const wordLimit = getWordResultLimit(selectedText.length, discoveryThreshold);
  let words = [];
  try {
    words = await withTimeout(
      callModelForB2PlusWords({
        clientId,
        model: selectedModel,
        selectedText,
        candidateHints: candidates,
        wordLimit,
        wordLevelThreshold: discoveryThreshold
      }),
      WORD_FETCH_TIMEOUT_MS
    );
  } catch (_error) {
    words = [];
  }

  if (!Array.isArray(words) || words.length === 0) {
    words = buildFallbackWordEntriesFromCandidates(candidates, wordLimit, discoveryThreshold);
  }

  const finalWordItems = normalizeAndCompleteWordEntries(
    applyLocalCefrLevels(words),
    wordLimit,
    discoveryThreshold
  );

  const finalResult = enforceEasyLanguage(
    {
      ...baseResult,
      a2_plus_words: finalWordItems,
      notes: baseResult.notes || ""
    },
    selectedText
  );
  const safeFinalResult = normalizeResultShape(finalResult);
  await saveCachedResponse(
    cacheKey,
    {
      selectedText,
      explanationMode,
      wordLevelThreshold: discoveryThreshold,
      model: selectedModel
    },
    safeFinalResult
  );
  const displayResult = filterResultByWordLevel(safeFinalResult, wordLevelThreshold);

  return {
    cached: false,
    result: displayResult,
    requestId,
    wordsPending: false,
    explanationMode,
    wordLevelThreshold
  };
}

function normalizeSelection(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRequestId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

function normalizeExplanationMode(mode) {
  const normalized = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  return EXPLANATION_MODES.has(normalized) ? normalized : DEFAULT_EXPLANATION_MODE;
}

function normalizeWordLevelThreshold(value) {
  const level = String(value || "").trim().toUpperCase();
  return WORD_LEVEL_THRESHOLD_VALUES.has(level) ? level : DEFAULT_WORD_LEVEL_THRESHOLD;
}

function normalizeVisibilityValue(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }
  return Boolean(fallback);
}

function normalizeVisibilityPair(values) {
  let showExplanation = normalizeVisibilityValue(values?.showExplanation, true);
  let showWords = normalizeVisibilityValue(values?.showWords, true);
  if (!showExplanation && !showWords) {
    showExplanation = true;
  }
  return {
    showExplanation,
    showWords
  };
}

function formatWordLevelLabel(level) {
  const normalized = normalizeWordLevelThreshold(level);
  return normalized === "C2" ? "C2" : `${normalized}+`;
}

function appendNote(base, addition) {
  const next = String(addition || "").trim();
  if (!next) {
    return String(base || "").trim();
  }
  const prior = String(base || "").trim();
  return prior ? `${prior} ${next}` : next;
}

function normalizeResultShape(result) {
  const base = result && typeof result === "object" ? { ...result } : {};
  if (!Array.isArray(base.a2_plus_words)) {
    base.a2_plus_words = [];
  }
  if (typeof base.simple_explanation !== "string") {
    base.simple_explanation = "";
  } else {
    base.simple_explanation = base.simple_explanation.trim();
  }
  if (typeof base.notes !== "string") {
    base.notes = "";
  }
  if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) {
    base.confidence = 0.5;
  }
  return base;
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
    parts.explanationMode || "",
    parts.wordLevelThreshold || "",
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

async function analyzeExplanationOnlySelection({
  selectedText,
  clientId,
  model,
  explanationMode = DEFAULT_EXPLANATION_MODE,
  wordLevelThreshold = WORD_DISCOVERY_BASE_THRESHOLD,
  requestId = "",
  streamTabId = null
}) {
  const candidates = extractWordCandidates(selectedText, wordLevelThreshold, MAX_A2_CANDIDATES);
  const userPrompt = buildExplanationOnlyPrompt(selectedText, explanationMode);
  const tokenBudget = getExplanationOnlyTokenBudget(selectedText.length, explanationMode);

  const rawText = await requestExplanationText({
    clientId,
    model,
    userPrompt,
    maxOutputTokens: tokenBudget,
    requestId,
    streamTabId
  });
  if (!rawText) {
    throw new EasyReadError("Model returned no explanation text. Please try again.", "EMPTY_OUTPUT");
  }

  let parsed = {
    simple_explanation: extractExplanationFromRawText(rawText),
    a2_plus_words: [],
    notes: "",
    confidence: 0.78
  };

  if (!hasText(parsed.simple_explanation)) {
    parsed.simple_explanation = extractExplanationFromRawText(rawText);
    parsed.confidence = Math.max(0.65, Number(parsed.confidence) || 0.65);
  }

  if (!hasText(parsed.simple_explanation)) {
    throw new EasyReadError("Model returned empty explanation. Please try again.", "EMPTY_OUTPUT");
  }

  if (isExplanationTooCloseToSource(parsed.simple_explanation, selectedText)) {
    throw new EasyReadError(
      "Model explanation was too close to the original text. Please select a shorter part and try again.",
      "COPY_OUTPUT"
    );
  }

  parsed = enforceEasyLanguage(
    {
      ...parsed,
      a2_plus_words: []
    },
    selectedText
  );
  return {
    parsed,
    candidateCount: candidates.length,
    candidates
  };
}

function buildExplanationOnlyPrompt(selectedText, explanationMode) {
  const mode = normalizeExplanationMode(explanationMode);
  const explanationGuidance = getExplanationLengthGuidance(selectedText.length, mode);
  const styleGuidance = getExplanationStyleGuidance(mode);
  return `
Write a useful explanation for learners.
Return explanation text only (no JSON, no markdown, no bullets, no labels).
Requested explanation mode: ${mode}.
${styleGuidance}
${explanationGuidance}

Selected text:
"""${selectedText}"""

Rules:
1) Output only the explanation body text.
2) Keep the explanation strictly grounded in the selected text; do not add outside facts.
3) Follow the same idea order as the selected text.
4) Do not include word-list entries in this step.
5) Do not copy full sentences from the selected text. Paraphrase in easier words.
`;
}

function getExplanationStyleGuidance(explanationMode) {
  if (explanationMode === "simple") {
    return "Use very easy words and short direct sentences.";
  }
  if (explanationMode === "detailed") {
    return "Use clear learner-friendly words and include key details, links, and reasons from the text.";
  }
  return "Use easy but natural words and include enough detail for a learner to follow each main idea.";
}

function getExplanationLengthGuidance(selectionLength, explanationMode) {
  const mode = normalizeExplanationMode(explanationMode);
  if (mode === "simple") {
    if (selectionLength <= 120) {
      return "Write 1 to 2 short sentences.";
    }
    if (selectionLength <= 320) {
      return "Write 2 to 3 short sentences.";
    }
    if (selectionLength <= 700) {
      return "Write 3 to 4 short sentences.";
    }
    return "Write 4 to 5 short sentences.";
  }

  if (mode === "detailed") {
    if (selectionLength <= 120) {
      return "Write 2 to 3 sentences with key detail.";
    }
    if (selectionLength <= 320) {
      return "Write 3 to 4 sentences.";
    }
    if (selectionLength <= 700) {
      return "Write 4 to 5 sentences.";
    }
    return "Write 5 to 6 sentences.";
  }

  if (selectionLength <= 120) {
    return "Write 1 to 2 short sentences.";
  }
  if (selectionLength <= 320) {
    return "Write 2 to 4 sentences.";
  }
  if (selectionLength <= 700) {
    return "Write 3 to 5 sentences.";
  }
  return "Write 4 to 6 sentences.";
}

function getWordResultLimit(selectionLength, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  if (selectionLength <= 180) {
    return threshold === "C2" ? 2 : threshold === "C1" ? 3 : 4;
  }
  if (selectionLength <= 500) {
    return threshold === "C2" ? 4 : threshold === "C1" ? 5 : 6;
  }
  if (selectionLength <= 1200) {
    return threshold === "C2" ? 6 : threshold === "C1" ? 7 : 8;
  }
  return threshold === "C2" ? 8 : threshold === "C1" ? 9 : 10;
}

function getExplanationOnlyTokenBudget(selectionLength, explanationMode = DEFAULT_EXPLANATION_MODE) {
  const mode = normalizeExplanationMode(explanationMode);
  let budget;

  if (selectionLength <= 260) {
    budget = 1400;
  } else if (selectionLength <= 900) {
    budget = 2100;
  } else {
    budget = 3000;
  }

  if (mode === "simple") {
    budget -= 150;
  } else if (mode === "detailed") {
    budget += 250;
  }

  return Math.max(1200, budget);
}

function normalizeWordKey(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^'+|'+$/g, "");
}

function lookupLocalCefrLevel(word, lemma = "") {
  const wordKey = normalizeWordKey(word);
  const lemmaKey = normalizeWordKey(lemma);
  const level =
    CEFR_WORD_LEVEL_MAP[wordKey] ||
    CEFR_WORD_LEVEL_MAP[lemmaKey] ||
    CEFR_WORD_LEVEL_MAP[normalizeLemma(wordKey)] ||
    CEFR_WORD_LEVEL_MAP[normalizeLemma(lemmaKey)] ||
    "";
  return normalizeCefrLevel(level);
}

function extractWordCandidates(
  selectedText,
  wordLevelThreshold = WORD_DISCOVERY_BASE_THRESHOLD,
  maxCount = MAX_A2_CANDIDATES
) {
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const safeLimit = Math.max(1, Number(maxCount) || MAX_A2_CANDIDATES);
  const tokens = String(selectedText || "").match(TOKEN_REGEX) || [];
  const candidatesByKey = new Map();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const key = normalizeWordKey(token);
    if (!key || key.length <= 2) {
      continue;
    }

    const lemma = normalizeLemma(key);
    const localLevel = lookupLocalCefrLevel(key, lemma);
    const knownLevel = localLevel !== "unknown";

    if (LOW_VALUE_WORD_SET.has(key) || LOW_VALUE_WORD_SET.has(lemma)) {
      continue;
    }
    if (knownLevel && !isCefrAtOrAboveThreshold(localLevel, threshold)) {
      continue;
    }
    if (!knownLevel && (A1_A2_WORD_SET.has(key) || A1_A2_WORD_SET.has(lemma))) {
      continue;
    }
    if (!knownLevel && isLikelyProperNameWord(token)) {
      continue;
    }

    const rank = CEFR_RANK[localLevel] || 0;
    const existing = candidatesByKey.get(key);
    if (!existing) {
      candidatesByKey.set(key, {
        word: token,
        lemma,
        cefr: localLevel,
        source: knownLevel ? "oxford" : "model",
        knownLevel,
        rank,
        index
      });
      continue;
    }

    // Keep stronger CEFR signal or earlier occurrence when score is equal.
    if (rank > existing.rank || (rank === existing.rank && index < existing.index)) {
      candidatesByKey.set(key, {
        word: token,
        lemma,
        cefr: localLevel,
        source: knownLevel ? "oxford" : "model",
        knownLevel,
        rank,
        index
      });
    }
  }

  return [...candidatesByKey.values()]
    .sort((a, b) => {
      if (a.knownLevel !== b.knownLevel) {
        return a.knownLevel ? -1 : 1;
      }
      if (a.rank !== b.rank) {
        return b.rank - a.rank;
      }
      return a.index - b.index;
    })
    .slice(0, safeLimit)
    .map(({ word, lemma, cefr, source }) => ({
      word,
      lemma,
      cefr,
      source
    }));
}

function applyLocalCefrLevels(entries) {
  return (Array.isArray(entries) ? entries : []).map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const localLevel = lookupLocalCefrLevel(item.word, item.lemma);
    if (localLevel === "unknown") {
      return item;
    }
    return {
      ...item,
      cefr: localLevel
    };
  });
}

function buildFallbackDefinition(word, pos = "other") {
  if (pos === "verb") {
    return "To do an action in a formal or careful way.";
  }
  if (pos === "noun") {
    return "A formal word for a thing, person, or idea.";
  }
  if (pos === "adj") {
    return "Used to describe something in formal English.";
  }
  if (pos === "adv") {
    return "Used to describe how an action happens.";
  }
  return `A higher-level English word: "${word}".`;
}

function buildFallbackExample(word, pos = "other", lemma = "") {
  if (pos === "verb") {
    const action = normalizeWordKey(lemma || word) || "act";
    return `Leaders ${action} with care during hard talks.`;
  }
  if (pos === "noun") {
    return `The report used "${word}" to explain the main idea.`;
  }
  if (pos === "adj") {
    return `This is a "${word}" plan for a hard problem.`;
  }
  if (pos === "adv") {
    return `She spoke "${word}" during the meeting.`;
  }
  return `People use "${word}" in formal English writing.`;
}

function buildFallbackWordEntriesFromCandidates(
  candidates,
  wordLimit = 12,
  wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD
) {
  const safeLimit = Math.max(1, Math.min(Number(wordLimit) || 12, 16));
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const seen = new Set();
  const result = [];

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const word = String(candidate?.word || "").trim();
    if (!word) {
      continue;
    }
    const key = normalizeWordKey(word);
    if (!key || seen.has(key)) {
      continue;
    }
    const lemma = normalizeLemma(candidate?.lemma || word);
    const cefr = normalizeCefrLevel(candidate?.cefr);
    if (!isCefrAtOrAboveThreshold(cefr, threshold)) {
      continue;
    }
    if (isExcludedWordToken(word, lemma)) {
      continue;
    }
    const pos = normalizePosValue(candidate?.pos, word);
    seen.add(key);
    result.push({
      word,
      lemma,
      pos,
      cefr,
      definition_simple: buildFallbackDefinition(word, pos),
      example_simple: buildFallbackExample(word, pos, lemma)
    });
    if (result.length >= safeLimit) {
      break;
    }
  }

  return result;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isWordEntryAtOrAboveThreshold(item, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  if (!item || typeof item !== "object") {
    return false;
  }
  const cefr = normalizeCefrLevel(item.cefr);
  return (
    isCefrAtOrAboveThreshold(cefr, wordLevelThreshold) &&
    hasText(item.definition_simple) &&
    hasText(item.example_simple)
  );
}

function keepWordsAtOrAboveThreshold(entries, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  return (entries || []).filter((item) => isWordEntryAtOrAboveThreshold(item, wordLevelThreshold));
}

function normalizeAndCompleteWordEntries(entries, wordLimit = 12, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  return normalizeWordEntriesWithFallback(entries, wordLimit, wordLevelThreshold);
}

function filterResultByWordLevel(result, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  const safe = normalizeResultShape(result && typeof result === "object" ? { ...result } : {});
  safe.a2_plus_words = keepWordsAtOrAboveThreshold(safe.a2_plus_words, wordLevelThreshold);
  return safe;
}

function normalizeWordEntriesWithFallback(
  entries,
  wordLimit = 12,
  wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD
) {
  const safeLimit = Math.max(1, Math.min(Number(wordLimit) || 12, 16));
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const seen = new Set();
  const result = [];

  for (const item of Array.isArray(entries) ? entries : []) {
    const word = String(item?.word || "").trim();
    if (!word) {
      continue;
    }
    const key = normalizeWordKey(word);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);

    const lemma = normalizeLemma(item?.lemma || word);
    if (isExcludedWordToken(word, lemma)) {
      continue;
    }
    const pos = normalizePosValue(item?.pos, word);
    const cefr = normalizeCefrLevel(item?.cefr);
    const definition = hasText(item?.definition_simple)
      ? String(item.definition_simple).trim()
      : buildFallbackDefinition(word, pos);
    const example = hasText(item?.example_simple)
      ? String(item.example_simple).trim()
      : buildFallbackExample(word, pos, lemma);

    result.push({
      word,
      lemma,
      pos,
      cefr,
      definition_simple: definition,
      example_simple: example
    });

    if (result.length >= safeLimit) {
      break;
    }
  }

  return keepWordsAtOrAboveThreshold(result, threshold);
}

function normalizeLemma(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) {
    return "";
  }
  if (text === "has" || text === "had" || text === "having") {
    return "have";
  }
  if (text === "is" || text === "am" || text === "are" || text === "was" || text === "were" || text === "been") {
    return "be";
  }
  if (text === "does" || text === "did" || text === "done") {
    return "do";
  }
  if (text.endsWith("ies") && text.length > 4) {
    return `${text.slice(0, -3)}y`;
  }
  if (text.endsWith("ing") && text.length > 5) {
    return text.slice(0, -3);
  }
  if (text.endsWith("ed") && text.length > 4) {
    return text.slice(0, -2);
  }
  if (text.endsWith("es") && text.length > 4) {
    return text.slice(0, -2);
  }
  if (text.endsWith("s") && text.length > 3) {
    return text.slice(0, -1);
  }
  return text;
}

function normalizePosValue(pos, word) {
  const normalized = String(pos || "").trim().toLowerCase();
  if (POS_VALUE_SET.has(normalized)) {
    return normalized;
  }
  const value = normalizeWordKey(word);
  if (!value) {
    return "other";
  }
  if (value.endsWith("ly")) {
    return "adv";
  }
  if (/(ing|ed|en|ize|ise|ify)$/.test(value)) {
    return "verb";
  }
  if (/(ous|ful|less|able|ible|al|ic|ive)$/.test(value)) {
    return "adj";
  }
  if (/(tion|sion|ment|ness|ity|ship)$/.test(value)) {
    return "noun";
  }
  return "other";
}

function normalizeCefrLevel(value) {
  const cefr = String(value || "").trim().toUpperCase();
  if (cefr === "A1" || cefr === "A2" || cefr === "B1" || cefr === "B2" || cefr === "C1" || cefr === "C2") {
    return cefr;
  }
  return "unknown";
}

function isCefrAtOrAboveThreshold(cefr, wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  const normalizedLevel = normalizeWordLevelThreshold(wordLevelThreshold);
  const currentRank = CEFR_RANK[String(cefr || "unknown")] || 0;
  const minRank = CEFR_RANK[normalizedLevel] || CEFR_RANK[DEFAULT_WORD_LEVEL_THRESHOLD];
  return currentRank >= minRank;
}

function getLevelsBelowThreshold(wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD) {
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const thresholdRank = CEFR_RANK[threshold] || CEFR_RANK[DEFAULT_WORD_LEVEL_THRESHOLD];
  const allLevels = ["A1", "A2", "B1", "B2", "C1", "C2"];
  return allLevels.filter((level) => (CEFR_RANK[level] || 0) < thresholdRank);
}

function isLikelyProperNameWord(word) {
  const raw = String(word || "").trim();
  return /^[A-Z][a-z]{2,}$/.test(raw);
}

function isExcludedWordToken(word, lemma = "") {
  const key = normalizeWordKey(word);
  const lemmaKey = normalizeWordKey(lemma);
  if (!key || key.length <= 2) {
    return true;
  }
  if (LOW_VALUE_WORD_SET.has(key) || LOW_VALUE_WORD_SET.has(lemmaKey)) {
    return true;
  }
  const localLevel = lookupLocalCefrLevel(key, lemmaKey);
  if (localLevel !== "unknown" && !isCefrAtOrAboveThreshold(localLevel, WORD_DISCOVERY_BASE_THRESHOLD)) {
    return true;
  }
  if (A1_A2_WORD_SET.has(key) || A1_A2_WORD_SET.has(lemmaKey)) {
    return true;
  }
  if (isLikelyProperNameWord(word)) {
    return true;
  }
  return false;
}

async function callModelForB2PlusWords({
  clientId,
  model,
  selectedText,
  candidateHints,
  wordLimit = 18,
  wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD
}) {
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const thresholdLabel = formatWordLevelLabel(threshold);
  const belowLevels = getLevelsBelowThreshold(threshold).join(", ");
  const requiredWords = (candidateHints || [])
    .filter((item) => isCefrAtOrAboveThreshold(item?.cefr, threshold))
    .slice(0, 8)
    .map((item) => String(item.word || "").trim())
    .filter(Boolean);
  const systemPrompt = `
You extract difficult words and explain them for learners.
Return JSON only.
Return only words at ${thresholdLabel} level.
Include any part of speech: noun, verb, adjective, adverb, preposition, pronoun, determiner, conjunction.
`;
  const userPrompt = `
Return JSON only with key "a2_plus_words".

Selected text:
"""${selectedText}"""

Candidate hints (not all are hard enough):
${JSON.stringify(candidateHints || [])}

Required words to include if present:
${JSON.stringify(requiredWords)}

Rules:
1) Include only words that appear in candidate hints.
2) Include all required words when they exist in selected text.
3) Return at most ${wordLimit} entries.
4) Do not include words below ${threshold}. (${belowLevels})
5) If a candidate hint has cefr set to B2/C1/C2, keep that cefr exactly.
6) If a candidate hint has cefr as unknown, estimate cefr as B2/C1/C2.
7) Fill lemma, pos, cefr, definition_simple, example_simple.
8) definition_simple and example_simple must not be empty.
9) definition_simple must explain the word in this context in at least 5 words.
10) example_simple must be a fresh sentence (not a template) with at least 6 words.
11) Do not output generic lines like "This is a hard word in this text."
12) Do not include person names, place names, or organization names unless the word is a true difficult vocabulary item.
13) Do not start definition_simple or example_simple with "In this text".
`;
  const response = await requestResponsesApi({
    clientId,
    model,
    systemPrompt,
    userPrompt,
    schema: WORD_COVERAGE_SCHEMA,
    schemaName: "easyread_word_coverage",
    useSchema: true,
    maxOutputTokens: WORD_MAX_OUTPUT_TOKENS,
    maxAttempts: 1,
    allowSchemaFallback: false
  }).catch(() => null);

  const rawText = extractOutputText(response);
  if (rawText) {
    try {
      const parsed = parseAndNormalizeWordCoverage(rawText);
      if (parsed.length > 0) {
        return parsed;
      }
    } catch (_error) {
      // continue to recovery pass
    }
  }
  return [];
}

async function requestExplanationText({
  clientId,
  model,
  userPrompt,
  maxOutputTokens,
  requestId,
  streamTabId
}) {
  const streamEnabled = typeof streamTabId === "number" && typeof requestId === "string" && requestId.trim().length > 0;
  if (streamEnabled) {
    try {
      return await requestResponsesApiStream({
        clientId,
        model,
        systemPrompt: EXPLANATION_SYSTEM_PROMPT,
        userPrompt,
        maxOutputTokens,
        requestId: requestId.trim(),
        streamTabId
      });
    } catch (_streamError) {
      // Fallback to non-streaming response path if stream transport fails.
    }
  }

  const response = await requestResponsesApi({
    clientId,
    model,
    systemPrompt: EXPLANATION_SYSTEM_PROMPT,
    userPrompt,
    useSchema: false,
    maxOutputTokens,
    maxAttempts: 1,
    allowSchemaFallback: false
  });
  return extractOutputText(response);
}

async function requestResponsesApiStream({
  clientId,
  model,
  systemPrompt,
  userPrompt,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
  maxAttempts = 1,
  requestId,
  streamTabId
}) {
  const payload = buildResponsesPayload({
    model,
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    useSchema: false
  });
  payload.stream = true;

  return withExponentialBackoff(async () => {
    const response = await postProxyStream({
      clientId,
      path: PROXY_EXPLAIN_STREAM_PATH,
      body: {
        payload
      }
    });
    return readExplanationStream({
      response,
      requestId,
      streamTabId
    });
  }, Math.max(1, Number(maxAttempts) || 1));
}

async function readExplanationStream({ response, requestId, streamTabId }) {
  if (!response?.body) {
    throw new EasyReadError("Streaming response body was empty.", "EMPTY_STREAM");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let finalResponseObject = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    const parsed = splitSseEvents(buffer);
    buffer = parsed.remainder;

    for (const eventBlock of parsed.events) {
      const data = parseSseData(eventBlock);
      if (!data) {
        continue;
      }
      if (data === "[DONE]") {
        continue;
      }

      let eventJson;
      try {
        eventJson = JSON.parse(data);
      } catch (_parseError) {
        continue;
      }

      const delta = extractStreamDeltaText(eventJson);
      if (delta) {
        fullText += delta;
        sendExplanationStreamEvent(streamTabId, {
          requestId,
          delta
        });
      }

      const completed = extractCompletedResponse(eventJson);
      if (completed) {
        finalResponseObject = completed;
      }
    }
  }

  if (buffer.trim()) {
    const data = parseSseData(buffer.trim());
    if (data && data !== "[DONE]") {
      try {
        const eventJson = JSON.parse(data);
        const delta = extractStreamDeltaText(eventJson);
        if (delta) {
          fullText += delta;
          sendExplanationStreamEvent(streamTabId, {
            requestId,
            delta
          });
        }
        const completed = extractCompletedResponse(eventJson);
        if (completed) {
          finalResponseObject = completed;
        }
      } catch (_parseError) {
        // Ignore trailing partial event.
      }
    }
  }

  if (!fullText && finalResponseObject) {
    fullText = extractOutputText(finalResponseObject) || "";
  }

  sendExplanationStreamEvent(streamTabId, {
    requestId,
    done: true
  });

  if (!fullText.trim()) {
    throw new EasyReadError("Model returned no explanation text. Please try again.", "EMPTY_OUTPUT");
  }

  return fullText.trim();
}

function splitSseEvents(buffer) {
  const events = [];
  let working = String(buffer || "");
  let markerIndex = working.indexOf("\n\n");
  while (markerIndex >= 0) {
    events.push(working.slice(0, markerIndex));
    working = working.slice(markerIndex + 2);
    markerIndex = working.indexOf("\n\n");
  }
  return {
    events,
    remainder: working
  };
}

function parseSseData(eventBlock) {
  const lines = String(eventBlock || "").split("\n");
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  return dataLines.join("\n").trim();
}

function extractStreamDeltaText(eventJson) {
  if (!eventJson || typeof eventJson !== "object") {
    return "";
  }

  if (typeof eventJson.delta === "string") {
    return eventJson.delta;
  }
  if (typeof eventJson.text === "string" && /delta/i.test(String(eventJson.type || ""))) {
    return eventJson.text;
  }
  if (typeof eventJson?.output_text?.delta === "string") {
    return eventJson.output_text.delta;
  }

  return "";
}

function extractCompletedResponse(eventJson) {
  if (!eventJson || typeof eventJson !== "object") {
    return null;
  }

  if (eventJson.response && typeof eventJson.response === "object") {
    const type = String(eventJson.type || "");
    if (type.includes("completed") || type.includes("done")) {
      return eventJson.response;
    }
  }

  return null;
}

function sendExplanationStreamEvent(tabId, payload) {
  if (typeof tabId !== "number") {
    return;
  }
  chrome.tabs.sendMessage(
    tabId,
    {
      type: "easyread-explanation-stream",
      ...payload
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

async function requestResponsesApi({
  clientId,
  model,
  systemPrompt,
  userPrompt,
  schema = EASYREAD_JSON_SCHEMA,
  schemaName = "easyread_output",
  useSchema = true,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
  maxAttempts = 1,
  allowSchemaFallback = true
}) {
  const payload = buildResponsesPayload({
    model,
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    schema,
    schemaName,
    useSchema
  });

  try {
    return await postResponsesPayload({ clientId, payload, maxAttempts });
  } catch (error) {
    const schemaIssue =
      allowSchemaFallback &&
      useSchema &&
      error instanceof EasyReadError &&
      error.code === "PROXY_ERROR" &&
      /text\.format|json_schema|schema|strict/i.test(error.message);
    if (!schemaIssue) {
      throw error;
    }

    const fallbackPayload = { ...payload };
    delete fallbackPayload.text;
    return postResponsesPayload({ clientId, payload: fallbackPayload, maxAttempts });
  }
}

function buildResponsesPayload({
  model,
  systemPrompt,
  userPrompt,
  maxOutputTokens,
  schema = EASYREAD_JSON_SCHEMA,
  schemaName = "easyread_output",
  useSchema = true
}) {
  const payload = {
    model,
    store: false,
    max_output_tokens: maxOutputTokens,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userPrompt }]
      }
    ]
  };

  if (useSchema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: schemaName,
        schema,
        strict: true
      }
    };
  }

  return payload;
}

async function postResponsesPayload({ clientId, payload, maxAttempts = 1 }) {
  return withExponentialBackoff(async () => {
    return postProxyJson({
      clientId,
      path: PROXY_EXPLAIN_PATH,
      body: {
        payload
      }
    });
  }, Math.max(1, Number(maxAttempts) || 1));
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

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new EasyReadError("Words request timed out.", "WORD_TIMEOUT"));
        }, Math.max(1000, Number(timeoutMs) || WORD_FETCH_TIMEOUT_MS));
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function enforceEasyLanguage(result, selectedText) {
  const base = result && typeof result === "object" ? result : {};
  const normalized = {
    simple_explanation: simplifyToEasyText(base.simple_explanation, selectedText),
    a2_plus_words: Array.isArray(base.a2_plus_words) ? base.a2_plus_words : [],
    notes: simplifyNoteText(base.notes || ""),
    confidence: normalizeDisplayConfidence(base.confidence, base.notes, base.simple_explanation)
  };

  normalized.a2_plus_words = normalized.a2_plus_words.map((item) => ({
    ...item,
    definition_simple: normalizeMeaningForDisplay(item?.definition_simple || "", item?.word || "", item?.lemma || ""),
    example_simple: normalizeExampleForDisplay(
      item?.example_simple || "",
      item?.word || "",
      item?.lemma || "",
      item?.definition_simple || ""
    )
  }));

  return normalized;
}

function normalizeMeaningForDisplay(rawText, word, lemma) {
  let cleaned = simplifyToEasyText(rawText, "");
  cleaned = cleaned
    .replace(/^in this text[:,]?\s*/i, "")
    .replace(/^this word means\s+/i, "")
    .replace(/^the word means\s+/i, "")
    .replace(/^this word has a special meaning\.?$/i, "")
    .replace(/^this word has a hard meaning\.?$/i, "")
    .trim();

  cleaned = String(cleaned).replace(/^in this text[:,]?\s*/i, "").trim();
  if (cleaned && !/[.!?]$/.test(cleaned)) {
    cleaned = `${cleaned}.`;
  }
  return cleaned;
}

function normalizeExampleForDisplay(rawText, word, lemma, definitionText = "") {
  let cleaned = simplifyToEasyText(rawText, "");
  cleaned = cleaned
    .replace(/^in this text[:,]?\s*/i, "")
    .replace(/^example:\s*/i, "")
    .trim();

  if (!cleaned || /^(this word|the word)\s+/i.test(cleaned)) {
    return "";
  }
  cleaned = String(cleaned).replace(/^in this text[:,]?\s*/i, "").trim();
  if (cleaned && !/[.!?]$/.test(cleaned)) {
    cleaned = `${cleaned}.`;
  }
  return cleaned;
}

function normalizeDisplayConfidence(rawValue, notes, explanation) {
  const lowerNotes = String(notes || "").toLowerCase();
  const hasBackupSignal =
    lowerNotes.includes("backup mode") ||
    lowerNotes.includes("fallback") ||
    lowerNotes.includes("model problem");
  const hasExplanation = hasText(explanation);

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    let confidence = Math.max(0, Math.min(1, rawValue));
    if (hasBackupSignal) {
      confidence = Math.min(confidence, 0.35);
    } else if (confidence <= 0.5 && hasExplanation) {
      confidence = 0.72;
    }
    return Number(confidence.toFixed(2));
  }

  if (hasBackupSignal) {
    return 0.35;
  }
  if (hasExplanation) {
    return 0.78;
  }
  return 0.5;
}

function simplifyToEasyText(text, selectedText) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  let source = raw;
  if ((/^\s*\{/.test(raw) || raw.includes('"simple_explanation"')) && !selectedText) {
    const extracted = extractExplanationFromRawText(raw);
    if (hasText(extracted)) {
      source = extracted;
    }
  }

  let simplified = applyEasyWordReplacements(source);
  simplified = simplified.replace(/\s+/g, " ").trim();

  if (!simplified) {
    return "";
  }

  if (selectedText && isExplanationTooCloseToSource(simplified, selectedText)) {
    return "";
  }

  return simplified;
}

function simplifyNoteText(note) {
  const raw = String(note || "").trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();

  if (lower.includes("easyread stopped after multiple retries")) {
    return "";
  }
  if (lower.includes("easyread used fallback mode") && lower.includes("repeated the original text")) {
    return "";
  }
  if (lower.includes("easyread used fallback mode") && lower.includes("returned empty explanation text")) {
    return "";
  }
  if (lower.includes("easyread used fallback mode") && (lower.includes("cut off") || lower.includes("incomplete"))) {
    return "";
  }
  if (
    lower.includes("easyread used fallback mode") &&
    (lower.includes("json formatting failed") || lower.includes("json"))
  ) {
    return "";
  }
  if (
    lower.includes("easyread used fallback mode") ||
    lower.includes("easyread filled a backup explanation")
  ) {
    return "";
  }
  if (lower.includes("no words above b1")) {
    return "EasyRead did not find clear hard words.";
  }

  return simplifyToEasyText(raw, "");
}

function applyEasyWordReplacements(text) {
  let result = String(text || "");
  const entries = Object.entries(EASY_WORD_REPLACEMENTS).sort((a, b) => b[0].length - a[0].length);
  for (const [hardWord, easyWord] of entries) {
    const pattern = new RegExp(`\\b${escapeRegExp(hardWord)}\\b`, "gi");
    result = result.replace(pattern, easyWord);
  }
  return result;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeModelExplanationText(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw) {
    return "";
  }
  let cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }
  if (cleaned.length > 1500) {
    cleaned = `${cleaned.slice(0, 1500).trim()}...`;
  }
  return cleaned;
}

function extractExplanationFromRawText(rawText) {
  const cleaned = normalizeModelExplanationText(rawText);
  if (!cleaned) {
    return "";
  }

  // If the model returned JSON text (or truncated JSON), extract the field value.
  if (/^\s*\{/.test(cleaned) || cleaned.includes('"simple_explanation"')) {
    const extracted = extractSimpleExplanationField(cleaned);
    if (hasText(extracted)) {
      return extracted;
    }
  }

  return cleaned;
}

function extractSimpleExplanationField(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return "";
  }

  // Complete JSON string value.
  const fullMatch = text.match(/"simple_explanation"\s*:\s*"((?:\\.|[^"\\])*)"/s);
  if (fullMatch?.[1]) {
    const decoded = decodeJsonStringLike(fullMatch[1]);
    if (hasText(decoded)) {
      return decoded;
    }
  }

  // Truncated JSON value without a closing quote.
  const partialMatch = text.match(/"simple_explanation"\s*:\s*"([\s\S]*)$/);
  if (partialMatch?.[1]) {
    const fragment = partialMatch[1]
      .replace(/"\s*,\s*"(notes|confidence|a2_plus_words)"[\s\S]*$/i, "")
      .replace(/[}\]]+\s*$/g, "")
      .trim();
    const decoded = decodeJsonStringLike(fragment);
    if (hasText(decoded)) {
      return decoded;
    }
  }

  return "";
}

function decodeJsonStringLike(value) {
  const raw = String(value || "");
  if (!raw) {
    return "";
  }

  // Try JSON decode first.
  try {
    return JSON.parse(`"${raw}"`).trim();
  } catch (_error) {
    // Best-effort unescape for truncated/invalid JSON fragments.
    return raw
      .replace(/\\"/g, '"')
      .replace(/\\n/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\r/g, " ")
      .replace(/\\\\/g, "\\")
      .replace(/\s+/g, " ")
      .trim();
  }
}

function isExplanationTooCloseToSource(explanation, selectedText) {
  const explanationNorm = normalizeSimilarityText(explanation);
  const sourceNorm = normalizeSimilarityText(selectedText);

  if (!explanationNorm || !sourceNorm) {
    return false;
  }

  if (explanationNorm === sourceNorm) {
    return true;
  }

  if (explanationNorm.length >= 70 && sourceNorm.includes(explanationNorm)) {
    return true;
  }

  const explanationTokens = explanationNorm.split(" ").filter(Boolean);
  const sourceTokens = sourceNorm.split(" ").filter(Boolean);
  if (explanationTokens.length < 8 || sourceTokens.length < 8) {
    return false;
  }

  const source4Grams = buildNgramSet(sourceTokens, 4);
  if (source4Grams.size === 0) {
    return false;
  }

  let overlap = 0;
  const explanation4Grams = buildNgramSet(explanationTokens, 4);
  for (const gram of explanation4Grams) {
    if (source4Grams.has(gram)) {
      overlap += 1;
    }
  }
  const overlapRatio = explanation4Grams.size > 0 ? overlap / explanation4Grams.size : 0;
  return explanationTokens.length >= 20 && overlapRatio >= 0.55;
}

function normalizeSimilarityText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildNgramSet(tokens, n) {
  const set = new Set();
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length < n) {
    return set;
  }
  for (let i = 0; i <= list.length - n; i += 1) {
    set.add(list.slice(i, i + n).join(" "));
  }
  return set;
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

function buildProxyUrl(path) {
  return `${PROXY_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function warmProxyConnection(force = false) {
  const now = Date.now();
  if (!force && now - lastProxyWarmupAt < WARMUP_COOLDOWN_MS) {
    return false;
  }
  if (proxyWarmupInFlight) {
    return proxyWarmupInFlight;
  }

  proxyWarmupInFlight = (async () => {
    try {
      const response = await fetch(buildProxyUrl(PROXY_HEALTH_PATH), {
        method: "GET",
        cache: "no-store"
      });
      return response.ok;
    } catch (_error) {
      return false;
    } finally {
      lastProxyWarmupAt = Date.now();
      proxyWarmupInFlight = null;
    }
  })();

  return proxyWarmupInFlight;
}

async function postProxyJson({ clientId, path, body }) {
  let response;
  try {
    response = await fetch(buildProxyUrl(path), {
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

async function postProxyStream({ clientId, path, body }) {
  let response;
  try {
    response = await fetch(buildProxyUrl(path), {
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

  return response;
}

function toUserErrorMessage(error) {
  if (error instanceof EasyReadError) {
    return error.message;
  }
  return "EasyRead failed. Please try again.";
}
