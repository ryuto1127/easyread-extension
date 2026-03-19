import { A1_A2_WORD_SET } from "./data/a1a2Words.js";
import { CEFR_WORD_LEVEL_MAP } from "./data/cefrWordLevels.js";
import { EASYREAD_JSON_SCHEMA, MODEL_VERSION, WORD_LEVEL_VALUES } from "./lib/constants.js";
import {
  parseAndNormalizeWordCoverage,
  extractOutputText,
  isOutputUsable,
  normalizeWordEntries
} from "./lib/schema.js";
import {
  buildWordCefrCacheKey,
  buildWordDefinitionCacheKey,
  clearCache,
  getCachedResponse,
  getSettings,
  getWordCefrCacheMap,
  getWordDefinitionCacheMap,
  pruneExpiredCacheEntries,
  pruneExpiredWordCefrEntries,
  pruneExpiredWordDefinitionEntries,
  saveWordCefrDecisions,
  saveWordDefinitions,
  saveCachedResponse,
  saveSettings
} from "./lib/storage.js";

const PROXY_BASE_URL = "https://easyread-extension.onrender.com";
const PROXY_EXPLAIN_PATH = "/api/explain";
const PROXY_EXPLAIN_STREAM_PATH = "/api/explain-stream";
const PROXY_HEALTH_PATH = "/api/health";
const CONTEXT_MENU_ID = "easyread_explain";
const EXPLAIN_MODEL = "gpt-5-mini";
const WORDS_MODEL = "gpt-4o-mini";
const ACTION_BADGE_OFF_COLOR = "#94a3b8";
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
const WORD_FETCH_TIMEOUT_MS = 12000;
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
  const settings = await ensureSettings();
  await pruneExpiredCacheEntries();
  await pruneExpiredWordDefinitionEntries();
  await pruneExpiredWordCefrEntries();
  await syncActionState(settings);
  await createContextMenu(settings);
  if (normalizeEnabledValue(settings.enabled, true)) {
    void warmProxyConnection(true);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await ensureSettings();
  await pruneExpiredWordDefinitionEntries();
  await pruneExpiredWordCefrEntries();
  await syncActionState(settings);
  await createContextMenu(settings);
  if (normalizeEnabledValue(settings.enabled, true)) {
    void warmProxyConnection(true);
  }
});

chrome.action.onClicked.addListener(async () => {
  const settings = await getSettings();
  await updateRuntimeSettings({
    enabled: !normalizeEnabledValue(settings.enabled, true)
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) {
    return;
  }
  const settings = await getSettings();
  if (!normalizeEnabledValue(settings.enabled, true)) {
    return;
  }

  safeSendTabMessage(tab.id, {
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

  if (message?.type === "easyread-refilter-words") {
    handleRefilterWordsRequest(message.payload || {})
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
        sendResponse({
          ok: true,
          data: {
            enabled: normalizeEnabledValue(settings.enabled, true),
            hasSeenOnboarding: normalizeBooleanValue(settings.hasSeenOnboarding, false),
            wordLevelThreshold: normalizeWordLevelThreshold(settings.wordLevelThreshold),
            showExplanation: visibility.showExplanation,
            showWords: visibility.showWords
          }
        });
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
    getSettings()
      .then((settings) => {
        if (!normalizeEnabledValue(settings.enabled, true)) {
          return false;
        }
        return warmProxyConnection();
      })
      .then((warmed) => sendResponse({ ok: true, warmed: Boolean(warmed) }))
      .catch(() => sendResponse({ ok: true, warmed: false }));
    return true;
  }

  return false;
});

async function ensureSettings() {
  const settings = await getSettings();
  const visibility = normalizeVisibilityPair(settings);
  const next = {
    ...settings,
    enabled: normalizeEnabledValue(settings.enabled, true),
    hasSeenOnboarding: normalizeBooleanValue(settings.hasSeenOnboarding, false),
    wordLevelThreshold: normalizeWordLevelThreshold(settings.wordLevelThreshold),
    showExplanation: visibility.showExplanation,
    showWords: visibility.showWords
  };
  await saveSettings(next);
  return next;
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
    enabled: normalizeEnabledValue(patch.enabled ?? current.enabled, true),
    hasSeenOnboarding: normalizeBooleanValue(
      patch.hasSeenOnboarding ?? current.hasSeenOnboarding,
      false
    ),
    wordLevelThreshold: normalizeWordLevelThreshold(patch.wordLevelThreshold ?? current.wordLevelThreshold),
    showExplanation: visibility.showExplanation,
    showWords: visibility.showWords
  };
  await saveSettings(next);
  await syncActionState(next);
  await createContextMenu(next);
  if (next.enabled && !normalizeEnabledValue(current.enabled, true)) {
    void warmProxyConnection(true);
  }
  return {
    enabled: next.enabled,
    hasSeenOnboarding: next.hasSeenOnboarding,
    wordLevelThreshold: next.wordLevelThreshold,
    showExplanation: next.showExplanation,
    showWords: next.showWords
  };
}

async function createContextMenu(settingsOverride = null) {
  await chrome.contextMenus.removeAll();
  const settings = settingsOverride || await getSettings();
  if (!normalizeEnabledValue(settings.enabled, true)) {
    return;
  }
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: "Explain in Simple English",
    contexts: ["selection"]
  });
}

