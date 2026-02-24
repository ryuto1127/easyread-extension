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

function extractJsonArray(text) {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("No JSON array found in model output.");
  }
  return text.slice(start, end + 1);
}

function tryParseJsonFlexible(rawText) {
  const source = String(rawText || "").trim();
  if (!source) {
    throw new Error("Empty model output.");
  }

  try {
    return JSON.parse(source);
  } catch (_directError) {
    // Common fence format from non-schema outputs.
    const unfenced = source.replace(/```json/gi, "").replace(/```/g, "").trim();
    try {
      return JSON.parse(unfenced);
    } catch (_unfencedError) {
      // Try object snippet first, then array snippet.
      try {
        return JSON.parse(extractJsonObject(unfenced));
      } catch (_objectError) {
        return JSON.parse(extractJsonArray(unfenced));
      }
    }
  }
}

export function extractOutputText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  if (typeof responseJson?.text === "string" && responseJson.text.trim()) {
    return responseJson.text.trim();
  }

  const chunks = [];
  for (const outputItem of responseJson?.output || []) {
    for (const contentItem of outputItem?.content || []) {
      if (typeof contentItem?.text === "string") {
        chunks.push(contentItem.text);
        continue;
      }
      if (typeof contentItem?.text?.value === "string") {
        chunks.push(contentItem.text.value);
        continue;
      }
      if (typeof contentItem?.output_text === "string") {
        chunks.push(contentItem.output_text);
        continue;
      }
      if (typeof contentItem?.json === "object" && contentItem.json) {
        chunks.push(JSON.stringify(contentItem.json));
      }
    }
  }

  return chunks.join("\n").trim();
}

export function parseAndNormalizeResponse(rawText) {
  const parsed = tryParseJsonFlexible(rawText);

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
  const parsed = tryParseJsonFlexible(rawText);

  if (Array.isArray(parsed)) {
    return normalizeWordEntries(parsed);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Parsed result is not an object.");
  }

  const candidates = [
    parsed.a2_plus_words,
    parsed.words,
    parsed.word_list,
    parsed.items
  ];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      return normalizeWordEntries(value);
    }
  }

  return [];
}

export function isOutputUsable(result) {
  return Boolean(result.simple_explanation);
}
