(function initEasyReadPopup() {
  const state = {
    enabled: true,
    hasSeenOnboarding: false,
    busy: false
  };

  const toggleButton = document.getElementById("toggle-enabled");
  const dismissButton = document.getElementById("dismiss-onboarding");
  const onboardingCard = document.getElementById("onboarding-card");
  const heroState = document.getElementById("hero-state");
  const powerHeading = document.getElementById("power-heading");
  const powerCopy = document.getElementById("power-copy");
  const statusEl = document.getElementById("popup-status");

  if (!toggleButton || !dismissButton || !onboardingCard || !heroState || !powerHeading || !powerCopy || !statusEl) {
    return;
  }

  toggleButton.addEventListener("click", () => {
    void updateSettings({ enabled: !state.enabled });
  });

  dismissButton.addEventListener("click", () => {
    void updateSettings({ hasSeenOnboarding: true }, "Onboarding hidden.");
  });

  void loadSettings();

  async function loadSettings() {
    setStatus("Loading...");
    try {
      const response = await sendRuntimeMessage({ type: "easyread-get-settings" });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not load EasyRead settings.");
      }
      applySettings(response.data || {});
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load EasyRead settings.");
    }
  }

  async function updateSettings(patch, successMessage = "") {
    if (state.busy) {
      return;
    }
    state.busy = true;
    render();
    setStatus("Saving...");
    try {
      const response = await sendRuntimeMessage({
        type: "easyread-update-settings",
        payload: patch
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not save EasyRead settings.");
      }
      applySettings(response.data || {});
      setStatus(successMessage);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save EasyRead settings.");
    } finally {
      state.busy = false;
      render();
    }
  }

  function applySettings(settings) {
    state.enabled = typeof settings.enabled === "boolean" ? settings.enabled : state.enabled;
    state.hasSeenOnboarding =
      typeof settings.hasSeenOnboarding === "boolean"
        ? settings.hasSeenOnboarding
        : state.hasSeenOnboarding;
    render();
  }

  function render() {
    heroState.textContent = state.enabled ? "On" : "Off";
    heroState.dataset.state = state.enabled ? "on" : "off";
    powerHeading.textContent = state.enabled ? "EasyRead is active" : "EasyRead is paused";
    powerCopy.textContent = state.enabled
      ? "Explain buttons and right-click actions are ready."
      : "Pages stay quiet until you turn it back on.";
    toggleButton.textContent = state.enabled ? "Turn Off" : "Turn On";
    toggleButton.dataset.enabled = String(state.enabled);
    toggleButton.disabled = state.busy;
    dismissButton.disabled = state.busy;
    onboardingCard.hidden = state.hasSeenOnboarding;
  }

  function setStatus(text) {
    statusEl.textContent = String(text || "");
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error("EasyRead runtime is unavailable."));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }
})();
