import { test } from "node:test";
import assert from "node:assert";
import { parseFinalJudgement, buildFinalJudgePrompt, type FinalJudgeInput } from "../reference/finalJudge";

test("parseFinalJudgement — čistý JSON", () => {
  const r = parseFinalJudgement('{"verdict":"ultra_wow","reason":"Čistý ve všech registrech, skvělá reference."}');
  assert.equal(r.verdict, "ultra_wow");
  assert.match(r.reason, /registrech/);
});

test("parseFinalJudgement — JSON v markdown bloku", () => {
  const r = parseFinalJudgement('```json\n{"verdict":"wow","reason":"Solidní, chybí reference."}\n```');
  assert.equal(r.verdict, "wow");
});

test("parseFinalJudgement — neznámý verdict hodí chybu", () => {
  assert.throws(() => parseFinalJudgement('{"verdict":"super","reason":"x"}'));
});

test("parseFinalJudgement — reason ořezán na 140 znaků", () => {
  const long = "a".repeat(300);
  const r = parseFinalJudgement(`{"verdict":"reject","reason":"${long}"}`);
  assert.ok(r.reason.length <= 140);
});

test("buildFinalJudgePrompt — nedostupná reference je v promptu jako měkký signál", () => {
  const input: FinalJudgeInput = {
    name: "Jan Novák", score: 88, scoringReason: "x", aiNote: null,
    income: 60000, employment: "HPP", personsCount: 2, hasPets: false, pets: null,
    moveReason: null, additionalComment: null, hasExecutions: false, hasInsolvency: false,
    referenceResult: null, referenceNote: null, referenceReachable: false,
    isirResult: "clean", ceeResult: "clean", rent: 20000, city: "Praha",
  };
  const p = buildFinalJudgePrompt(input);
  assert.match(p, /NEDOSTUPNÁ/);
  assert.match(p, /60000 Kč/);
});
