import { CACHE_KEY } from "../src/lib/constants.js";

const statusEl = document.getElementById("status");
const clearCacheButton = document.getElementById("clearCache");

clearCacheButton.addEventListener("click", onClearCache);

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
