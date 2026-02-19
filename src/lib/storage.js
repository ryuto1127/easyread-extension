import { CACHE_KEY, CACHE_TTL_MS, DEFAULT_SETTINGS, SETTINGS_KEY } from "./constants.js";

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

export async function clearCache() {
  await chrome.storage.local.set({
    [CACHE_KEY]: {}
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
