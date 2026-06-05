import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScoringPrompt, ScoringInput } from "../scoring/prompt";

const baseListing: ScoringInput["listing"] = {
  city: "Praha",
  size: "2+kk",
  rent: 18000,
  maxPersons: 2,
  petsAllowed: "ne",
  tenantPref: "zaměstnaný",
};

function input(applicant: Partial<ScoringInput["applicant"]>): ScoringInput {
  return {
    listing: baseListing,
    applicant: { hasPets: false, ...applicant },
  };
}

test("obsahuje údaje o bytě", () => {
  const p = buildScoringPrompt(input({}));
  assert.match(p, /Praha/);
  assert.match(p, /2\+kk/);
  assert.match(p, /18000 Kč/);
});

test("příjem s doložením označí jako (doloženo)", () => {
  const p = buildScoringPrompt(input({ income: 50000, incomeProofUrl: "https://x/doc.pdf" }));
  assert.match(p, /50000 Kč\/měs \(doloženo\)/);
});

test("příjem bez doložení označí jako (nedoloženo)", () => {
  const p = buildScoringPrompt(input({ income: 50000 }));
  assert.match(p, /\(nedoloženo\)/);
});

test("chybějící příjem → neuvedeno", () => {
  const p = buildScoringPrompt(input({}));
  assert.match(p, /Příjem: neuvedeno/);
});

test("přiznané exekuce se promítnou do promptu", () => {
  const p = buildScoringPrompt(
    input({ hasExecutions: true, executionDebt: "120 000 Kč", executionComment: "splácím" })
  );
  assert.match(p, /Exekuce \(vlastní přiznání\): ANO — 120 000 Kč splácím/);
});

test("bez exekucí → ne", () => {
  const p = buildScoringPrompt(input({ hasExecutions: false }));
  assert.match(p, /Exekuce \(vlastní přiznání\): ne/);
});

test("mazlíčci s detaily se vypíšou", () => {
  const p = buildScoringPrompt(
    input({ hasPets: true, pets: [{ type: "pes", breed: "labrador" }] })
  );
  assert.match(p, /Mazlíčci: pes \(labrador\)/);
});

test("hasPets bez detailů", () => {
  const p = buildScoringPrompt(input({ hasPets: true }));
  assert.match(p, /Mazlíčci: ano \(bez detailů\)/);
});

test("členové domácnosti se zformátují", () => {
  const p = buildScoringPrompt(
    input({ householdMembers: [{ name: "Jan Novák", dateOfBirth: "1990-01-01" }] })
  );
  assert.match(p, /Jan Novák \(nar. 1990-01-01\)/);
});
