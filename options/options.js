import { CACHE_KEY, DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/lib/constants.js";

const form = document.getElementById("settings-form");
const statusEl = document.getElementById("status");
const clearCacheButton = document.getElementById("clearCache");

const fields = {
  proxyBaseUrl: document.getElementById("proxyBaseUrl"),
  model: document.getElementById("model"),
  enableModeration: document.getElementById("enableModeration")
};
let currentSettings = { ...DEFAULT_SETTINGS };

init();

async function init() {
  currentSettings = await loadSettings();
  fillForm(currentSettings);
  form.addEventListener("submit", onSave);
  clearCacheButton.addEventListener("click", onClearCache);
}

async function onSave(event) {
  event.preventDefault();
  const next = readForm();
  await chrome.storage.local.set({
    [SETTINGS_KEY]: next
  });
  currentSettings = next;
  setStatus("Saved");
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
  setStatus("Cache cleared");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY]);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored[SETTINGS_KEY] || {})
  };
}

function fillForm(settings) {
  fields.proxyBaseUrl.value = settings.proxyBaseUrl || DEFAULT_SETTINGS.proxyBaseUrl;
  fields.model.value = settings.model || DEFAULT_SETTINGS.model;
  fields.enableModeration.checked = Boolean(settings.enableModeration);
}

function readForm() {
  const proxyBaseUrl = String(fields.proxyBaseUrl.value || DEFAULT_SETTINGS.proxyBaseUrl).trim();
  return {
    ...DEFAULT_SETTINGS,
    ...currentSettings,
    proxyBaseUrl,
    model: String(fields.model.value || DEFAULT_SETTINGS.model).trim(),
    enableModeration: fields.enableModeration.checked
  };
}

function setStatus(text) {
  statusEl.textContent = text;
  window.setTimeout(() => {
    if (statusEl.textContent === text) {
      statusEl.textContent = "";
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
