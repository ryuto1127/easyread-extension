export const SETTINGS_KEY = "easyread_settings_v1";
export const CACHE_KEY = "easyread_cache_v1";
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MODEL_VERSION = "easyread-mvp-2026-02";

export const DEFAULT_SETTINGS = {
  anonymousClientId: ""
};

export const POS_VALUES = new Set([
  "noun",
  "verb",
  "adj",
  "adv",
  "prep",
  "pron",
  "det",
  "conj",
  "other"
]);

export const CEFR_VALUES = new Set([
  "A2",
  "B1",
  "B2",
  "C1",
  "C2",
  "unknown"
]);

export const EASYREAD_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["simple_explanation", "a2_plus_words", "confidence"],
  properties: {
    simple_explanation: { type: "string" },
    a2_plus_words: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "word",
          "lemma",
          "pos",
          "cefr",
          "definition_simple",
          "example_simple"
        ],
        properties: {
          word: { type: "string", minLength: 1 },
          lemma: { type: "string", minLength: 1 },
          pos: {
            type: "string",
            enum: ["noun", "verb", "adj", "adv", "prep", "pron", "det", "conj", "other"]
          },
          cefr: {
            type: "string",
            enum: ["A2", "B1", "B2", "C1", "C2", "unknown"]
          },
          definition_simple: { type: "string", minLength: 1 },
          example_simple: { type: "string", minLength: 1 }
        }
      }
    },
    notes: { type: "string" },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1
    }
  }
};
