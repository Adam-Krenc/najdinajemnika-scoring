import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateReferenceTranscript } from "../reference/evaluate";

test("bez ANTHROPIC_API_KEY vrátí neutral fallback bez volání API", async () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await evaluateReferenceTranscript("Nějaký přepis hovoru.");
    assert.equal(r.result, "neutral");
    assert.match(r.note, /ANTHROPIC_API_KEY/);
  } finally {
    if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
  }
});
