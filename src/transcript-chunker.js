const DEFAULT_PUNCTUATION = new Set([".", "!", "?", ";", ":", ","]);

export function chunkTranscriptAtPunctuation(transcript, punctuation = DEFAULT_PUNCTUATION) {
  const chunks = [];
  let current = "";

  for (const char of String(transcript ?? "")) {
    current += char;
    if (punctuation.has(char)) {
      pushChunk(chunks, current);
      current = "";
    }
  }

  pushChunk(chunks, current);
  return chunks;
}

function pushChunk(chunks, text) {
  const trimmed = text.trim();
  if (trimmed) chunks.push(trimmed);
}
