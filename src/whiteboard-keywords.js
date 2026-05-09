const MIN_TERM_LENGTH = 3;
const DEFAULT_MAX_PROMPT_CHARS = 500;
const PROMPT_PREFIX = "Domain vocabulary that may appear: ";
const PROMPT_SUFFIX = ".";

export function extractWhiteboardKeywords(elements) {
  if (!Array.isArray(elements)) return [];
  const seen = new Map();

  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const sources = [];
    if (element.type === "text" && typeof element.text === "string") {
      sources.push(element.text);
    }
    if (element.label && typeof element.label.text === "string") {
      sources.push(element.label.text);
    }
    for (const source of sources) {
      for (const line of source.split(/\r?\n/)) {
        const term = line.trim();
        if (term.length < MIN_TERM_LENGTH) continue;
        if (!/[a-zA-Z]/.test(term)) continue;
        const key = term.toLowerCase();
        if (!seen.has(key)) seen.set(key, term);
      }
    }
  }

  return [...seen.values()].sort((a, b) => b.length - a.length);
}

export function buildTranscriptionVocabularyPrompt(keywords, { maxChars = DEFAULT_MAX_PROMPT_CHARS } = {}) {
  if (!Array.isArray(keywords) || keywords.length === 0) return "";
  let body = "";
  for (const term of keywords) {
    const next = body.length === 0 ? term : `${body}, ${term}`;
    if (PROMPT_PREFIX.length + next.length + PROMPT_SUFFIX.length > maxChars) continue;
    body = next;
  }
  if (!body) return "";
  return `${PROMPT_PREFIX}${body}${PROMPT_SUFFIX}`;
}
