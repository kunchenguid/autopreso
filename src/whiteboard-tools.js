export function formatLineNumberedWhiteboard(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return "(empty whiteboard)";

  const width = Math.max(3, String(elements.length).length);
  return elements
    .map((element, index) => `${String(index + 1).padStart(width, "0")}: ${JSON.stringify(element)}`)
    .join("\n");
}

export function applyWhiteboardEditOperations(elements, operations) {
  const nextElements = [...elements];

  for (const operation of operations) {
    if (operation.type === "replace") {
      assertLineInRange(operation.line, nextElements.length, `Cannot replace line ${operation.line}`);
      nextElements[operation.line - 1] = operation.element;
      continue;
    }

    if (operation.type === "insert_after") {
      assertLineInInsertRange(operation.line, nextElements.length, `Cannot insert after line ${operation.line}`);
      nextElements.splice(operation.line, 0, operation.element);
      continue;
    }

    if (operation.type === "delete") {
      assertLineInRange(operation.line, nextElements.length, `Cannot delete line ${operation.line}`);
      nextElements.splice(operation.line - 1, 1);
      continue;
    }

    throw new Error(`Unknown whiteboard edit operation "${operation.type}".`);
  }

  return nextElements;
}

function assertLineInRange(line, lineCount, message) {
  if (!Number.isInteger(line) || line < 1 || line > lineCount) {
    throw new Error(`${message}; whiteboard has ${lineCount} line${lineCount === 1 ? "" : "s"}.`);
  }
}

function assertLineInInsertRange(line, lineCount, message) {
  if (!Number.isInteger(line) || line < 0 || line > lineCount) {
    throw new Error(`${message}; whiteboard has ${lineCount} line${lineCount === 1 ? "" : "s"}.`);
  }
}
