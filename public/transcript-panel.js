const MAX_COMMITTED_TRANSCRIPTS = 20;

export function appendCommittedTranscript(items, text, limit = MAX_COMMITTED_TRANSCRIPTS) {
  return [...items, text].filter(Boolean).slice(-limit);
}

export function scrollTranscriptToBottom(element) {
  if (!element) return;
  element.scrollTop = element.scrollHeight;
}