async function syncActionState(settingsOverride = null) {
  const settings = settingsOverride || await getSettings();
  const enabled = normalizeEnabledValue(settings.enabled, true);
  await Promise.all([
    chrome.action.setBadgeText({ text: enabled ? "" : "OFF" }),
    chrome.action.setBadgeBackgroundColor({
      color: enabled ? "#0f766e" : ACTION_BADGE_OFF_COLOR
    }),
    chrome.action.setTitle({
      title: enabled
        ? "EasyRead is on. Click to turn it off."
        : "EasyRead is off. Click to turn it on."
    })
  ]);
}

async function handleExplainRequest(payload, sender) {
  const settings = await getSettings();
  ensureExtensionEnabled(settings);
  const selectedText = normalizeSelection(payload.selectedText);
  const requestId = normalizeRequestId(payload.requestId);
  const explanationMode = normalizeExplanationMode(payload.explanationMode);
  const wordLevelThreshold = normalizeWordLevelThreshold(settings.wordLevelThreshold);
  const discoveryThreshold = WORD_DISCOVERY_BASE_THRESHOLD;
  const baseResult =
    payload?.baseResult && typeof payload.baseResult === "object"
      ? normalizeResultShape(payload.baseResult)
      : null;

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
    const safeCached = mergeWordState(
      enforceEasyLanguage(
        {
          ...safeCachedRaw,
          a2_plus_words: Array.isArray(safeCachedRaw.a2_plus_words) ? safeCachedRaw.a2_plus_words : []
        },
        selectedText
      ),
      baseResult
    );
    if (!isOutputUsable(safeCached)) {
      // Ignore invalid cached payload and fetch a fresh model result.
    } else {
      const filteredCached = filterResultByWordLevel(safeCached, wordLevelThreshold);
      const cachedHasResolvedWords = hasResolvedWordsResult(safeCached);
      if (!cachedHasResolvedWords) {
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
  const immediateResult = enforceEasyLanguage(
    {
      ...explanationOnly.parsed,
      a2_plus_words: []
    },
    selectedText
  );
  const safeImmediateResult = mergeWordState(normalizeResultShape(immediateResult), baseResult);

  if (!isOutputUsable(safeImmediateResult)) {
    throw new EasyReadError("Model did not return a usable explanation. Please try again.", "EMPTY_RESULT");
  }

  const wordsPending = !hasResolvedWordsResult(safeImmediateResult) && explanationOnly.candidateCount > 0;

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
    result: filterResultByWordLevel(safeImmediateResult, wordLevelThreshold),
    requestId,
    wordsPending,
    explanationMode,
    wordLevelThreshold
  };
}

async function handleFetchWordsRequest(payload, _sender) {
  const settings = await getSettings();
  ensureExtensionEnabled(settings);
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
  const wordsModel = WORDS_MODEL;
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

  let candidates = extractWordCandidates(selectedText, discoveryThreshold, MAX_A2_CANDIDATES);
  if (candidates.length === 0) {
    candidates = extractDatasetWordCandidates(selectedText, discoveryThreshold, MAX_A2_CANDIDATES);
  }
  if (candidates.length === 0) {
    const noWordsResult = enforceEasyLanguage(
      {
        ...baseResult,
        a2_plus_words: [],
        detected_words: [],
        words_status: "ready",
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
  const wordTimeoutMs = getWordFetchTimeoutMs(candidates.length, wordLimit);
  let modelWords = [];
  let wordsError = "";
  try {
    modelWords = await withTimeout(
      callModelForB2PlusWords({
        clientId,
        model: wordsModel,
        selectedText,
        candidateHints: candidates,
        wordLimit,
        wordLevelThreshold: discoveryThreshold
      }),
      wordTimeoutMs
    );
  } catch (error) {
    const normalizedError = normalizeWordsErrorMessage(error);
    if (shouldFallbackToExplainWordsModel(normalizedError)) {
      try {
        modelWords = await withTimeout(
          callModelForB2PlusWords({
            clientId,
            model: EXPLAIN_MODEL,
            selectedText,
            candidateHints: candidates,
            wordLimit,
            wordLevelThreshold: discoveryThreshold
          }),
          wordTimeoutMs
        );
        wordsError = "";
      } catch (fallbackError) {
        modelWords = [];
        wordsError = normalizeWordsErrorMessage(fallbackError);
      }
    } else {
      modelWords = [];
      wordsError = normalizedError;
    }
  }
  if (!wordsError && (!Array.isArray(modelWords) || modelWords.length === 0) && candidates.length > 0) {
    wordsError = "EMPTY_MODEL_OUTPUT";
  }
  const [definitionCacheMap, cefrCacheMap] = await Promise.all([
    getWordDefinitionCacheMap(),
    getWordCefrCacheMap()
  ]);
  const wordEntries = buildWordEntriesFromCandidates({
    candidates,
    modelEntries: applyLocalCefrLevels(modelWords),
    definitionCacheMap,
    cefrCacheMap,
    wordLimit,
    wordLevelThreshold: discoveryThreshold
  });
  let finalWordItems = normalizeAndCompleteWordEntries(wordEntries, wordLimit, discoveryThreshold);
  if (finalWordItems.length === 0 && Array.isArray(modelWords) && modelWords.length > 0) {
    finalWordItems = normalizeAndCompleteWordEntries(
      applyLocalCefrLevels(modelWords),
      wordLimit,
      discoveryThreshold
    );
    if (finalWordItems.length === 0 && !wordsError) {
      wordsError = "NO_USABLE_WORD_ENTRIES";
    }
  }
  if (finalWordItems.length > 0) {
    await Promise.all([saveWordDefinitions(finalWordItems), saveWordCefrDecisions(finalWordItems)]);
  }

  const wordsUnavailable = candidates.length > 0 && finalWordItems.length === 0;
  const finalResult = enforceEasyLanguage(
    {
      ...baseResult,
      a2_plus_words: finalWordItems,
      detected_words: candidates.map((item) => String(item?.word || "").trim()).filter(Boolean),
      notes: wordsUnavailable
        ? appendNote(baseResult.notes || "", "Words were found, but definitions could not load. Please click Explain again.")
        : baseResult.notes || "",
      words_status: wordsUnavailable ? "definitions_unavailable" : "ready",
      words_error: wordsError
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

async function handleRefilterWordsRequest(payload) {
  const settings = await getSettings();
  ensureExtensionEnabled(settings);
  const selectedText = normalizeSelection(payload.selectedText);
  const requestId = normalizeRequestId(payload.requestId);
  const explanationMode = normalizeExplanationMode(payload.explanationMode);
  const wordLevelThreshold = normalizeWordLevelThreshold(settings.wordLevelThreshold);
  const discoveryThreshold = WORD_DISCOVERY_BASE_THRESHOLD;

  let sourceResult =
    payload?.baseResult && typeof payload.baseResult === "object"
      ? normalizeResultShape(payload.baseResult)
      : null;

  if (selectedText) {
    const pageOrigin = getPageOrigin(payload.pageUrl, payload.pageOrigin);
    const cacheKey = await buildCacheKey({
      pageOrigin,
      selectedText,
      explanationMode,
      wordLevelThreshold: discoveryThreshold,
      model: EXPLAIN_MODEL,
      modelVersion: MODEL_VERSION
    });
    const cached = await getCachedResponse(cacheKey);
    if (cached && typeof cached === "object") {
      sourceResult = normalizeResultShape(cached);
    }
  }

  const safeSource = normalizeResultShape(
    sourceResult || {
      simple_explanation: "",
      a2_plus_words: [],
      notes: "",
      confidence: 0.5
    }
  );
  const filtered = filterResultByWordLevel(safeSource, wordLevelThreshold);

  return {
    cached: true,
    result: filtered,
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

function normalizeBooleanValue(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  return Boolean(fallback);
}

function normalizeEnabledValue(value, fallback = true) {
  return normalizeBooleanValue(value, fallback);
}

function normalizeVisibilityValue(value, fallback = true) {
  if (typeof value === "boolean") {
    return value;
  }
  return Boolean(fallback);
}

function normalizeVisibilityPair(values) {
  let showExplanation = normalizeVisibilityValue(values?.showExplanation, false);
  let showWords = normalizeVisibilityValue(values?.showWords, true);
  if (!showExplanation && !showWords) {
    showWords = true;
  }
  return {
    showExplanation,
    showWords
  };
}

function shouldFallbackToExplainWordsModel(wordsError) {
  return WORDS_MODEL !== EXPLAIN_MODEL && wordsError === "REQUEST_INVALID";
}

function ensureExtensionEnabled(settings) {
  if (!normalizeEnabledValue(settings?.enabled, true)) {
    throw new EasyReadError("EasyRead is turned off. Turn it on from the extension popup.", "DISABLED");
  }
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
  if (!Array.isArray(base.detected_words)) {
    base.detected_words = [];
  } else {
    base.detected_words = base.detected_words
      .map((word) => String(word || "").trim())
      .filter(Boolean);
  }
  if (typeof base.simple_explanation !== "string") {
    base.simple_explanation = "";
  } else {
    base.simple_explanation = base.simple_explanation.trim();
  }
  if (typeof base.words_status !== "string") {
    base.words_status = "";
  }
  if (typeof base.words_error !== "string") {
    base.words_error = "";
  }
  if (typeof base.notes !== "string") {
    base.notes = "";
  }
  if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) {
    base.confidence = 0.5;
  }
  return base;
}

function mergeWordState(result, source) {
  const next = normalizeResultShape(result);
  const prior = source && typeof source === "object" ? normalizeResultShape(source) : null;
  if (!prior) {
    return next;
  }

  if (next.a2_plus_words.length === 0 && prior.a2_plus_words.length > 0) {
    next.a2_plus_words = prior.a2_plus_words;
  }
  if (next.detected_words.length === 0 && prior.detected_words.length > 0) {
    next.detected_words = prior.detected_words;
  }
  if (!next.words_status && prior.words_status) {
    next.words_status = prior.words_status;
  }
  if (!next.words_error && prior.words_error) {
    next.words_error = prior.words_error;
  }
  return next;
}

function hasResolvedWordsResult(result) {
  const safe = normalizeResultShape(result);
  return safe.a2_plus_words.length > 0 || safe.words_status === "ready" || safe.words_status === "definitions_unavailable";
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

function getWordFetchTimeoutMs(candidateCount, wordLimit) {
  const count = Math.max(1, Number(candidateCount) || 1);
  const limit = Math.max(1, Number(wordLimit) || 1);
  const dynamic = 14000 + count * 1500 + limit * 500;
  return Math.max(22000, Math.min(45000, dynamic));
}

function getWordOutputTokenBudget(wordLimit, snippetLength = 0) {
  const limit = Math.max(1, Number(wordLimit) || 1);
  const snippet = Math.max(0, Number(snippetLength) || 0);
  const dynamic = 900 + limit * 170 + Math.min(220, Math.floor(snippet * 0.2));
  return Math.max(950, Math.min(1800, dynamic));
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
  const normalizedWordLemma = normalizeLemma(wordKey);
  const normalizedLemma = normalizeLemma(lemmaKey);
  const surfaceLevel = getExactLocalCefrLevel(wordKey);
  const lemmaLevel = getExactLocalCefrLevel(lemmaKey);
  const normalizedWordLevel = getExactLocalCefrLevel(normalizedWordLemma);
  const normalizedLemmaLevel = getExactLocalCefrLevel(normalizedLemma);

  if (shouldPreferLemmaCefr(wordKey, lemmaKey || normalizedWordLemma)) {
    return (
      lemmaLevel !== "unknown"
        ? lemmaLevel
        : normalizedLemmaLevel !== "unknown"
          ? normalizedLemmaLevel
          : normalizedWordLevel !== "unknown"
            ? normalizedWordLevel
            : surfaceLevel
    );
  }

  return (
    surfaceLevel !== "unknown"
      ? surfaceLevel
      : lemmaLevel !== "unknown"
        ? lemmaLevel
        : normalizedWordLevel !== "unknown"
          ? normalizedWordLevel
          : normalizedLemmaLevel
  );
}

function getExactLocalCefrLevel(value) {
  const key = normalizeWordKey(value);
  if (!key) {
    return "unknown";
  }
  return normalizeCefrLevel(CEFR_WORD_LEVEL_MAP[key] || "");
}

function shouldPreferLemmaCefr(word, lemma = "") {
  const wordKey = normalizeWordKey(word);
  const lemmaKey = normalizeWordKey(lemma);
  if (!wordKey || !lemmaKey || wordKey === lemmaKey) {
    return false;
  }
  return /(?:ing|ied|ed)$/.test(wordKey);
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
    if (isLikelyNameChainToken(tokens, index)) {
      continue;
    }

    const lemma = normalizeLemma(key);
    const localLevel = lookupLocalCefrLevel(key, lemma);
    const knownLevel = localLevel !== "unknown";

    if (LOW_VALUE_WORD_SET.has(key) || LOW_VALUE_WORD_SET.has(lemma)) {
      continue;
    }
    if (knownLevel) {
      if (!isCefrAtOrAboveThreshold(localLevel, threshold)) {
        continue;
      }
    } else {
      if (A1_A2_WORD_SET.has(key) || A1_A2_WORD_SET.has(lemma)) {
        continue;
      }
      if (isLikelyProperNameWord(token)) {
        continue;
      }
    }

    const rank = knownLevel ? CEFR_RANK[localLevel] || 0 : 0;
    const existing = candidatesByKey.get(key);
    if (!existing) {
      candidatesByKey.set(key, {
        word: token,
        lemma,
        cefr: knownLevel ? localLevel : "unknown",
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
        cefr: knownLevel ? localLevel : "unknown",
        source: knownLevel ? "oxford" : "model",
        knownLevel,
        rank,
        index
      });
    }
  }

  return [...candidatesByKey.values()]
    .sort((a, b) => a.index - b.index)
    .slice(0, safeLimit)
    .map(({ word, lemma, cefr, source }) => ({
      word,
      lemma,
      cefr,
      source
    }));
}

function extractDatasetWordCandidates(
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
    if (isLikelyNameChainToken(tokens, index)) {
      continue;
    }
    const lemma = normalizeLemma(key);
    const localLevel = lookupLocalCefrLevel(key, lemma);
    if (localLevel === "unknown" || !isCefrAtOrAboveThreshold(localLevel, threshold)) {
      continue;
    }
    if (LOW_VALUE_WORD_SET.has(key) || LOW_VALUE_WORD_SET.has(lemma)) {
      continue;
    }
    if (isLikelyProperNameWord(token)) {
      continue;
    }
    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        word: token,
        lemma,
        cefr: localLevel,
        source: "oxford",
        rank: CEFR_RANK[localLevel] || 0,
        index
      });
    }
  }

  return [...candidatesByKey.values()]
    .sort((a, b) => a.index - b.index)
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

function buildWordEntriesFromCandidates({
  candidates,
  modelEntries,
  definitionCacheMap,
  cefrCacheMap,
  wordLimit = 12,
  wordLevelThreshold = DEFAULT_WORD_LEVEL_THRESHOLD
}) {
  const safeLimit = Math.max(1, Math.min(Number(wordLimit) || 12, 16));
  const threshold = normalizeWordLevelThreshold(wordLevelThreshold);
  const normalizedModelEntries = Array.isArray(modelEntries) ? modelEntries : [];
  const cacheMap = definitionCacheMap && typeof definitionCacheMap === "object" ? definitionCacheMap : {};
  const levelCacheMap = cefrCacheMap && typeof cefrCacheMap === "object" ? cefrCacheMap : {};

  const modelByWord = new Map();
  const modelByLemma = new Map();
  for (const entry of normalizedModelEntries) {
    const wordKey = normalizeWordKey(entry?.word || "");
    const lemmaKey = normalizeWordKey(entry?.lemma || "");
    if (wordKey && !modelByWord.has(wordKey)) {
      modelByWord.set(wordKey, entry);
    }
    if (lemmaKey && !modelByLemma.has(lemmaKey)) {
      modelByLemma.set(lemmaKey, entry);
    }
  }

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
    const modelEntry = modelByWord.get(key) || modelByLemma.get(lemma) || null;
    const datasetCefr = normalizeCefrLevel(lookupLocalCefrLevel(word, lemma));
    const modelCefr = normalizeCefrLevel(modelEntry?.cefr);
    const cachedCefrKey = buildWordCefrCacheKey(lemma || word);
    const cachedCefr = normalizeCefrLevel(levelCacheMap[cachedCefrKey]?.cefr || "");
    const candidateCefr = normalizeCefrLevel(candidate?.cefr);
    const cefr =
      datasetCefr !== "unknown"
        ? datasetCefr
        : modelCefr !== "unknown"
          ? modelCefr
          : cachedCefr !== "unknown"
            ? cachedCefr
            : candidateCefr;
    if (!isCefrAtOrAboveThreshold(cefr, threshold)) {
      continue;
    }
    if (isExcludedWordToken(word, lemma)) {
      continue;
    }

    const cacheKey = buildWordDefinitionCacheKey(lemma, cefr);
    const cached = cacheKey ? cacheMap[cacheKey] : null;
    const definition = hasText(modelEntry?.definition_simple)
      ? String(modelEntry.definition_simple).trim()
      : hasText(cached?.definition_simple)
        ? String(cached.definition_simple).trim()
        : "";
    const example = hasText(modelEntry?.example_simple)
      ? String(modelEntry.example_simple).trim()
      : hasText(cached?.example_simple)
        ? String(cached.example_simple).trim()
        : "";
    if (!definition || !example) {
      continue;
    }

    const pos = normalizePosValue(modelEntry?.pos || cached?.pos || candidate?.pos, word);
    seen.add(key);
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
    const definition = hasText(item?.definition_simple) ? String(item.definition_simple).trim() : "";
    const example = hasText(item?.example_simple) ? String(item.example_simple).trim() : "";

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
  if (text.endsWith("ied") && text.length > 4) {
    return `${text.slice(0, -3)}y`;
  }
  if (text.endsWith("ing") && text.length > 5) {
    const stem = text.slice(0, -3);
    const candidates = [stem];
    if (endsWithDoubledConsonant(stem)) {
      candidates.unshift(stem.slice(0, -1));
    }
    candidates.push(`${stem}e`);
    return pickKnownLemmaCandidate(candidates, stem);
  }
  if (text.endsWith("ed") && text.length > 4) {
    const stem = text.slice(0, -2);
    const candidates = [stem];
    if (endsWithDoubledConsonant(stem)) {
      candidates.unshift(stem.slice(0, -1));
    }
    candidates.push(`${stem}e`);
    return pickKnownLemmaCandidate(candidates, stem);
  }
  if (text.endsWith("es") && text.length > 4) {
    const stem = text.slice(0, -2);
    return pickKnownLemmaCandidate([stem, `${stem}e`], stem);
  }
  if (text.endsWith("s") && text.length > 3) {
    const stem = text.slice(0, -1);
    return isKnownLemmaCandidate(stem) ? stem : text;
  }
  return text;
}

function pickKnownLemmaCandidate(candidates, fallback) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (isKnownLemmaCandidate(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

function isKnownLemmaCandidate(value) {
  const key = normalizeWordKey(value);
  if (!key) {
    return false;
  }
  return Boolean(CEFR_WORD_LEVEL_MAP[key] || A1_A2_WORD_SET.has(key));
}

function endsWithDoubledConsonant(value) {
  return /([b-df-hj-np-tv-z])\1$/.test(String(value || ""));
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

function isCapitalizedLexicalWord(word) {
  return /^[A-Z][a-z]{2,}$/.test(String(word || "").trim());
}

function isLikelyNameChainToken(tokens, index) {
  if (!Array.isArray(tokens) || index < 0 || index >= tokens.length) {
    return false;
  }
  const current = String(tokens[index] || "").trim();
  if (!isCapitalizedLexicalWord(current)) {
    return false;
  }
  const prev = String(tokens[index - 1] || "").trim();
  const next = String(tokens[index + 1] || "").trim();
  return isCapitalizedLexicalWord(prev) || isCapitalizedLexicalWord(next);
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

function tryParseJsonValue(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return null;
  }
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function collectWordArraysFromPayload(payload) {
  const arrays = [];
  const isWordEntryObject = (value) =>
    Boolean(
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (typeof value.word === "string" || typeof value.lemma === "string") &&
      (
        typeof value.definition_simple === "string" ||
        typeof value.example_simple === "string" ||
        typeof value.cefr === "string"
      )
    );
  const visit = (value) => {
    if (!value) {
      return;
    }
    if (Array.isArray(value)) {
      arrays.push(value);
      return;
    }
    if (typeof value === "string") {
      const parsed = tryParseJsonValue(value);
      if (parsed) {
        visit(parsed);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }

    if (isWordEntryObject(value)) {
      arrays.push([value]);
      return;
    }

    if (Array.isArray(value.a2_plus_words)) {
      arrays.push(value.a2_plus_words);
    } else if (value.a2_plus_words && typeof value.a2_plus_words === "object") {
      arrays.push([value.a2_plus_words]);
    }
    if (Array.isArray(value.words)) {
      arrays.push(value.words);
    } else if (value.words && typeof value.words === "object") {
      arrays.push([value.words]);
    }
    if (Array.isArray(value.word_list)) {
      arrays.push(value.word_list);
    } else if (value.word_list && typeof value.word_list === "object") {
      arrays.push([value.word_list]);
    }
    if (Array.isArray(value.items)) {
      arrays.push(value.items);
    } else if (value.items && typeof value.items === "object") {
      arrays.push([value.items]);
    }
  };

  visit(payload);
  return arrays;
}

function extractWordEntriesFromResponseObject(responseJson) {
  const sources = [
    responseJson?.output_parsed,
    responseJson?.parsed_output
  ];
  for (const outputItem of Array.isArray(responseJson?.output) ? responseJson.output : []) {
    sources.push(outputItem?.parsed);
    sources.push(outputItem?.json);
    sources.push(outputItem?.arguments);
    for (const contentItem of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      sources.push(contentItem?.parsed);
      sources.push(contentItem?.json);
      sources.push(contentItem?.arguments);
      sources.push(contentItem?.text?.value);
      sources.push(contentItem?.text);
    }
  }

  for (const source of sources) {
    const candidateArrays = collectWordArraysFromPayload(source);
    for (const candidate of candidateArrays) {
      const normalized = normalizeWordEntries(candidate);
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return [];
}

function parseWordEntriesFromPartialJson(rawText) {
  const source = String(rawText || "").trim();
  if (!source) {
    return [];
  }

  const candidates = source.match(/\{[^{}]*"word"\s*:[^{}]*"example_simple"\s*:[^{}]*\}/g) || [];
  if (candidates.length === 0) {
    return [];
  }

  const parsed = [];
  for (const chunk of candidates) {
    try {
      const json = JSON.parse(chunk);
      parsed.push(json);
    } catch (_error) {
      // Ignore malformed partial object.
    }
  }
  return normalizeWordEntries(parsed);
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
  const allHints = Array.isArray(candidateHints) ? candidateHints : [];
  const knownHints = allHints.filter(
    (item) => item?.source === "oxford" && isCefrAtOrAboveThreshold(item?.cefr, threshold)
  );
  const unknownHints = allHints.filter((item) => item?.source === "model");
  const safeWordLimit = Math.max(1, Math.min(Number(wordLimit) || 18, 6));
  const knownCap = Math.min(knownHints.length, safeWordLimit);
  const unknownCap = Math.max(0, safeWordLimit - knownCap);
  const rawTargets =
    knownHints.length > 0
      ? [...knownHints.slice(0, knownCap), ...unknownHints.slice(0, unknownCap)]
      : unknownHints.slice(0, safeWordLimit);

  const seenTargets = new Set();
  const targets = [];
  for (const hint of rawTargets) {
    const word = String(hint?.word || "").trim();
    if (!word) {
      continue;
    }
    const key = normalizeWordKey(word);
    if (!key || seenTargets.has(key)) {
      continue;
    }
    seenTargets.add(key);
    const source = hint?.source === "oxford" ? "oxford" : "model";
    const cefr = normalizeCefrLevel(hint?.cefr);
    targets.push({
      word,
      lemma: normalizeLemma(hint?.lemma || word),
      source,
      cefr: source === "oxford" && cefr !== "unknown" ? cefr : "unknown"
    });
    if (targets.length >= safeWordLimit) {
      break;
    }
  }

  if (targets.length === 0) {
    return [];
  }

  const selectedSnippet = String(selectedText || "").trim().slice(0, 180);

  const systemPrompt = `
You write dictionary entries for English learners.
Return JSON only, with no markdown.
`;
  const userPrompt = `
Return JSON only with key "a2_plus_words".

Target words:
${JSON.stringify(targets)}

Rules:
1) Return 1 to ${safeWordLimit} entries.
2) Focus on target words only.
3) Keep CEFR from target when source is "oxford".
4) For source "model", choose cefr from: B2, C1, C2.
5) Keep only words at ${thresholdLabel} or higher.
6) For each entry include: word, lemma, pos, cefr, definition_simple, example_simple.
7) definition_simple: 4-10 words, clear general meaning.
8) example_simple: 7-14 words, simple natural sentence.
9) Do not write placeholder text.
10) Do not write "In this text" in meaning/example.
11) Use this text only for sense disambiguation when needed:
"""${selectedSnippet}"""
`;
  const parseWordResponse = (responseJson) => {
    const structured = extractWordEntriesFromResponseObject(responseJson);
    if (structured.length > 0) {
      return structured;
    }

    const rawText = extractOutputText(responseJson);
    if (!rawText) {
      return [];
    }
    try {
      return parseAndNormalizeWordCoverage(rawText);
    } catch (_error) {
      return parseWordEntriesFromPartialJson(rawText);
    }
  };

  const wordOutputTokenBudget = getWordOutputTokenBudget(safeWordLimit, selectedSnippet.length);

  const primaryResponse = await requestResponsesApi({
    clientId,
    model,
    systemPrompt,
    userPrompt,
    useSchema: false,
    maxOutputTokens: wordOutputTokenBudget,
    maxAttempts: 1,
    allowSchemaFallback: false
  });
  const primaryEntries = parseWordResponse(primaryResponse);
  if (primaryEntries.length > 0) {
    return primaryEntries;
  }
  const responseStatus = String(primaryResponse?.status || "").trim().toLowerCase();
  const incompleteReason = String(primaryResponse?.incomplete_details?.reason || "").trim().toLowerCase();
  if (responseStatus === "incomplete") {
    const reason = incompleteReason || "unknown";
    throw new EasyReadError(`Word response incomplete (${reason}).`, "WORD_INCOMPLETE");
  }
  if (responseStatus === "failed") {
    throw new EasyReadError("Word response failed.", "WORD_FAILED");
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
  safeSendTabMessage(tabId, {
    type: "easyread-explanation-stream",
    ...payload
  });
}

function safeSendTabMessage(tabId, payload) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    chrome.tabs.sendMessage(tabId, payload, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore messaging errors when the content script is not attached to the tab.
  }
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
    ...base,
    simple_explanation: simplifyToEasyText(base.simple_explanation, selectedText),
    a2_plus_words: Array.isArray(base.a2_plus_words) ? base.a2_plus_words : [],
    detected_words: Array.isArray(base.detected_words) ? base.detected_words : [],
    words_status: typeof base.words_status === "string" ? base.words_status : "",
    words_error: typeof base.words_error === "string" ? base.words_error : "",
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

function normalizeWordsErrorMessage(error) {
  if (!(error instanceof EasyReadError)) {
    return "UNKNOWN";
  }
  if (error.code === "PROXY_RETRYABLE" || error.code === "PROXY_ERROR") {
    if (/429/.test(error.message)) {
      return "RATE_LIMIT";
    }
    if (/403/.test(error.message)) {
      return "EXTENSION_NOT_ALLOWED";
    }
    if (/400/.test(error.message)) {
      return "REQUEST_INVALID";
    }
    if (/500|502|503|504/.test(error.message)) {
      return "SERVER_TEMPORARY";
    }
    return "PROXY_ERROR";
  }
  if (error.code === "NETWORK_RETRYABLE") {
    return "NETWORK";
  }
  if (error.code === "WORD_TIMEOUT") {
    return "TIMEOUT";
  }
  if (error.code === "WORD_INCOMPLETE") {
    if (/max_output_tokens/.test(error.message)) {
      return "OUTPUT_CUTOFF";
    }
    return "INCOMPLETE";
  }
  if (error.code === "WORD_FAILED") {
    return "MODEL_FAILED";
  }
  if (error.code === "NO_USABLE_WORD_ENTRIES") {
    return "NO_USABLE_WORD_ENTRIES";
  }
  return error.code || "UNKNOWN";
}
