export function createTranscriptTurnQueue({ runTurn }) {
  let running = false;
  let buffered = [];
  let current = Promise.resolve();

  async function drain(text) {
    running = true;
    try {
      await runTurn(text);
    } finally {
      if (buffered.length > 0) {
        const next = buffered.join("\n");
        buffered = [];
        current = drain(next);
      } else {
        running = false;
      }
    }
  }

  function enqueue(text) {
    const trimmed = text.trim();
    if (!trimmed) return current;
    if (running) {
      buffered.push(trimmed);
      return current;
    }
    current = drain(trimmed);
    return current;
  }

  async function idle() {
    while (running || buffered.length > 0) {
      await current;
    }
  }

  return { enqueue, idle };
}
