const TOKEN_REGEX = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

function normalizeToken(token) {
  return token
    .toLowerCase()
    .replace(/^'+|'+$/g, "")
    .replace(/’/g, "'");
}

function isNumberLike(token) {
  return /^[0-9]+([.,][0-9]+)?$/.test(token);
}

function looksLikeProperNoun(token) {
  if (!token) {
    return false;
  }
  if (/^[A-Z]{2,}$/.test(token)) {
    return true;
  }
  return /^[A-Z][a-z]+(?:-[A-Z][a-z]+)+$/.test(token);
}

function isAllowedVariation(token, easyWordSet) {
  const lower = normalizeToken(token);
  if (!lower) {
    return true;
  }

  if (easyWordSet.has(lower)) {
    return true;
  }

  if (lower.endsWith("'s") && easyWordSet.has(lower.slice(0, -2))) {
    return true;
  }

  const suffixRules = [
    ["ing", 3],
    ["ed", 2],
    ["es", 2],
    ["s", 1],
    ["er", 2],
    ["est", 3],
    ["ly", 2]
  ];

  for (const [suffix, min] of suffixRules) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + min) {
      const stem = lower.slice(0, -suffix.length);
      if (easyWordSet.has(stem)) {
        return true;
      }
      if (suffix === "ing" && easyWordSet.has(`${stem}e`)) {
        return true;
      }
      if ((suffix === "ed" || suffix === "es") && easyWordSet.has(`${stem}e`)) {
        return true;
      }
    }
  }

  return false;
}

export function findHardWords(text, easyWordSet) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const words = text.match(TOKEN_REGEX) || [];
  const hardWords = new Set();

  for (const token of words) {
    if (token.length <= 2 || isNumberLike(token) || looksLikeProperNoun(token)) {
      continue;
    }

    if (!isAllowedVariation(token, easyWordSet)) {
      hardWords.add(normalizeToken(token));
    }
  }

  return [...hardWords];
}

export function collectHardWordsFromResponse(response, easyWordSet) {
  const hardWords = new Set();
  const fields = [];

  if (response.simple_explanation) {
    fields.push(response.simple_explanation);
  }

  for (const item of response.a2_plus_words || []) {
    if (item.definition_simple) {
      fields.push(item.definition_simple);
    }
    if (item.example_simple) {
      fields.push(item.example_simple);
    }
  }

  for (const field of fields) {
    for (const word of findHardWords(field, easyWordSet)) {
      hardWords.add(word);
    }
  }

  return [...hardWords];
}

export function isSimpleEnough(response, easyWordSet) {
  const hardWords = collectHardWordsFromResponse(response, easyWordSet);
  return {
    isValid: hardWords.length === 0,
    hardWords
  };
}

export function extractA2PlusCandidates(selectedText, easyWordSet, maxCount = 24) {
  const words = selectedText.match(TOKEN_REGEX) || [];
  const candidates = new Map();

  for (const token of words) {
    if (token.length <= 2 || looksLikeProperNoun(token)) {
      continue;
    }
    const normalized = normalizeToken(token);
    if (!normalized || isAllowedVariation(normalized, easyWordSet)) {
      continue;
    }
    if (!candidates.has(normalized)) {
      candidates.set(normalized, token);
      if (candidates.size >= maxCount) {
        break;
      }
    }
  }

  return [...candidates.values()];
}

export function findMissingCandidateWords(candidates, a2PlusWords) {
  const covered = new Set();

  for (const item of a2PlusWords || []) {
    const word = normalizeToken(item?.word || "");
    const lemma = normalizeToken(item?.lemma || "");
    if (word) {
      covered.add(word);
    }
    if (lemma) {
      covered.add(lemma);
    }
  }

  return (candidates || []).filter((candidate) => {
    const normalized = normalizeToken(candidate);
    return normalized && !covered.has(normalized);
  });
}
