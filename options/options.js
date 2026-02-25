import {
  CACHE_KEY,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  WORD_LEVEL_VALUES
} from "../src/lib/constants.js";

const settingsStatusEl = document.getElementById("settingsStatus");
const cacheStatusEl = document.getElementById("cacheStatus");
const clearCacheButton = document.getElementById("clearCache");
const saveWordLevelButton = document.getElementById("saveWordLevel");
const wordLevelSelect = document.getElementById("wordLevelThreshold");

clearCacheButton.addEventListener("click", onClearCache);
saveWordLevelButton.addEventListener("click", onSaveWordLevel);
void loadSettings();

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {})
  };
  wordLevelSelect.value = normalizeWordLevelThreshold(settings.wordLevelThreshold);
}

async function onSaveWordLevel() {
  const selectedLevel = normalizeWordLevelThreshold(wordLevelSelect.value);
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {}),
    wordLevelThreshold: selectedLevel
  };
  await chrome.storage.local.set({
    [SETTINGS_KEY]: nextSettings
  });
  setSettingsStatus(`Saved: ${selectedLevel}+`);
}

async function onClearCache() {
  try {
    const response = await sendMessage({ type: "easyread-clear-cache" });
    if (!response?.ok) {
      throw new Error(response?.error || "Failed to clear cache.");
    }
  } catch (_err) {
    await chrome.storage.local.set({ [CACHE_KEY]: {} });
  }
  setCacheStatus("Cache cleared");
}

function normalizeWordLevelThreshold(value) {
  const level = String(value || "").trim().toUpperCase();
  return WORD_LEVEL_VALUES.includes(level) ? level : DEFAULT_SETTINGS.wordLevelThreshold;
}

function setSettingsStatus(text) {
  settingsStatusEl.textContent = text;
  window.setTimeout(() => {
    if (settingsStatusEl.textContent === text) {
      settingsStatusEl.textContent = "";
    }
  }, 1500);
}

function setCacheStatus(text) {
  cacheStatusEl.textContent = text;
  window.setTimeout(() => {
    if (cacheStatusEl.textContent === text) {
      cacheStatusEl.textContent = "";
    }
  }, 1500);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}
