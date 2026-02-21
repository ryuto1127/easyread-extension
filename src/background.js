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

const PROXY_BASE_URL = "https://easyread-extension.onrender.com";
const PROXY_EXPLAIN_PATH = "/api/explain";
const CONTEXT_MENU_ID = "easyread_explain";
const MODEL_SHORT_TEXT = "gpt-5-nano";
const MODEL_LONG_TEXT = "gpt-5-mini";
const EXPLANATION_MODES = new Set(["simple", "balanced", "detailed"]);
const DEFAULT_EXPLANATION_MODE = "balanced";
const MODEL_NANO_MAX_CHARS = 1200;
const MAX_A2_CANDIDATES = 48;
const MAX_OUTPUT_TOKENS = 1200;
const MAX_OUTPUT_TOKENS_RETRY = 2000;
const MAX_EXPLAIN_ATTEMPTS = 2;
const HARD_MAX_CHARS = 12000;
const CHUNK_THRESHOLD_CHARS = 4500;
const CHUNK_SIZE_CHARS = 1600;
const MAX_CHUNKS = 8;
const MAX_CHUNK_CONCURRENCY = 2;
// Always return explanation first; words are loaded in a deferred pass.
const FAST_SINGLE_CALL_MAX_CHARS = 0;
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
const EXPLANATION_ONLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["simple_explanation", "notes", "confidence"],
  properties: {
    simple_explanation: { type: "string" },
    notes: { type: "string" },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  }
};
const FALLBACK_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "before",
  "being",
  "both",
  "but",
  "can",
  "could",
  "does",
  "each",
  "even",
  "from",
  "have",
  "having",
  "into",
  "just",
  "like",
  "made",
  "many",
  "more",
  "most",
  "much",
  "only",
  "other",
  "over",
  "same",
  "some",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "those",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would"
]);
const EASY_WORD_REPLACEMENTS = {
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

async function handleExplainRequest(payload, sender) {
  const settings = await getSettings();
  const selectedText = normalizeSelection(payload.selectedText);
  const requestId = normalizeRequestId(payload.requestId);
  const explanationMode = normalizeExplanationMode(payload.explanationMode);
  const tabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;

  if (!selectedText) {
    throw new EasyReadError("Please select text first.", "NO_SELECTION");
  }
  if (selectedText.length > HARD_MAX_CHARS) {
    throw new EasyReadError(
      `Selection is too long (${selectedText.length} chars). Max is ${HARD_MAX_CHARS}.`,
      "SELECTION_TOO_LONG"
    );
  }
  const isFastSingleCallPath = selectedText.length <= FAST_SINGLE_CALL_MAX_CHARS;
  const shouldUseDeferredWords = !isFastSingleCallPath;
  const selectedModel = chooseModelForText(selectedText.length);
  const clientId = await getOrCreateAnonymousClientId(settings);

  const pageOrigin = getPageOrigin(payload.pageUrl, payload.pageOrigin);
  const cacheKey = await buildCacheKey({
    pageOrigin,
    selectedText,
    explanationMode,
    model: selectedModel,
    modelVersion: MODEL_VERSION
  });

  const cached = await getCachedResponse(cacheKey);
  if (cached) {
    const safeCached = ensureNonEmptyExplanation(
      cached,
      selectedText,
      "EasyRead filled a backup explanation because cached output was empty."
    );
    return {
      cached: true,
      result: safeCached,
      requestId,
      wordsPending: false,
      explanationMode
    };
  }

  if (isFastSingleCallPath && inflightRequests.has(cacheKey)) {
    const sharedWork = await inflightRequests.get(cacheKey);
    const sharedResult = ensureNonEmptyExplanation(
      sharedWork?.result,
      selectedText,
      "EasyRead filled a backup explanation because shared output was empty."
    );
    return {
      cached: false,
      result: sharedResult,
      requestId,
      wordsPending: Boolean(sharedWork?.wordsPending),
      explanationMode
    };
  }

  const workPromise = (async () => {
    if (isFastSingleCallPath) {
      const analyzed = await analyzeSingleSelection({
        selectedText,
        clientId,
        model: selectedModel,
        explanationMode,
        allowSupplemental: false,
        forceSingleCall: true
      });
      const { parsed, candidateCount } = analyzed;

      if (parsed.a2_plus_words.length === 0 && candidateCount > 0) {
        parsed.notes = appendNote(parsed.notes, "No words above B1 were detected with enough confidence.");
      }

      if (!isOutputUsable(parsed)) {
        throw new EasyReadError("Model output is empty. Please try again.", "EMPTY_RESULT");
      }

      const easyParsed = enforceEasyLanguage(parsed, selectedText);
      const safeParsed = ensureNonEmptyExplanation(
        easyParsed,
        selectedText,
        "EasyRead filled a backup explanation because the model returned empty text."
      );
      await saveCachedResponse(
        cacheKey,
        {
          selectedText,
          explanationMode,
          model: selectedModel
        },
        safeParsed
      );

      return {
        result: safeParsed,
        wordsPending: false
      };
    }

    const explanationOnly = await analyzeExplanationOnlySelection({
      selectedText,
      clientId,
      model: selectedModel,
      explanationMode
    });

    const immediateResult = enforceEasyLanguage(
      {
        ...explanationOnly.parsed,
        a2_plus_words: []
      },
      selectedText
    );
    const safeImmediateResult = ensureNonEmptyExplanation(
      immediateResult,
      selectedText,
      "EasyRead filled a backup explanation because the model returned empty text."
    );

    if (!isOutputUsable(safeImmediateResult)) {
      throw new EasyReadError("Model output is empty. Please try again.", "EMPTY_RESULT");
    }

    if (!shouldUseDeferredWords || explanationOnly.candidateCount <= 0) {
      await saveCachedResponse(
        cacheKey,
        {
          selectedText,
          explanationMode,
          model: selectedModel
        },
        safeImmediateResult
      );
      return {
        result: safeImmediateResult,
        wordsPending: false
      };
    }

    void runDeferredWordsPass({
      tabId,
      requestId,
      selectedText,
      candidates: explanationOnly.candidates,
      clientId,
      model: selectedModel,
      explanationMode,
      baseResult: safeImmediateResult,
      cacheKey
    });

    return {
      result: safeImmediateResult,
      wordsPending: true
    };
  })();

  if (isFastSingleCallPath) {
    inflightRequests.set(cacheKey, workPromise);
  }
  try {
    const completed = await workPromise;
    return {
      cached: false,
      result: completed.result,
      requestId,
      wordsPending: completed.wordsPending,
      explanationMode
    };
  } catch (error) {
    if (isRecoverableModelOutputError(error)) {
      const fallbackResult = buildLocalFallbackResult(
        selectedText,
        "EasyRead used fallback mode because the model response was incomplete."
      );
      await saveCachedResponse(
        cacheKey,
        {
          selectedText,
          explanationMode,
          model: selectedModel
        },
        fallbackResult
      );
      return {
        cached: false,
        result: fallbackResult,
        requestId,
        wordsPending: false,
        explanationMode
      };
    }
    throw error;
  } finally {
    if (isFastSingleCallPath) {
      inflightRequests.delete(cacheKey);
    }
  }
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

function appendNote(base, addition) {
  const next = String(addition || "").trim();
  if (!next) {
    return String(base || "").trim();
  }
  const prior = String(base || "").trim();
  return prior ? `${prior} ${next}` : next;
}

function isRecoverableModelOutputError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "");
  if (code === "EMPTY_OUTPUT" || code === "BAD_JSON") {
    return true;
  }
  if (message.includes("model returned no text")) {
    return true;
  }
  if (message.includes("max_output_tokens")) {
    return true;
  }
  return false;
}

