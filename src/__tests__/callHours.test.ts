import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinCallHours } from "../reference/callHours";

test("9:00 je uvnitř okna (dolní hranice)", () => {
  assert.equal(isWithinCallHours(9), true);
});

test("16:xx je uvnitř okna", () => {
  assert.equal(isWithinCallHours(16), true);
});

test("17:00 je už mimo okno (horní hranice)", () => {
  assert.equal(isWithinCallHours(17), false);
});

test("8:xx je před oknem", () => {
  assert.equal(isWithinCallHours(8), false);
});

test("noční hodiny jsou mimo okno", () => {
  assert.equal(isWithinCallHours(0), false);
  assert.equal(isWithinCallHours(23), false);
});
