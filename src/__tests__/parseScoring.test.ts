import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJSON, parseScoringResponse } from "../scoring/claude";

test("extractJSON vytáhne JSON z ```json bloku", () => {
  const text = 'Tady je výsledek:\n```json\n{"score": 80}\n```\nHotovo.';
  assert.equal(extractJSON(text), '{"score": 80}');
});

test("extractJSON vytáhne JSON z prostého ``` bloku", () => {
  const text = '```\n{"score": 42}\n```';
  assert.equal(extractJSON(text), '{"score": 42}');
});

test("extractJSON vrátí ořezaný text, když není code fence", () => {
  assert.equal(extractJSON('  {"score": 1}  '), '{"score": 1}');
});

const validResult = JSON.stringify({
  score: 82,
  doporuceni: "doporučujeme",
  oduvodneni: "Stabilní příjem.",
  ai_poznamka: "Solidní žadatel.",
  rizika: [],
  silne_stranky: ["příjem"],
  vyjimecny: false,
});

test("parseScoringResponse naparsuje validní JSON", () => {
  const r = parseScoringResponse(validResult);
  assert.equal(r.score, 82);
  assert.equal(r.doporuceni, "doporučujeme");
});

test("parseScoringResponse clampuje score nad 100", () => {
  const r = parseScoringResponse('{"score": 150}');
  assert.equal(r.score, 100);
});

test("parseScoringResponse clampuje záporné score na 0", () => {
  const r = parseScoringResponse('{"score": -20}');
  assert.equal(r.score, 0);
});

test("parseScoringResponse zaokrouhlí desetinné score", () => {
  const r = parseScoringResponse('{"score": 73.6}');
  assert.equal(r.score, 74);
});

test("parseScoringResponse funguje i s code fence kolem JSON", () => {
  const r = parseScoringResponse("```json\n" + validResult + "\n```");
  assert.equal(r.score, 82);
});

test("parseScoringResponse vyhodí chybu na nevalidním JSON", () => {
  assert.throws(() => parseScoringResponse("tohle není JSON"), /neplatný JSON/);
});
