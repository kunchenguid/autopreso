import assert from "node:assert/strict";
import { test } from "node:test";

import { STARTER_ELEMENTS } from "../public/starter-elements.js";

test("starter scene uses explicit text instead of a clipped bound label", () => {
  const title = STARTER_ELEMENTS.find((element) => element.id === "title");
  const card = STARTER_ELEMENTS.find((element) => element.id === "starter-card");
  const hint = STARTER_ELEMENTS.find((element) => element.id === "starter-hint");

  assert.equal(title.type, "text");
  assert.equal(title.text, "AutoPreso");
  assert.ok(title.width >= estimateHandwrittenWidth(title.text, title.fontSize));
  assert.equal(card.type, "rectangle");
  assert.equal(card.label, undefined);
  assert.ok(card.y + card.height <= 205);
  assert.equal(hint.type, "text");
  assert.equal(hint.text, "Start listening, then\ntalk through an idea.");
  assert.equal(hint.fontFamily, 1);
  assert.ok(hint.width >= estimateHandwrittenWidth("Start listening, then", hint.fontSize));
  assert.ok(hint.width >= estimateHandwrittenWidth("talk through an idea.", hint.fontSize));
  assert.ok(hint.x > card.x);
  assert.ok(hint.x + hint.width < card.x + card.width);
});

function estimateHandwrittenWidth(text, fontSize) {
  return text.length * fontSize * 0.85;
}
