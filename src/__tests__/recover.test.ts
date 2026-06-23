import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScoringInput,
  DEFAULT_STUCK_MINUTES,
  DEFAULT_BATCH_LIMIT,
} from "../scoring/recoverInput";

const listing = {
  city: "Praha",
  size: "2+kk",
  rent: 18000,
  maxPersons: 2,
  petsAllowed: "domluva",
  tenantPref: "bez preference",
};

test("buildScoringInput mapuje listing 1:1", () => {
  const input = buildScoringInput({ hasPets: false }, listing);
  assert.deepEqual(input.listing, listing);
});

test("buildScoringInput mapuje vyplněná pole žadatele", () => {
  const input = buildScoringInput(
    {
      dateOfBirth: "1990-05-01",
      income: 60000,
      employment: "HPP",
      incomeProofUrl: "https://x/y.pdf",
      personsCount: 2,
      hasPets: true,
      moveReason: "koupil byt",
      hasExecutions: true,
      executionDebt: "20000",
      executionComment: "doplaceno",
      hasInsolvency: false,
      message: "dobrý den",
      additionalComment: "nekuřák",
    },
    listing
  );
  assert.equal(input.applicant.income, 60000);
  assert.equal(input.applicant.employment, "HPP");
  assert.equal(input.applicant.hasPets, true);
  assert.equal(input.applicant.hasExecutions, true);
  assert.equal(input.applicant.executionDebt, "20000");
  assert.equal(input.applicant.message, "dobrý den");
});

test("buildScoringInput převádí undefined na null/false (žádné chybějící klíče)", () => {
  const input = buildScoringInput({ hasPets: false }, listing);
  assert.equal(input.applicant.income, null);
  assert.equal(input.applicant.employment, null);
  assert.equal(input.applicant.moveReason, null);
  assert.equal(input.applicant.hasExecutions, false);
  assert.equal(input.applicant.hasInsolvency, false);
});

test("buildScoringInput zrcadlí leads route — neposílá householdMembers ani pole pets", () => {
  const input = buildScoringInput({ hasPets: true }, listing) as Record<string, any>;
  // Kanonický payload (app/api/leads/route.ts) předává jen hasPets.
  assert.equal((input.applicant as Record<string, unknown>).pets, undefined);
  assert.equal((input.applicant as Record<string, unknown>).householdMembers, undefined);
});

test("rozumné výchozí konstanty sweeperu", () => {
  assert.equal(DEFAULT_STUCK_MINUTES, 10);
  assert.equal(DEFAULT_BATCH_LIMIT, 25);
});
