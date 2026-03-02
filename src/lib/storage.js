import {
  CACHE_KEY,
  CACHE_TTL_MS,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  WORD_CEFR_CACHE_KEY,
  WORD_CEFR_CACHE_TTL_MS,
  WORD_DEFINITION_CACHE_KEY,
  WORD_DEFINITION_CACHE_TTL_MS
} from "./constants.js";

export async function getSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {})
  };
}

export async function saveSettings(settings) {
  const next = {
    ...DEFAULT_SETTINGS,
    ...settings
  };
  await chrome.storage.local.set({
    [SETTINGS_KEY]: next
  });
  return next;
}

export async function getCacheMap() {
  const stored = await chrome.storage.local.get([CACHE_KEY]);
  const map = stored[CACHE_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getWordDefinitionCacheMap() {
  const stored = await chrome.storage.local.get([WORD_DEFINITION_CACHE_KEY]);
  const map = stored[WORD_DEFINITION_CACHE_KEY];
  return map && typeof map === "object" ? map : {};
}

export async function getWordCefrCacheMap() {
  const stored = await chrome.storage.local.get([WORD_CEFR_CACHE_KEY]);
  const map = stored[WORD_CEFR_CACHE_KEY];
  return map && typeof map === "object" ? map : {};
}

function normalizeDefinitionLemma(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/^'+|'+$/g, "");
}

function normalizeDefinitionCefr(value) {
  const level = String(value || "").trim().toUpperCase();
  return level || "unknown";
}

export function buildWordDefinitionCacheKey(lemma, cefr) {
  const lemmaKey = normalizeDefinitionLemma(lemma);
  const cefrKey = normalizeDefinitionCefr(cefr);
  return lemmaKey ? `${lemmaKey}||${cefrKey}` : "";
}

export function buildWordCefrCacheKey(lemma) {
  return normalizeDefinitionLemma(lemma);
}

export async function clearCache() {
  await chrome.storage.local.set({
    [CACHE_KEY]: {},
    [WORD_DEFINITION_CACHE_KEY]: {},
    [WORD_CEFR_CACHE_KEY]: {}
  });
}

export async function pruneExpiredCacheEntries() {
  const map = await getCacheMap();
  const now = Date.now();
  let changed = false;

  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object" || !entry.expiresAt || entry.expiresAt < now) {
      delete map[key];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [CACHE_KEY]: map });
  }
}

export async function pruneExpiredWordDefinitionEntries() {
  const map = await getWordDefinitionCacheMap();
  const now = Date.now();
  let changed = false;

  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object" || !entry.expiresAt || entry.expiresAt < now) {
      delete map[key];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [WORD_DEFINITION_CACHE_KEY]: map });
  }
}

export async function pruneExpiredWordCefrEntries() {
  const map = await getWordCefrCacheMap();
  const now = Date.now();
  let changed = false;

  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== "object" || !entry.expiresAt || entry.expiresAt < now) {
      delete map[key];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.local.set({ [WORD_CEFR_CACHE_KEY]: map });
  }
}

export async function getCachedResponse(cacheKey) {
  const map = await getCacheMap();
  const entry = map[cacheKey];
  if (!entry || !entry.expiresAt || entry.expiresAt < Date.now()) {
    return null;
  }
  return entry.response;
}

export async function saveCachedResponse(cacheKey, requestPayload, responsePayload) {
  const map = await getCacheMap();
  const now = Date.now();
  map[cacheKey] = {
    createdAt: now,
    expiresAt: now + CACHE_TTL_MS,
    request: requestPayload,
    response: responsePayload
  };
  await chrome.storage.local.set({
    [CACHE_KEY]: map
  });
}

export async function saveWordDefinitions(entries) {
  const map = await getWordDefinitionCacheMap();
  const now = Date.now();
  let changed = false;

  for (const item of Array.isArray(entries) ? entries : []) {
    const key = buildWordDefinitionCacheKey(item?.lemma, item?.cefr);
    const definition = typeof item?.definition_simple === "string" ? item.definition_simple.trim() : "";
    const example = typeof item?.example_simple === "string" ? item.example_simple.trim() : "";
    if (!key || !definition || !example) {
      continue;
    }
    map[key] = {
      createdAt: now,
      expiresAt: now + WORD_DEFINITION_CACHE_TTL_MS,
      pos: typeof item?.pos === "string" ? item.pos : "other",
      definition_simple: definition,
      example_simple: example
    };
    changed = true;
  }

  if (changed) {
    await chrome.storage.local.set({
      [WORD_DEFINITION_CACHE_KEY]: map
    });
  }
}

export async function saveWordCefrDecisions(entries) {
  const map = await getWordCefrCacheMap();
  const now = Date.now();
  let changed = false;

  for (const item of Array.isArray(entries) ? entries : []) {
    const key = buildWordCefrCacheKey(item?.lemma || item?.word);
    const cefr = normalizeDefinitionCefr(item?.cefr);
    if (!key || !cefr || cefr === "UNKNOWN") {
      continue;
    }
    map[key] = {
      createdAt: now,
      expiresAt: now + WORD_CEFR_CACHE_TTL_MS,
      cefr
    };
    changed = true;
  }

  if (changed) {
    await chrome.storage.local.set({
      [WORD_CEFR_CACHE_KEY]: map
    });
  }
}
