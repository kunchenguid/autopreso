export function normalizeWhiteboardElements(elements) {
  if (!Array.isArray(elements)) return [];

  return elements;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "diamond"]);
const CHAR_WIDTH_RATIO = 0.6;
const PADDING_PER_SIDE = 24;

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function estimateTextBox(text, fontSize) {
  const fs = fontSize ?? 18;
  const lines = String(text ?? "").split("\n");
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  return {
    width: Math.ceil(longest * fs * CHAR_WIDTH_RATIO),
    height: Math.ceil(lines.length * fs * 1.25),
  };
}

export function detectMalformedLayoutWarnings(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return [];
  const warnings = [];
  const shapes = elements.filter((el) => SHAPE_TYPES.has(el?.type));
  const texts = elements.filter((el) => el?.type === "text");

  // 1. Standalone text overlapping a shape -> should have been a label.
  for (const text of texts) {
    if (typeof text.x !== "number" || typeof text.y !== "number") continue;
    const estimated = estimateTextBox(text.text, text.fontSize);
    const textBox = {
      x: text.x,
      y: text.y,
      width: typeof text.width === "number" ? text.width : estimated.width,
      height: typeof text.height === "number" ? text.height : estimated.height,
    };
    for (const shape of shapes) {
      if (typeof shape.width !== "number" || typeof shape.height !== "number") continue;
      if (rectanglesOverlap(textBox, shape)) {
        const preview = (text.text ?? "").slice(0, 40);
        warnings.push(
          `LAYOUT WARNING: standalone text "${preview}" (id "${text.id}") overlaps shape "${shape.id}". Excalidraw renders standalone text by your literal coordinates, so it bleeds outside the shape. Replace the text element with a label on the shape: { "type": "${shape.type}", "id": "${shape.id}", ..., "label": { "text": "${preview}", "fontSize": ${text.fontSize ?? 18} } }. Then Excalidraw will center it inside the shape and wrap correctly.`,
        );
        break;
      }
    }
  }

  // 2. Labeled shape too narrow / short for its label.
  for (const shape of shapes) {
    const labelText = shape?.label?.text;
    if (typeof labelText !== "string" || labelText.length === 0) continue;
    const fontSize = shape.label.fontSize ?? 18;
    const estimated = estimateTextBox(labelText, fontSize);
    const minWidth = estimated.width + PADDING_PER_SIDE * 2;
    const minHeight = estimated.height + PADDING_PER_SIDE * 2;
    if (typeof shape.width === "number" && shape.width < minWidth) {
      warnings.push(
        `LAYOUT WARNING: shape "${shape.id}" is ${shape.width}px wide but its label "${labelText.slice(0, 40)}" needs about ${minWidth}px (text + padding). Either widen the shape or shorten the label - otherwise the label text will overflow the shape's edges.`,
      );
    }
    if (typeof shape.height === "number" && shape.height < minHeight) {
      warnings.push(
        `LAYOUT WARNING: shape "${shape.id}" is ${shape.height}px tall but its label "${labelText.slice(0, 40)}" needs about ${minHeight}px. Either grow the shape or shorten the label.`,
      );
    }
  }

  return warnings;
}
