(function initEasyReadContentScript() {
  if (window.__easyreadMounted) {
    return;
  }
  window.__easyreadMounted = true;

  const HARD_MAX_CHARS = 12000;
  const CHUNK_THRESHOLD_CHARS = 4500;
  const WARMUP_COOLDOWN_MS = 45_000;
  const CEFR_RANK = {
    A1: 0,
    A2: 1,
    B1: 2,
    B2: 3,
    C1: 4,
    C2: 5,
    unknown: 0
  };

  const state = {
    selectedText: "",
    selectionRect: null,
    pinned: false,
    lastResult: null,
    lastSelectionText: "",
    currentRequestId: "",
    wordsFetchRequestId: "",
    wordsPending: false,
    explanationMode: "balanced",
    wordLevelThreshold: "B2",
    showExplanation: true,
    showWords: true,
    streamedExplanation: "",
    isExplainInFlight: false,
    lastWarmupAt: 0
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
      <section class="easyread-section easyread-explanation-section">
        <div class="easyread-section-head">
          <h3 class="easyread-section-title">Explanation</h3>
          <button
            class="easyread-section-toggle"
            type="button"
            data-action="toggle-explanation"
            aria-label="Toggle explanation section"
          >
            On
          </button>
        </div>
        <div class="easyread-text easyread-explanation-panel" data-panel="explanation"></div>
      </section>
      <section class="easyread-section easyread-words-section">
        <div class="easyread-section-head">
          <h3 class="easyread-section-title">Words</h3>
          <button
            class="easyread-section-toggle"
            type="button"
            data-action="toggle-words"
            aria-label="Toggle words section"
          >
            On
          </button>
        </div>
        <div class="easyread-word-level-row">
          <div class="easyread-inline-setting easyread-inline-setting-words">
            <select id="easyread-word-level" class="easyread-level-select" aria-label="Word level threshold">
              <option value="B2">B2+</option>
              <option value="C1">C1+</option>
              <option value="C2">C2</option>
            </select>
          </div>
        </div>
        <div class="easyread-words-panel" data-panel="words"></div>
      </section>
    </div>
    <div class="easyread-footer">
      <div class="easyread-control-row">
        <div class="easyread-mode-actions">
          <button class="easyread-secondary-btn" type="button" data-action="mode-simple">More Simple</button>
          <button class="easyread-secondary-btn" type="button" data-action="mode-detailed">More Detail</button>
        </div>
      </div>
      <div class="easyread-status" data-status>Ready</div>
    </div>
  `;
  root.appendChild(overlay);

  const statusEl = overlay.querySelector("[data-status]");
  const explanationSection = overlay.querySelector(".easyread-explanation-section");
  const wordsSection = overlay.querySelector(".easyread-words-section");
  const wordsLevelRow = overlay.querySelector(".easyread-word-level-row");
  const explanationPanel = overlay.querySelector('[data-panel="explanation"]');
  const wordsPanel = overlay.querySelector('[data-panel="words"]');
  const pinButton = overlay.querySelector('[data-action="pin"]');
  const modeSimpleButton = overlay.querySelector('[data-action="mode-simple"]');
  const modeDetailedButton = overlay.querySelector('[data-action="mode-detailed"]');
  const toggleExplanationButton = overlay.querySelector('[data-action="toggle-explanation"]');
  const toggleWordsButton = overlay.querySelector('[data-action="toggle-words"]');
  const modeActions = overlay.querySelector(".easyread-mode-actions");
  const wordLevelSelect = overlay.querySelector("#easyread-word-level");

  let selectionTimer = null;

  explainButton.addEventListener("click", () => runExplain());
  updateModeButtons();
  updateVisibilityButtons();
  applySectionVisibility();
  updateWordLevelControl();
  if (wordLevelSelect) {
    wordLevelSelect.addEventListener("change", () => {
      void handleWordLevelChange(wordLevelSelect.value);
    });
  }
  void initializeOverlaySettings();

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
      return;
    }
    if (action === "mode-simple") {
      rerunWithMode("simple");
      return;
    }
    if (action === "mode-detailed") {
      rerunWithMode("detailed");
      return;
    }
    if (action === "toggle-explanation") {
      void handleSectionVisibilityToggle("explanation");
      return;
    }
    if (action === "toggle-words") {
      void handleSectionVisibilityToggle("words");
      return;
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

  const runtimeApi = getRuntimeApi();
  if (runtimeApi?.onMessage?.addListener) {
    runtimeApi.onMessage.addListener((message) => {
      if (message?.type === "easyread-context-explain") {
        const textFromMenu = typeof message.selectionText === "string" ? message.selectionText.trim() : "";
        maybeWarmup();
        runExplain(textFromMenu || getSelectionText());
        return;
      }

      if (message?.type === "easyread-words-update") {
        handleWordsUpdate(message);
        return;
      }

      if (message?.type === "easyread-explanation-stream") {
        handleExplanationStream(message);
      }
    });
  }

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
    maybeWarmup();
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

  async function runExplain(explicitText = "", options = {}) {
    maybeWarmup();
    const isRefine = Boolean(options.isRefine);
    const requestedMode = normalizeExplanationMode(options.explanationMode || state.explanationMode);
    state.explanationMode = requestedMode;
    updateModeButtons();

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
    state.streamedExplanation = "";
    const existingWords = Array.isArray(state.lastResult?.a2_plus_words)
      ? state.lastResult.a2_plus_words
      : [];
    const requestId = createRequestId();
    const wordsOnlyMode = !state.showExplanation && state.showWords;
    state.currentRequestId = requestId;
    state.isExplainInFlight = !wordsOnlyMode;
    showOverlay();
    if (selectedText.length > CHUNK_THRESHOLD_CHARS) {
      showStatus("Large text detected. Creating explanation first...");
    }
    if (wordsOnlyMode) {
      state.wordsPending = true;
      wordsPanel.textContent = "Loading difficult words...";
      showStatus("Loading words...");
    } else {
      setLoading(true, requestedMode, isRefine);
    }

    try {
      if (wordsOnlyMode) {
        const response = await sendRuntimeMessage({
          type: "easyread-fetch-words",
          payload: {
            requestId,
            selectedText,
            pageUrl: window.location.href,
            pageOrigin: window.location.origin,
            explanationMode: requestedMode,
            baseResult: state.lastResult,
            wordsOnly: true
          }
        });
        if (!response?.ok) {
          throw new Error(response?.error || "Failed to load words.");
        }
        if (response.data?.requestId && response.data.requestId !== state.currentRequestId) {
          return;
        }
        if (response.data?.wordLevelThreshold) {
          state.wordLevelThreshold = normalizeWordLevelThreshold(response.data.wordLevelThreshold);
          updateWordLevelControl();
        }
        const wordsResult = response.data?.result;
        if (!wordsResult || typeof wordsResult !== "object") {
          throw new Error("No words result returned.");
        }
        state.lastResult = wordsResult;
        state.wordsPending = false;
        renderWords(wordsResult, false);
        showStatus("Ready");
        return;
      }

      const response = await sendRuntimeMessage({
        type: "easyread-explain",
        payload: {
          requestId,
          selectedText,
          pageUrl: window.location.href,
          pageOrigin: window.location.origin,
          explanationMode: requestedMode
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Failed to explain the selection.");
      }

      if (response.data?.requestId && response.data.requestId !== state.currentRequestId) {
        return;
      }
      if (response.data?.wordLevelThreshold) {
        state.wordLevelThreshold = normalizeWordLevelThreshold(response.data.wordLevelThreshold);
        updateWordLevelControl();
      }

      let nextResult = response.data?.result || null;
      if (isRefine && nextResult && typeof nextResult === "object") {
        const nextWords = Array.isArray(nextResult.a2_plus_words) ? nextResult.a2_plus_words : [];
        if (nextWords.length === 0 && existingWords.length > 0) {
          nextResult = {
            ...nextResult,
            a2_plus_words: existingWords
          };
        }
      }

      state.lastResult = nextResult;
      state.streamedExplanation = "";
      state.wordsPending = !isRefine && Boolean(response.data?.wordsPending);
      const shouldFetchWords = state.showWords && state.wordsPending;
      renderResult(state.lastResult, response.data?.cached, {
        wordsPending: shouldFetchWords,
        explanationMode: requestedMode
      });
      if (shouldFetchWords) {
        void fetchWordsForCurrentRequest({
          requestId,
          selectedText,
          explanationMode: requestedMode
        });
      }
    } catch (error) {
      renderError(error.message || "Failed to explain the selection.");
    } finally {
      state.isExplainInFlight = false;
      if (!wordsOnlyMode) {
        setLoading(false);
      }
    }
  }

  function showOverlay() {
    overlay.hidden = false;
    overlay.style.left = "";
    overlay.style.top = "";
    overlay.style.right = "10px";
    overlay.style.bottom = "12px";
  }

  function renderResult(result, cached, options = {}) {
    if (!result) {
      renderError("No result returned.");
      return;
    }

    renderExplanation(result);
    renderWords(result, options.wordsPending);
    showStatus(options.wordsPending ? "Loading words..." : "Ready");
  }

  function renderExplanation(result) {
    clearNode(explanationPanel);
    const explanationParts = [];
    if (result?.simple_explanation) {
      explanationParts.push(result.simple_explanation);
    }
    if (result?.notes) {
      explanationParts.push(`Note: ${result.notes}`);
    }
    explanationPanel.textContent = explanationParts.join("\n\n") || "No explanation available.";
  }

  function renderWords(result, isPending = false) {
    clearNode(wordsPanel);

    const wordItems = getRenderableWords(result?.a2_plus_words, state.wordLevelThreshold);
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
      return;
    }

    if (result?.words_status === "definitions_unavailable") {
      const detectedWords = Array.isArray(result?.detected_words)
        ? result.detected_words
            .map((word) => String(word || "").trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const detectedSuffix = detectedWords.length > 0 ? ` Detected: ${detectedWords.join(", ")}.` : "";
      const reasonSuffix = result?.words_error ? ` Reason: ${formatWordsErrorReason(result.words_error)}.` : "";
      wordsPanel.textContent = `Words were found, but definitions could not load. Please click Explain again.${reasonSuffix}${detectedSuffix}`;
      return;
    }

    wordsPanel.textContent = isPending
      ? "Loading difficult words..."
      : `No ${formatWordLevelLabel(state.wordLevelThreshold)} words found.`;
  }

  function getRenderableWords(words, wordLevelThreshold = state.wordLevelThreshold) {
    const minLevel = normalizeWordLevelThreshold(wordLevelThreshold);
    return (Array.isArray(words) ? words : []).filter(
      (item) =>
        typeof item?.definition_simple === "string" &&
        item.definition_simple.trim() &&
        typeof item?.example_simple === "string" &&
        item.example_simple.trim() &&
        isCefrAtOrAboveThreshold(item?.cefr, minLevel)
    );
  }

  function handleWordsUpdate(message) {
    const incomingRequestId =
      typeof message?.requestId === "string" ? message.requestId.trim() : "";
    if (!incomingRequestId || incomingRequestId !== state.currentRequestId) {
      return;
    }

    if (message?.error) {
      wordsPanel.textContent = message.error;
      showStatus("Words failed");
      return;
    }

    const result = message?.result;
    if (!result || typeof result !== "object") {
      return;
    }

    const prevExplanation = String(state.lastResult?.simple_explanation || "").trim();
    state.lastResult = result;
    state.wordsPending = false;
    if (message?.wordLevelThreshold) {
      state.wordLevelThreshold = normalizeWordLevelThreshold(message.wordLevelThreshold);
      updateWordLevelControl();
    }
    if (message?.explanationMode) {
      state.explanationMode = normalizeExplanationMode(message.explanationMode);
      updateModeButtons();
    }
    renderWords(result, false);
    const nextExplanation = String(result?.simple_explanation || "").trim();
    if (!prevExplanation && nextExplanation) {
      renderExplanation(result);
    }
    showStatus("Ready");
  }

  function handleExplanationStream(message) {
    const incomingRequestId = typeof message?.requestId === "string" ? message.requestId.trim() : "";
    if (!incomingRequestId || incomingRequestId !== state.currentRequestId) {
      return;
    }
    if (!state.isExplainInFlight) {
      return;
    }

    const delta = typeof message?.delta === "string" ? message.delta : "";
    if (delta) {
      state.streamedExplanation += delta;
      const partial = state.streamedExplanation.trim();
      if (partial) {
        explanationPanel.textContent = partial;
        const hasWords = getRenderableWords(state.lastResult?.a2_plus_words, state.wordLevelThreshold).length > 0;
        if (!hasWords) {
          wordsPanel.textContent = "Loading difficult words...";
        }
        showStatus("Streaming...");
      }
    }
  }

  function renderError(message) {
    clearNode(explanationPanel);
    clearNode(wordsPanel);
    explanationPanel.textContent = message;
    wordsPanel.textContent = "No data.";
    showStatus("Error");
  }

  async function fetchWordsForCurrentRequest({ requestId, selectedText, explanationMode }) {
    const current = typeof requestId === "string" ? requestId.trim() : "";
    if (!current || current !== state.currentRequestId) {
      return;
    }
    if (state.wordsFetchRequestId === current) {
      return;
    }
    state.wordsFetchRequestId = current;

    try {
      const response = await sendRuntimeMessage({
        type: "easyread-fetch-words",
        payload: {
          requestId: current,
          selectedText,
          pageUrl: window.location.href,
          pageOrigin: window.location.origin,
          explanationMode,
          baseResult: state.lastResult
        }
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Failed to load words.");
      }
      if (response.data?.requestId && response.data.requestId !== state.currentRequestId) {
        return;
      }
      if (response.data?.wordLevelThreshold) {
        state.wordLevelThreshold = normalizeWordLevelThreshold(response.data.wordLevelThreshold);
        updateWordLevelControl();
      }

      const result = response.data?.result;
      if (!result || typeof result !== "object") {
        throw new Error("No words result returned.");
      }

      const prevExplanation = String(state.lastResult?.simple_explanation || "").trim();
      state.lastResult = result;
      state.wordsPending = false;
      renderWords(result, false);
      const nextExplanation = String(result?.simple_explanation || "").trim();
      if (!prevExplanation && nextExplanation) {
        renderExplanation(result);
      }
      showStatus("Ready");
    } catch (error) {
      if (current !== state.currentRequestId) {
        return;
      }
      wordsPanel.textContent =
        error instanceof Error && error.message
          ? error.message
          : "Words took too long. Please try again.";
      state.wordsPending = false;
      showStatus("Words failed");
    } finally {
      if (state.wordsFetchRequestId === current) {
        state.wordsFetchRequestId = "";
      }
    }
  }

  function setLoading(isLoading, explanationMode = "balanced", isRefine = false) {
    if (isLoading) {
      showStatus(isRefine ? "Updating..." : "Working...");
      explanationPanel.innerHTML = '<div class="easyread-loading">Creating explanation</div>';
      const hasExistingWords =
        getRenderableWords(state.lastResult?.a2_plus_words, state.wordLevelThreshold).length > 0;
      if (!isRefine || !hasExistingWords) {
        wordsPanel.textContent = "";
      }
    } else if (
      !statusEl.textContent ||
      statusEl.textContent.startsWith("Working") ||
      statusEl.textContent.startsWith("Updating")
    ) {
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
    if (state.showExplanation) {
      lines.push("");
      lines.push("Explanation:");
      lines.push(result.simple_explanation || "");
    }
    const wordItems = getRenderableWords(result.a2_plus_words, state.wordLevelThreshold);

    if (state.showWords && wordItems.length > 0) {
      lines.push("");
      lines.push(`Words (${formatWordLevelLabel(state.wordLevelThreshold)}):`);
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

  function createRequestId() {
    if (typeof crypto?.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  async function initializeOverlaySettings() {
    try {
      const response = await sendRuntimeMessage({ type: "easyread-get-settings" });
      if (!response?.ok) {
        return;
      }
      const threshold = response?.data?.wordLevelThreshold;
      if (threshold) {
        state.wordLevelThreshold = normalizeWordLevelThreshold(threshold);
        updateWordLevelControl();
      }
      state.showExplanation = normalizeVisibilityValue(response?.data?.showExplanation, state.showExplanation);
      state.showWords = normalizeVisibilityValue(response?.data?.showWords, state.showWords);
      ensureAtLeastOneSectionVisible();
      applySectionVisibility();
      updateVisibilityButtons();
    } catch (_error) {
      // Keep local defaults if settings load fails.
    }
  }

  async function handleSectionVisibilityToggle(section) {
    if (section === "explanation" && state.showExplanation && !state.showWords) {
      showStatus("Keep one section on.");
      return;
    }
    if (section === "words" && state.showWords && !state.showExplanation) {
      showStatus("Keep one section on.");
      return;
    }

    const previous = {
      showExplanation: state.showExplanation,
      showWords: state.showWords
    };

    if (section === "explanation") {
      state.showExplanation = !state.showExplanation;
    } else if (section === "words") {
      state.showWords = !state.showWords;
    } else {
      return;
    }
    ensureAtLeastOneSectionVisible();
    applySectionVisibility();
    updateVisibilityButtons();

    try {
      const response = await sendRuntimeMessage({
        type: "easyread-update-settings",
        payload: {
          showExplanation: state.showExplanation,
          showWords: state.showWords
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to save setting.");
      }

      state.showExplanation = normalizeVisibilityValue(response?.data?.showExplanation, state.showExplanation);
      state.showWords = normalizeVisibilityValue(response?.data?.showWords, state.showWords);
      ensureAtLeastOneSectionVisible();
      applySectionVisibility();
      updateVisibilityButtons();

      const turnedExplanationOn = !previous.showExplanation && state.showExplanation;
      if (turnedExplanationOn && !state.isExplainInFlight && !hasExplanationContent(state.lastResult)) {
        const selectedText = (state.lastSelectionText || state.selectedText || getSelectionText()).trim();
        if (selectedText) {
          showStatus("Loading explanation...");
          await runExplain(selectedText, {
            explanationMode: state.explanationMode,
            isRefine: true
          });
          return;
        }
      }

      if (
        state.showWords &&
        state.wordsPending &&
        !state.wordsFetchRequestId &&
        state.currentRequestId &&
        state.lastResult &&
        hasNoRenderableWords(state.lastResult, "B2")
      ) {
        const selectedText = (state.lastSelectionText || state.selectedText || getSelectionText()).trim();
        if (selectedText) {
          wordsPanel.textContent = "Loading difficult words...";
          showStatus("Loading words...");
          await fetchWordsForCurrentRequest({
            requestId: state.currentRequestId,
            selectedText,
            explanationMode: state.explanationMode
          });
        }
      }
    } catch (_error) {
      state.showExplanation = previous.showExplanation;
      state.showWords = previous.showWords;
      ensureAtLeastOneSectionVisible();
      applySectionVisibility();
      updateVisibilityButtons();
      showStatus("Save failed");
    }
  }

  async function handleWordLevelChange(nextLevel) {
    const normalizedNext = normalizeWordLevelThreshold(nextLevel);
    const previous = state.wordLevelThreshold;
    if (normalizedNext === previous) {
      return;
    }

    state.wordLevelThreshold = normalizedNext;
    updateWordLevelControl();

    try {
      const response = await sendRuntimeMessage({
        type: "easyread-update-settings",
        payload: {
          wordLevelThreshold: normalizedNext
        }
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Failed to save setting.");
      }

      const savedLevel = normalizeWordLevelThreshold(response?.data?.wordLevelThreshold || normalizedNext);
      state.wordLevelThreshold = savedLevel;
      updateWordLevelControl();

      const selectedText = (state.lastSelectionText || state.selectedText || getSelectionText()).trim();
      if (!selectedText || !state.lastResult || !state.showWords) {
        showStatus("Saved");
        return;
      }

      const requestId = state.currentRequestId || createRequestId();
      state.currentRequestId = requestId;
      showStatus("Applying level...");
      const refilterResponse = await sendRuntimeMessage({
        type: "easyread-refilter-words",
        payload: {
          requestId,
          selectedText,
          pageUrl: window.location.href,
          pageOrigin: window.location.origin,
          explanationMode: state.explanationMode,
          baseResult: state.lastResult
        }
      });
      if (!refilterResponse?.ok) {
        throw new Error(refilterResponse?.error || "Failed to apply word level.");
      }
      if (refilterResponse.data?.requestId && refilterResponse.data.requestId !== state.currentRequestId) {
        return;
      }
      if (refilterResponse.data?.wordLevelThreshold) {
        state.wordLevelThreshold = normalizeWordLevelThreshold(refilterResponse.data.wordLevelThreshold);
        updateWordLevelControl();
      }
      if (refilterResponse.data?.result && typeof refilterResponse.data.result === "object") {
        state.lastResult = refilterResponse.data.result;
      }
      renderWords(state.lastResult, false);
      showStatus("Ready");
    } catch (_error) {
      state.wordLevelThreshold = previous;
      updateWordLevelControl();
      showStatus("Save failed");
    }
  }

  function maybeWarmup() {
    const now = Date.now();
    if (now - state.lastWarmupAt < WARMUP_COOLDOWN_MS) {
      return;
    }
    state.lastWarmupAt = now;
    sendRuntimeMessage({ type: "easyread-warmup" }).catch(() => {});
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      const runtime = getRuntimeApi();
      if (!runtime || typeof runtime.sendMessage !== "function") {
        reject(
          new Error(
            "EasyRead extension context is unavailable. Reload the extension in chrome://extensions and refresh this page."
          )
        );
        return;
      }

      runtime.sendMessage(message, (response) => {
        if (runtime.lastError) {
          reject(new Error(runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function getRuntimeApi() {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || typeof runtime !== "object") {
      return null;
    }
    return runtime;
  }

  function rerunWithMode(mode) {
    const nextMode = normalizeExplanationMode(mode);
    state.explanationMode = nextMode;
    updateModeButtons();
    const text = state.lastSelectionText || state.selectedText || getSelectionText();
    void runExplain(text, { explanationMode: nextMode, isRefine: true });
  }

  function updateModeButtons() {
    if (modeSimpleButton) {
      modeSimpleButton.dataset.active = state.explanationMode === "simple" ? "true" : "false";
    }
    if (modeDetailedButton) {
      modeDetailedButton.dataset.active = state.explanationMode === "detailed" ? "true" : "false";
    }
  }

  function updateVisibilityButtons() {
    if (toggleExplanationButton) {
      toggleExplanationButton.dataset.active = state.showExplanation ? "true" : "false";
      toggleExplanationButton.textContent = state.showExplanation ? "On" : "Off";
      toggleExplanationButton.disabled = state.showExplanation && !state.showWords;
    }
    if (toggleWordsButton) {
      toggleWordsButton.dataset.active = state.showWords ? "true" : "false";
      toggleWordsButton.textContent = state.showWords ? "On" : "Off";
      toggleWordsButton.disabled = state.showWords && !state.showExplanation;
    }
  }

  function ensureAtLeastOneSectionVisible() {
    if (!state.showExplanation && !state.showWords) {
      state.showExplanation = true;
    }
  }

  function applySectionVisibility() {
    if (explanationPanel) {
      explanationPanel.hidden = !state.showExplanation;
    }
    if (wordsLevelRow) {
      wordsLevelRow.hidden = !state.showWords;
    }
    if (wordsPanel) {
      wordsPanel.hidden = !state.showWords;
    }
    if (wordLevelSelect) {
      wordLevelSelect.disabled = !state.showWords;
    }
    if (modeActions) {
      modeActions.hidden = !state.showExplanation;
    }
    if (explanationSection) {
      explanationSection.dataset.sectionVisible = state.showExplanation ? "true" : "false";
    }
    if (wordsSection) {
      wordsSection.dataset.sectionVisible = state.showWords ? "true" : "false";
    }
  }

  function updateWordLevelControl() {
    if (!wordLevelSelect) {
      return;
    }
    const value = normalizeWordLevelThreshold(state.wordLevelThreshold);
    if (wordLevelSelect.value !== value) {
      wordLevelSelect.value = value;
    }
  }

  function normalizeExplanationMode(mode) {
    const raw = typeof mode === "string" ? mode.trim().toLowerCase() : "";
    if (raw === "simple" || raw === "detailed" || raw === "balanced") {
      return raw;
    }
    return "balanced";
  }

  function normalizeWordLevelThreshold(value) {
    const raw = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (raw === "B2" || raw === "C1" || raw === "C2") {
      return raw;
    }
    return "B2";
  }

  function formatWordLevelLabel(level) {
    const normalized = normalizeWordLevelThreshold(level);
    return normalized === "C2" ? "C2" : `${normalized}+`;
  }

  function normalizeCefrLevel(value) {
    const level = typeof value === "string" ? value.trim().toUpperCase() : "";
    if (level === "A1" || level === "A2" || level === "B1" || level === "B2" || level === "C1" || level === "C2") {
      return level;
    }
    return "unknown";
  }

  function isCefrAtOrAboveThreshold(cefr, wordLevelThreshold = "B2") {
    const currentRank = CEFR_RANK[normalizeCefrLevel(cefr)] || 0;
    const minRank = CEFR_RANK[normalizeWordLevelThreshold(wordLevelThreshold)] || CEFR_RANK.B2;
    return currentRank >= minRank;
  }

  function normalizeVisibilityValue(value, fallback = true) {
    if (typeof value === "boolean") {
      return value;
    }
    return Boolean(fallback);
  }

  function formatWordsErrorReason(code) {
    const value = String(code || "").trim().toUpperCase();
    if (value === "RATE_LIMIT") {
      return "Rate limit reached";
    }
    if (value === "EXTENSION_NOT_ALLOWED") {
      return "Extension ID not allowed";
    }
    if (value === "REQUEST_INVALID") {
      return "Request rejected by server";
    }
    if (value === "SERVER_TEMPORARY") {
      return "Server temporary error";
    }
    if (value === "NETWORK") {
      return "Network error";
    }
    if (value === "TIMEOUT") {
      return "Word request timed out";
    }
    if (value === "OUTPUT_CUTOFF") {
      return "Word response was cut off";
    }
    if (value === "INCOMPLETE") {
      return "Word response incomplete";
    }
    if (value === "MODEL_FAILED") {
      return "Model failed for word request";
    }
    if (value === "EMPTY_MODEL_OUTPUT") {
      return "Model returned no word entries";
    }
    if (value === "PROXY_ERROR") {
      return "Proxy error";
    }
    return "Unknown error";
  }

  function hasNoRenderableWords(result, wordLevelThreshold = state.wordLevelThreshold) {
    return getRenderableWords(result?.a2_plus_words, wordLevelThreshold).length === 0;
  }

  function hasExplanationContent(result) {
    return typeof result?.simple_explanation === "string" && result.simple_explanation.trim().length > 0;
  }

  function getModeLabel(mode) {
    if (mode === "simple") {
      return "simple";
    }
    if (mode === "detailed") {
      return "detailed";
    }
    return "balanced";
  }
})();