function ensureNonEmptyExplanation(result, selectedText, fallbackNote = "") {
  const base = result && typeof result === "object" ? { ...result } : {};
  if (hasText(base.simple_explanation)) {
    return base;
  }

  base.simple_explanation = buildLocalFallbackExplanation(selectedText);
  base.notes = appendNote(
    base.notes,
    fallbackNote || "EasyRead used backup explanation because model output was empty."
  );
  if (typeof base.confidence !== "number" || !Number.isFinite(base.confidence)) {
    base.confidence = 0.35;
  } else {
    base.confidence = Math.min(base.confidence, 0.35);
  }
  if (!Array.isArray(base.a2_plus_words)) {
    base.a2_plus_words = [];
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

function chooseModelForText(textLength) {
  return textLength > MODEL_NANO_MAX_CHARS ? MODEL_LONG_TEXT : MODEL_SHORT_TEXT;
}

async function analyzeSingleSelection({
  selectedText,
  clientId,
  model,
  explanationMode = DEFAULT_EXPLANATION_MODE,
  allowSupplemental = true,
  forceSingleCall = false
}) {
  const candidates = extractA2PlusCandidates(selectedText, A1_A2_WORD_SET, MAX_A2_CANDIDATES);
  const wordLimit = getWordResultLimit(selectedText.length);
  const primaryPrompt = buildUserPrompt({
    selectedText,
    candidates,
    wordLimit,
    explanationMode
  });

  let parsed = await callModelForEasyRead({
    clientId,
    model,
    selectedTextLength: selectedText.length,
    selectedTextForFallback: selectedText,
    userPrompt: primaryPrompt,
    explanationMode,
    singleAttempt: forceSingleCall
  });

  parsed.a2_plus_words = keepB2PlusWords(parsed.a2_plus_words);

  const needsSupplementalWords = shouldRunSupplementalWordPass({
    currentWords: parsed.a2_plus_words,
    candidateCount: candidates.length,
    selectedTextLength: selectedText.length
  });

  if (allowSupplemental && needsSupplementalWords) {
    const supplemental = await callModelForB2PlusWords({
      clientId,
      model,
      selectedText,
      candidateHints: candidates,
      wordLimit
    });
    if (supplemental.length > 0) {
      parsed.a2_plus_words = mergeWordEntries(parsed.a2_plus_words, supplemental);
      parsed.a2_plus_words = keepB2PlusWords(parsed.a2_plus_words);
    }
  }

  return {
    parsed,
    candidateCount: candidates.length
  };
}

async function analyzeExplanationOnlySelection({
  selectedText,
  clientId,
  model,
  explanationMode = DEFAULT_EXPLANATION_MODE
}) {
  const candidates = extractA2PlusCandidates(selectedText, A1_A2_WORD_SET, MAX_A2_CANDIDATES);
  const userPrompt = buildExplanationOnlyPrompt(selectedText, explanationMode);
  const tokenBudget = getExplanationOnlyTokenBudget(selectedText.length, explanationMode);

  let response = await requestResponsesApi({
    clientId,
    model,
    systemPrompt: CORE_SYSTEM_PROMPT,
    userPrompt,
    schema: EXPLANATION_ONLY_SCHEMA,
    schemaName: "easyread_explanation_only",
    useSchema: true,
    maxOutputTokens: tokenBudget
  });

  let rawText = extractOutputText(response);
  if (!rawText) {
    const fallbackBudget = isMaxOutputTokensIncomplete(response)
      ? Math.max(tokenBudget, MAX_OUTPUT_TOKENS_RETRY)
      : tokenBudget;
    response = await requestResponsesApi({
      clientId,
      model,
      systemPrompt: CORE_SYSTEM_PROMPT,
      userPrompt,
      useSchema: false,
      maxOutputTokens: fallbackBudget
    });
    rawText = extractOutputText(response);
  }

  if (!rawText) {
    return {
      parsed: buildLocalFallbackResult(
        selectedText,
        "EasyRead used fallback mode because the model response was cut off."
      ),
      candidateCount: candidates.length,
      candidates
    };
  }

  let parsed;
  try {
    parsed = parseAndNormalizeResponse(rawText);
  } catch (_error) {
    const repaired = await tryRepairResponseJson({
      clientId,
      originalModel: model,
      rawText
    });
    if (!repaired) {
      return {
        parsed: buildLocalFallbackResult(
          selectedText,
          "EasyRead used fallback mode because model JSON formatting failed."
        ),
        candidateCount: candidates.length,
        candidates
      };
    }
    parsed = repaired;
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

async function analyzeLongSelection({
  selectedText,
  clientId,
  model,
  explanationMode = DEFAULT_EXPLANATION_MODE
}) {
  const chunks = splitTextIntoChunks(selectedText, CHUNK_SIZE_CHARS, MAX_CHUNKS);
  if (chunks.length <= 1) {
    return analyzeSingleSelection({
      selectedText,
      clientId,
      model,
      explanationMode
    });
  }

  const chunkResults = await mapWithConcurrency(
    chunks,
    MAX_CHUNK_CONCURRENCY,
    async (chunkText) => {
      const chunkAnalyzed = await analyzeSingleSelection({
        selectedText: chunkText,
        clientId,
        model,
        explanationMode,
        allowSupplemental: false
      });
      return chunkAnalyzed.parsed;
    }
  );

  const merged = mergeChunkResults(chunkResults, chunks.length);
  const fullCandidates = extractA2PlusCandidates(selectedText, A1_A2_WORD_SET, MAX_A2_CANDIDATES);
  if (fullCandidates.length > 0) {
    const supplemental = await callModelForB2PlusWords({
      clientId,
      model,
      selectedText,
      candidateHints: fullCandidates,
      wordLimit: getWordResultLimit(selectedText.length)
    });
    if (supplemental.length > 0) {
      merged.a2_plus_words = mergeWordEntries(merged.a2_plus_words, supplemental);
      merged.a2_plus_words = keepB2PlusWords(merged.a2_plus_words);
    }
  }

  return {
    parsed: merged,
    candidateCount: fullCandidates.length
  };
}

async function mapWithConcurrency(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(limit, list.length));
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(list[current], current);
    }
  }

  const workers = [];
  for (let i = 0; i < safeLimit; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function splitTextIntoChunks(text, targetChars, maxChunks) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }

  const words = normalized.split(" ");
  const chunks = [];
  let current = "";

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const next = current ? `${current} ${word}` : word;

    if (next.length > targetChars && current) {
      chunks.push(current);
      current = word;

      if (chunks.length >= maxChunks - 1) {
        const rest = [current, ...words.slice(i + 1)].join(" ").trim();
        if (rest) {
          chunks.push(rest);
        }
        return chunks;
      }
      continue;
    }

    current = next;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function mergeChunkResults(chunkResults, chunkCount) {
  const explanationParts = [];
  const noteSet = new Set();
  let mergedWords = [];
  let confidenceTotal = 0;
  let confidenceCount = 0;

  for (const item of chunkResults || []) {
    if (hasText(item?.simple_explanation)) {
      explanationParts.push(item.simple_explanation.trim());
    }
    if (hasText(item?.notes)) {
      noteSet.add(item.notes.trim());
    }
    if (Array.isArray(item?.a2_plus_words) && item.a2_plus_words.length > 0) {
      mergedWords = mergeWordEntries(mergedWords, item.a2_plus_words);
    }
    if (typeof item?.confidence === "number" && Number.isFinite(item.confidence)) {
      confidenceTotal += item.confidence;
      confidenceCount += 1;
    }
  }

  mergedWords = keepB2PlusWords(mergedWords);
  const baseNote = `Large text mode: analyzed in ${chunkCount} parts.`;
  noteSet.add(baseNote);

  return {
    simple_explanation:
      explanationParts.join("\n\n") || "EasyRead could not build a full explanation from this long text.",
    a2_plus_words: mergedWords,
    notes: [...noteSet].join(" "),
    confidence: confidenceCount > 0 ? confidenceTotal / confidenceCount : 0.45
  };
}

function buildUserPrompt({ selectedText, candidates, wordLimit, explanationMode }) {
  const mode = normalizeExplanationMode(explanationMode);
  const explanationGuidance = getExplanationLengthGuidance(selectedText.length, mode);
  const styleGuidance = getExplanationStyleGuidance(mode);
  return `
Return JSON only that follows the schema.
Write a useful explanation for learners.
Requested explanation mode: ${mode}.
${styleGuidance}
${explanationGuidance}

Selected text:
"""${selectedText}"""

Candidate words that may be above B1:
${JSON.stringify(candidates)}

Rules:
1) Put the full explanation in simple_explanation.
2) Keep the explanation strictly grounded in the selected text; do not add outside facts.
3) Follow the same idea order as the selected text.
4) Include only words above B1 in a2_plus_words (B2/C1/C2 only), with at most ${wordLimit} entries.
5) Do not include A1, A2, or B1 words (for example do not include common words like "has" or "been").
6) Cover difficult words from all parts of speech, not only nouns.
7) Use pos values from: noun, verb, adj, adv, prep, pron, det, conj, other.
8) Every a2_plus_words item must have non-empty definition_simple and example_simple.
9) confidence must be 0.0 to 1.0.
10) Keep notes short, only when needed.
11) Do not copy full sentences from the selected text. Paraphrase in easier words.
`;
}

function buildExplanationOnlyPrompt(selectedText, explanationMode) {
  const mode = normalizeExplanationMode(explanationMode);
  const explanationGuidance = getExplanationLengthGuidance(selectedText.length, mode);
  const styleGuidance = getExplanationStyleGuidance(mode);
  return `
Return JSON only that follows the schema.
Write a useful explanation for learners.
Requested explanation mode: ${mode}.
${styleGuidance}
${explanationGuidance}

Selected text:
"""${selectedText}"""

Rules:
1) Put the full explanation in simple_explanation.
2) Keep the explanation strictly grounded in the selected text; do not add outside facts.
3) Follow the same idea order as the selected text.
4) Do not include word-list entries in this step.
5) Keep notes short, only when needed.
6) Do not copy full sentences from the selected text. Paraphrase in easier words.
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
      return "Write 2 to 3 short sentences.";
    }
    if (selectionLength <= 320) {
      return "Write 3 to 4 short sentences.";
    }
    if (selectionLength <= 700) {
      return "Write 4 to 5 short sentences.";
    }
    return "Write 5 to 6 short sentences.";
  }

  if (mode === "detailed") {
    if (selectionLength <= 120) {
      return "Write 3 to 4 sentences with key detail.";
    }
    if (selectionLength <= 320) {
      return "Write 5 to 7 sentences.";
    }
    if (selectionLength <= 700) {
      return "Write 7 to 9 sentences.";
    }
    return "Write 8 to 10 sentences.";
  }

  if (selectionLength <= 120) {
    return "Write 3 to 4 short sentences.";
  }
  if (selectionLength <= 320) {
    return "Write 4 to 6 sentences.";
  }
  if (selectionLength <= 700) {
    return "Write 6 to 8 sentences.";
  }
  return "Write 7 to 9 sentences.";
}

function getWordResultLimit(selectionLength) {
  if (selectionLength <= 180) {
    return 10;
  }
  if (selectionLength <= 500) {
    return 14;
  }
  if (selectionLength <= 1200) {
    return 18;
  }
  return 24;
}

function getOutputTokenBudget({ model, selectedTextLength, explanationMode = DEFAULT_EXPLANATION_MODE }) {
  const mode = normalizeExplanationMode(explanationMode);
  let budget;

  if (model === MODEL_SHORT_TEXT) {
    if (selectedTextLength <= 180) {
      budget = 800;
    } else if (selectedTextLength <= 700) {
      budget = 950;
    } else {
      budget = 1150;
    }
  } else if (selectedTextLength <= 700) {
    budget = 1100;
  } else if (selectedTextLength <= 1800) {
    budget = 1400;
  } else {
    budget = 1650;
  }

  if (mode === "simple") {
    budget -= 120;
  } else if (mode === "detailed") {
    budget += 220;
  }

  return Math.max(650, budget);
}

function getExplanationOnlyTokenBudget(selectionLength, explanationMode = DEFAULT_EXPLANATION_MODE) {
  const mode = normalizeExplanationMode(explanationMode);
  let budget;

  if (selectionLength <= 320) {
    budget = 700;
  } else if (selectionLength <= 1200) {
    budget = 900;
  } else {
    budget = 1100;
  }

  if (mode === "simple") {
    budget -= 120;
  } else if (mode === "detailed") {
    budget += 220;
  }

  return Math.max(600, budget);
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
  clientId,
  model,
  selectedText,
  candidateHints,
  wordLimit = 18
}) {
  const response = await requestResponsesApi({
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
1) Include the most useful words above B1 that appear in the selected text.
2) Return at most ${wordLimit} entries.
3) Do not include A1, A2, or B1 words.
4) Set cefr only to B2, C1, or C2.
5) Fill lemma, pos, cefr, definition_simple, example_simple.
6) definition_simple and example_simple must not be empty.
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
  clientId,
  model,
  selectedTextLength = 0,
  selectedTextForFallback = "",
  userPrompt,
  explanationMode = DEFAULT_EXPLANATION_MODE,
  correctionHint = "",
  singleAttempt = false,
  attemptCount = 1
}) {
  if (attemptCount > MAX_EXPLAIN_ATTEMPTS) {
    return buildLocalFallbackResult(
      selectedTextForFallback,
      "EasyRead stopped after multiple retries to keep response fast."
    );
  }

  const finalPrompt = `${userPrompt}\n${correctionHint}`.trim();
  const baseTokenBudget = getOutputTokenBudget({
    model,
    selectedTextLength,
    explanationMode
  });
  const retryTokenBudget = Math.max(baseTokenBudget, MAX_OUTPUT_TOKENS_RETRY);

  let response = await requestResponsesApi({
    clientId,
    model,
    systemPrompt: CORE_SYSTEM_PROMPT,
    userPrompt: finalPrompt,
    useSchema: true,
    maxOutputTokens: baseTokenBudget
  });

  if (singleAttempt) {
    const singleRawText = extractOutputText(response);
    if (!singleRawText) {
      return callModelForEasyRead({
        clientId,
        model,
        selectedTextLength,
        selectedTextForFallback,
        userPrompt,
        explanationMode,
        correctionHint:
          "Previous answer returned no text. Return complete JSON with clear explanation now.",
        singleAttempt: false,
        attemptCount: attemptCount + 1
      });
    }
    try {
      const parsed = parseAndNormalizeResponse(singleRawText);
      if (shouldRetryForMissingExplanation(parsed, correctionHint)) {
        return callModelForEasyRead({
          clientId,
          model,
          selectedTextLength,
          selectedTextForFallback,
          userPrompt,
          explanationMode,
          correctionHint:
            "simple_explanation was empty. Return non-empty simple_explanation with at least 2 clear sentences in easy words.",
          singleAttempt: false,
          attemptCount: attemptCount + 1
        });
      }
      if (isExplanationTooCloseToSource(parsed.simple_explanation, selectedTextForFallback)) {
        return callModelForEasyRead({
          clientId,
          model,
          selectedTextLength,
          selectedTextForFallback,
          userPrompt,
          explanationMode,
          correctionHint:
            "Do not copy the selected text. Rewrite the meaning in easier words and different sentence form.",
          singleAttempt: false,
          attemptCount: attemptCount + 1
        });
      }
      return parsed;
    } catch (_error) {
      return callModelForEasyRead({
        clientId,
        model,
        selectedTextLength,
        selectedTextForFallback,
        userPrompt,
        explanationMode,
        correctionHint:
          "Your previous answer was not valid JSON. Return JSON only, no markdown, no extra text.",
        singleAttempt: false,
        attemptCount: attemptCount + 1
      });
    }
  }

  let rawText = extractOutputText(response);
  if (!rawText) {
    const fallbackTokenBudget = isMaxOutputTokensIncomplete(response)
      ? retryTokenBudget
      : baseTokenBudget;
    response = await requestResponsesApi({
      clientId,
      model,
      systemPrompt: CORE_SYSTEM_PROMPT,
      userPrompt: finalPrompt,
      useSchema: false,
      maxOutputTokens: fallbackTokenBudget
    });
    rawText = extractOutputText(response);
  }
  if (!rawText && model === MODEL_SHORT_TEXT) {
    response = await requestResponsesApi({
      clientId,
      model: MODEL_LONG_TEXT,
      systemPrompt: CORE_SYSTEM_PROMPT,
      userPrompt: finalPrompt,
      useSchema: false,
      maxOutputTokens: retryTokenBudget
    });
    rawText = extractOutputText(response);
  }

  if (!rawText) {
    return buildLocalFallbackResult(
      selectedTextForFallback,
      "EasyRead used fallback mode because the model response was cut off."
    );
  }

  try {
    const parsed = parseAndNormalizeResponse(rawText);
    if (shouldRetryForMissingExplanation(parsed, correctionHint)) {
      return callModelForEasyRead({
        clientId,
        model,
        selectedTextLength,
        selectedTextForFallback,
        userPrompt,
        explanationMode,
        correctionHint:
          "simple_explanation was empty. Return non-empty simple_explanation with at least 2 clear sentences in easy words.",
        attemptCount: attemptCount + 1
      });
    }
    if (isExplanationTooCloseToSource(parsed.simple_explanation, selectedTextForFallback)) {
      if (!correctionHintIncludesNoCopy(correctionHint)) {
        return callModelForEasyRead({
          clientId,
          model,
          selectedTextLength,
          selectedTextForFallback,
          userPrompt,
          explanationMode,
          correctionHint:
            "Do not copy the selected text. Rewrite the meaning in easier words and different sentence form.",
          attemptCount: attemptCount + 1
        });
      }
      return buildLocalFallbackResult(
        selectedTextForFallback,
        "EasyRead used fallback mode because the model repeated the original text."
      );
    }
    return parsed;
  } catch (_error) {
    const repaired = await tryRepairResponseJson({
      clientId,
      originalModel: model,
      rawText
    });
    if (repaired) {
      if (!hasText(repaired.simple_explanation)) {
        return buildLocalFallbackResult(
          selectedTextForFallback,
          "EasyRead used fallback mode because the model returned empty explanation text."
        );
      }
      if (isExplanationTooCloseToSource(repaired.simple_explanation, selectedTextForFallback)) {
        return buildLocalFallbackResult(
          selectedTextForFallback,
          "EasyRead used fallback mode because the model repeated the original text."
        );
      }
      return repaired;
    }

    if (isMaxOutputTokensIncomplete(response)) {
      const expandedResponse = await requestResponsesApi({
        clientId,
        model,
        systemPrompt: CORE_SYSTEM_PROMPT,
        userPrompt: finalPrompt,
        useSchema: false,
        maxOutputTokens: retryTokenBudget
      });
      const expandedRawText = extractOutputText(expandedResponse);
      if (expandedRawText) {
        try {
          const expandedParsed = parseAndNormalizeResponse(expandedRawText);
          if (shouldRetryForMissingExplanation(expandedParsed, correctionHint)) {
            return callModelForEasyRead({
              clientId,
              model,
              selectedTextLength,
              selectedTextForFallback,
              userPrompt,
              explanationMode,
              correctionHint:
                "simple_explanation was empty. Return non-empty simple_explanation with at least 2 clear sentences in easy words.",
              attemptCount: attemptCount + 1
            });
          }
          if (isExplanationTooCloseToSource(expandedParsed.simple_explanation, selectedTextForFallback)) {
            if (!correctionHintIncludesNoCopy(correctionHint)) {
              return callModelForEasyRead({
                clientId,
                model,
                selectedTextLength,
                selectedTextForFallback,
                userPrompt,
                explanationMode,
                correctionHint:
                  "Do not copy the selected text. Rewrite the meaning in easier words and different sentence form.",
                attemptCount: attemptCount + 1
              });
            }
            return buildLocalFallbackResult(
              selectedTextForFallback,
              "EasyRead used fallback mode because the model repeated the original text."
            );
          }
          return expandedParsed;
        } catch (_expandedError) {
          const expandedRepaired = await tryRepairResponseJson({
            clientId,
            originalModel: model,
            rawText: expandedRawText
          });
          if (expandedRepaired) {
            if (!hasText(expandedRepaired.simple_explanation)) {
              return buildLocalFallbackResult(
                selectedTextForFallback,
                "EasyRead used fallback mode because the model returned empty explanation text."
              );
            }
            return expandedRepaired;
          }
          rawText = expandedRawText;
        }
      }
    }

    if (correctionHint) {
      return buildLocalFallbackResult(
        selectedTextForFallback,
        "EasyRead used fallback mode because model JSON formatting failed."
      );
    }
    return callModelForEasyRead({
      clientId,
      model,
      selectedTextLength,
      selectedTextForFallback,
      userPrompt,
      explanationMode,
      correctionHint:
        "Your previous answer was not valid JSON. Return JSON only, no markdown, no extra text.",
      attemptCount: attemptCount + 1
    });
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
  maxOutputTokens = MAX_OUTPUT_TOKENS
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

  try {
    return await postResponsesPayload({ clientId, payload });
  } catch (error) {
    const schemaIssue =
      useSchema &&
      error instanceof EasyReadError &&
      error.code === "PROXY_ERROR" &&
      /text\.format|json_schema|schema|strict/i.test(error.message);
    if (!schemaIssue) {
      throw error;
    }

    const fallbackPayload = { ...payload };
    delete fallbackPayload.text;
    return postResponsesPayload({ clientId, payload: fallbackPayload });
  }
}

async function postResponsesPayload({ clientId, payload }) {
  return withExponentialBackoff(async () => {
    return postProxyJson({
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

async function runDeferredWordsPass({
  tabId,
  requestId,
  selectedText,
  candidates,
  clientId,
  model,
  explanationMode = DEFAULT_EXPLANATION_MODE,
  baseResult,
  cacheKey
}) {
  try {
    const candidateList = Array.isArray(candidates) ? candidates : [];
    let words = [];

    if (candidateList.length > 0) {
      words = await callModelForB2PlusWords({
        clientId,
        model,
        selectedText,
        candidateHints: candidateList,
        wordLimit: getWordResultLimit(selectedText.length)
      });
    }

    let finalNotes = baseResult.notes || "";
    if (words.length === 0 && candidateList.length > 0) {
      finalNotes = appendNote(finalNotes, "No words above B1 were detected with enough confidence.");
    }

    const finalResult = enforceEasyLanguage(
      {
        ...baseResult,
        a2_plus_words: keepB2PlusWords(words),
        notes: finalNotes
      },
      selectedText
    );
    const safeFinalResult = ensureNonEmptyExplanation(
      finalResult,
      selectedText,
      "EasyRead filled a backup explanation because the model returned empty text."
    );

    await saveCachedResponse(
      cacheKey,
      {
        selectedText,
        explanationMode,
        model
      },
      safeFinalResult
    );

    if (Number.isInteger(tabId)) {
      await sendTabUpdate(tabId, {
        type: "easyread-words-update",
        requestId,
        explanationMode,
        result: safeFinalResult
      });
    }
  } catch (_error) {
    if (Number.isInteger(tabId)) {
      await sendTabUpdate(tabId, {
        type: "easyread-words-update",
        requestId,
        error: "Words are taking too long. Try again for the full word list."
      });
    }
  }
}

function sendTabUpdate(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enforceEasyLanguage(result, selectedText) {
  const base = result && typeof result === "object" ? result : {};
  const normalized = {
    simple_explanation: simplifyToEasyText(base.simple_explanation, selectedText),
    a2_plus_words: Array.isArray(base.a2_plus_words) ? base.a2_plus_words : [],
    notes: simplifyNoteText(base.notes || ""),
    confidence: typeof base.confidence === "number" ? base.confidence : 0.5
  };

  normalized.a2_plus_words = normalized.a2_plus_words.map((item) => ({
    ...item,
    definition_simple:
      simplifyToEasyText(item?.definition_simple || "", "") || "This word is not easy.",
    example_simple:
      simplifyToEasyText(item?.example_simple || "", "") || "I see this word here."
  }));

  return normalized;
}

function simplifyToEasyText(text, selectedText) {
  const raw = String(text || "").trim();
  if (!raw) {
    return "";
  }

  let simplified = applyEasyWordReplacements(raw);
  simplified = simplified.replace(/\s+/g, " ").trim();

  if (!simplified) {
    if (selectedText) {
      return buildLocalFallbackExplanation(selectedText);
    }
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

  if (
    lower.includes("cut off") ||
    lower.includes("incomplete") ||
    lower.includes("json") ||
    lower.includes("fallback") ||
    lower.includes("model problem") ||
    lower.includes("backup answer")
  ) {
    return "EasyRead had a model problem. This is a short backup answer.";
  }
  if (lower.includes("no words above b1")) {
    return "EasyRead did not find clear hard words above B1.";
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

function buildNoOutputReason(response) {
  const refusal = extractFirstRefusal(response);
  if (refusal) {
    return `Model refused this request: ${refusal.slice(0, 180)}`;
  }

  const status = typeof response?.status === "string" ? response.status : "";
  const reason =
    typeof response?.incomplete_details?.reason === "string"
      ? response.incomplete_details.reason
      : "";
  if (status && status !== "completed") {
    return reason
      ? `Model returned no text (status: ${status}, reason: ${reason}).`
      : `Model returned no text (status: ${status}).`;
  }
  return "";
}

function isMaxOutputTokensIncomplete(response) {
  return (
    response?.status === "incomplete" &&
    response?.incomplete_details?.reason === "max_output_tokens"
  );
}

function buildLocalFallbackResult(selectedText, fallbackNote = "") {
  const note = simplifyNoteText(String(fallbackNote || "").trim());
  return {
    simple_explanation: buildLocalFallbackExplanation(selectedText),
    a2_plus_words: [],
    notes: note,
    confidence: 0.2
  };
}

function buildLocalFallbackExplanation(selectedText) {
  const normalized = String(selectedText || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "EasyRead could not read this text.";
  }

  const keywords = extractFallbackKeywords(normalized, 6);
  if (keywords.length >= 4) {
    return `This text talks about ${keywords[0]}, ${keywords[1]}, ${keywords[2]}, and ${keywords[3]}. It tells what happened and why it matters.`;
  }
  if (keywords.length >= 2) {
    return `This text talks about ${keywords[0]} and ${keywords[1]}. It gives key facts and the main point.`;
  }

  return "This text has hard words. Please choose a short part.";
}

function correctionHintIncludesNoCopy(correctionHint) {
  return String(correctionHint || "").toLowerCase().includes("do not copy");
}

function correctionHintIncludesMissingExplanation(correctionHint) {
  const lower = String(correctionHint || "").toLowerCase();
  return lower.includes("simple_explanation was empty") || lower.includes("non-empty simple_explanation");
}

function shouldRetryForMissingExplanation(parsed, correctionHint) {
  return !hasText(parsed?.simple_explanation) && !correctionHintIncludesMissingExplanation(correctionHint);
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

function extractFallbackKeywords(text, maxCount = 6) {
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[a-z]+(?:'[a-z]+)?/g);
  if (!tokens) {
    return [];
  }

  const keywords = [];
  const seen = new Set();
  for (const token of tokens) {
    if (token.length < 4 || FALLBACK_STOP_WORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= maxCount) {
      break;
    }
  }
  return keywords;
}

async function tryRepairResponseJson({ clientId, originalModel, rawText }) {
  const source = String(rawText || "").trim();
  if (!source) {
    return null;
  }

  try {
    const repairResponse = await requestResponsesApi({
      clientId,
      model: originalModel === MODEL_SHORT_TEXT ? MODEL_LONG_TEXT : originalModel,
      systemPrompt: `
You repair output into valid JSON for EasyRead.
Return valid JSON only and match the required schema exactly.
If source text is incomplete, infer best-effort missing fields and lower confidence.
`,
      userPrompt: `
Convert the following source into valid EasyRead JSON only.

Source:
"""${source}"""
`,
      useSchema: true,
      maxOutputTokens: 1100
    });
    const repairedText = extractOutputText(repairResponse);
    if (!repairedText) {
      return null;
    }
    return parseAndNormalizeResponse(repairedText);
  } catch (_error) {
    return null;
  }
}

function extractFirstRefusal(response) {
  for (const outputItem of response?.output || []) {
    for (const contentItem of outputItem?.content || []) {
      if (typeof contentItem?.refusal === "string" && contentItem.refusal.trim()) {
        return contentItem.refusal.trim();
      }
    }
  }
  return "";
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

function toUserErrorMessage(error) {
  if (error instanceof EasyReadError) {
    return error.message;
  }
  return "EasyRead failed. Please try again.";
}
