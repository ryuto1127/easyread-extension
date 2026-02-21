(function initEasyReadContentScript() {
  if (window.__easyreadMounted) {
    return;
  }
  window.__easyreadMounted = true;

  const HARD_MAX_CHARS = 12000;
  const CHUNK_THRESHOLD_CHARS = 4500;

  const state = {
    selectedText: "",
    selectionRect: null,
    pinned: false,
    lastResult: null,
    lastSelectionText: ""
  };

  const root = document.createElement("div");
  root.id = "easyread-root";
  document.documentElement.appendChild(root);

  const explainButton = document.createElement("button");
  explainButton.className = "easyread-floating-button";
  explainButton.type = "button";
  explainButton.textContent = "Explain";
  explainButton.hidden = true;
  root.appendChild(explainButton);

  const overlay = document.createElement("section");
  overlay.className = "easyread-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="easyread-header">
      <div class="easyread-title">EasyRead</div>
      <div class="easyread-header-actions">
        <button class="easyread-icon-btn" type="button" data-action="copy">Copy</button>
        <button class="easyread-icon-btn" type="button" data-action="pin">Pin</button>
        <button class="easyread-icon-btn" type="button" data-action="close">Close</button>
      </div>
    </div>
    <div class="easyread-body">
      <section class="easyread-section">
        <h3 class="easyread-section-title">Explanation</h3>
        <div class="easyread-text" data-panel="explanation"></div>
      </section>
      <section class="easyread-section">
        <h3 class="easyread-section-title">Words</h3>
        <div data-panel="words"></div>
      </section>
    </div>
    <div class="easyread-footer">
      <div class="easyread-status" data-status>Ready</div>
    </div>
  `;
  root.appendChild(overlay);

  const statusEl = overlay.querySelector("[data-status]");
  const explanationPanel = overlay.querySelector('[data-panel="explanation"]');
  const wordsPanel = overlay.querySelector('[data-panel="words"]');
  const pinButton = overlay.querySelector('[data-action="pin"]');

  let selectionTimer = null;

  explainButton.addEventListener("click", () => runExplain());

  overlay.addEventListener("click", (event) => {
    const action = event.target?.getAttribute("data-action");

    if (action === "close") {
      state.pinned = false;
      pinButton.textContent = "Pin";
      overlay.hidden = true;
      return;
    }
    if (action === "pin") {
      state.pinned = !state.pinned;
      pinButton.textContent = state.pinned ? "Unpin" : "Pin";
      return;
    }
    if (action === "copy") {
      copyLastResult();
    }
  });

  document.addEventListener("mouseup", scheduleSelectionCheck);
  document.addEventListener("keyup", scheduleSelectionCheck);
  document.addEventListener(
    "mousedown",
    (event) => {
      const target = event.target;
      if (target instanceof Node && root.contains(target)) {
        return;
      }
      if (!state.pinned) {
        explainButton.hidden = true;
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "easyread-context-explain") {
      const textFromMenu = typeof message.selectionText === "string" ? message.selectionText.trim() : "";
      runExplain(textFromMenu || getSelectionText());
    }
  });

  function scheduleSelectionCheck() {
    if (selectionTimer) {
      clearTimeout(selectionTimer);
    }
    selectionTimer = window.setTimeout(updateSelectionButton, 80);
  }

  function updateSelectionButton() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (!state.pinned) {
        explainButton.hidden = true;
      }
      return;
    }

    const text = selection.toString().trim();
    if (!text || text.length > HARD_MAX_CHARS) {
      if (!state.pinned) {
        explainButton.hidden = true;
      }
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
      if (!state.pinned) {
        explainButton.hidden = true;
      }
      return;
    }

    state.selectedText = text;
    state.selectionRect = rect;
    positionExplainButton(rect);
    explainButton.hidden = false;
  }

  function positionExplainButton(rect) {
    const buttonWidth = 72;
    const buttonHeight = 34;
    const margin = 8;
    let top = rect.bottom + margin;
    let left = rect.left;

    if (left + buttonWidth > window.innerWidth - 8) {
      left = window.innerWidth - buttonWidth - 8;
    }
    if (top + buttonHeight > window.innerHeight - 8) {
      top = rect.top - buttonHeight - margin;
    }
    if (top < 8) {
      top = 8;
    }
    if (left < 8) {
      left = 8;
    }

    explainButton.style.top = `${Math.round(top)}px`;
    explainButton.style.left = `${Math.round(left)}px`;
  }

  async function runExplain(explicitText = "") {
    const selectedText = (explicitText || getSelectionText() || state.selectedText).trim();
    if (!selectedText) {
      showStatus("Please select text first.");
      return;
    }
    if (selectedText.length > HARD_MAX_CHARS) {
      showOverlay();
      renderError(
        `Selection is too long (${selectedText.length} chars). Max is ${HARD_MAX_CHARS}.`
      );
      return;
    }

    state.lastSelectionText = selectedText;
    showOverlay();
    if (selectedText.length > CHUNK_THRESHOLD_CHARS) {
      showStatus("Large text detected. Processing in parts...");
    }
    setLoading(true);

    try {
      const response = await sendRuntimeMessage({
        type: "easyread-explain",
        payload: {
          selectedText,
          pageUrl: window.location.href,
          pageOrigin: window.location.origin
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Failed to explain the selection.");
      }

      state.lastResult = response.data?.result || null;
      renderResult(state.lastResult, response.data?.cached);
    } catch (error) {
      renderError(error.message || "Failed to explain the selection.");
    } finally {
      setLoading(false);
    }
  }

  function showOverlay() {
    overlay.hidden = false;
    overlay.style.left = "";
    overlay.style.top = "";
    overlay.style.right = "10px";
    overlay.style.bottom = "12px";
  }

  function renderResult(result, cached) {
    if (!result) {
      renderError("No result returned.");
      return;
    }

    clearNode(explanationPanel);
    clearNode(wordsPanel);

    const explanationParts = [];
    if (result.simple_explanation) {
      explanationParts.push(result.simple_explanation);
    }
    if (result.notes) {
      explanationParts.push(`Note: ${result.notes}`);
    }
    explanationPanel.textContent = explanationParts.join("\n\n") || "No explanation available.";

    const wordItems = (Array.isArray(result.a2_plus_words) ? result.a2_plus_words : []).filter(
      (item) =>
        typeof item?.definition_simple === "string" &&
        item.definition_simple.trim() &&
        typeof item?.example_simple === "string" &&
        item.example_simple.trim()
    );

    if (wordItems.length > 0) {
      for (const item of wordItems) {
        const card = document.createElement("article");
        card.className = "easyread-word-item";

        const head = document.createElement("div");
        head.className = "easyread-word-head";
        const word = document.createElement("span");
        word.className = "easyread-word";
        word.textContent = item.word || "";
        const meta = document.createElement("span");
        meta.className = "easyread-word-meta";
        meta.textContent = `${item.lemma || ""} • ${item.pos || "other"} • ${item.cefr || "unknown"}`;
        head.appendChild(word);
        head.appendChild(meta);

        const def = document.createElement("div");
        def.textContent = `Meaning: ${item.definition_simple || ""}`;
        const ex = document.createElement("div");
        ex.textContent = `Example: ${item.example_simple || ""}`;

        card.appendChild(head);
        card.appendChild(def);
        card.appendChild(ex);
        wordsPanel.appendChild(card);
      }
    } else {
      wordsPanel.textContent = "No words above B1 found.";
    }

    const confidence = typeof result.confidence === "number" ? result.confidence.toFixed(2) : "0.50";
    showStatus(`${cached ? "Cache hit" : "Fresh"} • confidence ${confidence}`);
  }

  function renderError(message) {
    clearNode(explanationPanel);
    clearNode(wordsPanel);
    explanationPanel.textContent = message;
    wordsPanel.textContent = "No data.";
    showStatus("Error");
  }

  function setLoading(isLoading) {
    if (isLoading) {
      showStatus("Working...");
      explanationPanel.innerHTML = '<div class="easyread-loading">Creating explanation</div>';
      wordsPanel.textContent = "";
    } else if (!statusEl.textContent || statusEl.textContent === "Working...") {
      showStatus("Ready");
    }
  }

  function showStatus(text) {
    statusEl.textContent = text;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function getSelectionText() {
    const selection = window.getSelection();
    return selection ? selection.toString().trim() : "";
  }

  async function copyLastResult() {
    if (!state.lastResult) {
      showStatus("Nothing to copy yet.");
      return;
    }
    const text = formatForCopy(state.lastResult);
    try {
      await navigator.clipboard.writeText(text);
      showStatus("Copied");
    } catch (_err) {
      showStatus("Copy failed");
    }
  }

  function formatForCopy(result) {
    const lines = [];
    lines.push("EasyRead");
    lines.push("");
    lines.push("Explanation:");
    lines.push(result.simple_explanation || "");
    const wordItems = (Array.isArray(result.a2_plus_words) ? result.a2_plus_words : []).filter(
      (item) =>
        typeof item?.definition_simple === "string" &&
        item.definition_simple.trim() &&
        typeof item?.example_simple === "string" &&
        item.example_simple.trim()
    );

    if (wordItems.length > 0) {
      lines.push("");
      lines.push("Words above B1:");
      for (const item of wordItems) {
        lines.push(
          `- ${item.word} (${item.lemma}, ${item.pos}, ${item.cefr}): ${item.definition_simple} Example: ${item.example_simple}`
        );
      }
    }
    if (result.notes) {
      lines.push("");
      lines.push(`Note: ${result.notes}`);
    }
    return lines.join("\n");
  }

  function sendRuntimeMessage(message) {
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
})();
