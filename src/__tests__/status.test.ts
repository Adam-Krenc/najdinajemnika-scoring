import { test } from "node:test";
import assert from "node:assert/strict";
import { determineScoringStatus, SCORE_THRESHOLD } from "../scoring/status";

test("SCORE_THRESHOLD je 50", () => {
  assert.equal(SCORE_THRESHOLD, 50);
});

test("score přesně na hranici (50) → awaiting_reference", () => {
  assert.equal(determineScoringStatus(50), "awaiting_reference");
});

test("score těsně pod hranicí (49) → rejected_ai", () => {
  assert.equal(determineScoringStatus(49), "rejected_ai");
});

test("vysoké score → awaiting_reference", () => {
  assert.equal(determineScoringStatus(95), "awaiting_reference");
});

test("nulové score → rejected_ai", () => {
  assert.equal(determineScoringStatus(0), "rejected_ai");
});

test("vlastní threshold se respektuje", () => {
  assert.equal(determineScoringStatus(60, 70), "rejected_ai");
  assert.equal(determineScoringStatus(70, 70), "awaiting_reference");
});
