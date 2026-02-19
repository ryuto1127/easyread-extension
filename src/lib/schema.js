import { CEFR_VALUES, POS_VALUES } from "./constants.js";

function clampConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeString(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function normalizePos(value) {
  const pos = normalizeString(value).toLowerCase();
  return POS_VALUES.has(pos) ? pos : "other";
}

function normalizeCefr(value) {
  const cefr = normalizeString(value).toUpperCase();
  return CEFR_VALUES.has(cefr) ? cefr : "unknown";
}

function normalizeWordItem(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const word = normalizeString(item.word);
  if (!word) {
    return null;
  }
  return {
    word,
    lemma: normalizeString(item.lemma) || word.toLowerCase(),
    pos: normalizePos(item.pos),
    cefr: normalizeCefr(item.cefr),
    definition_simple: normalizeString(item.definition_simple),
    example_simple: normalizeString(item.example_simple)
  };
}

export function normalizeWordEntries(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeWordItem).filter(Boolean);
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("No JSON object found in model output.");
  }
  return text.slice(start, end + 1);
}

export function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const chunks = [];
  for (const outputItem of responseJson?.output || []) {
    for (const contentItem of outputItem?.content || []) {
      if (typeof contentItem?.text === "string") {
        chunks.push(contentItem.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

export function parseAndNormalizeResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_err) {
    parsed = JSON.parse(extractJsonObject(rawText));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Parsed result is not an object.");
  }

  const normalizedWords = normalizeWordEntries(parsed.a2_plus_words);

  return {
    simple_explanation: normalizeString(parsed.simple_explanation),
    a2_plus_words: normalizedWords,
    notes: normalizeString(parsed.notes),
    confidence: clampConfidence(parsed.confidence)
  };
}

export function parseAndNormalizeWordCoverage(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (_err) {
    parsed = JSON.parse(extractJsonObject(rawText));
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Parsed result is not an object.");
  }

  return normalizeWordEntries(parsed.a2_plus_words);
}

export function isOutputUsable(result) {
  return Boolean(result.simple_explanation);
}
