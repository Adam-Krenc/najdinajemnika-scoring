import { test } from "node:test";
import assert from "node:assert/strict";
import { splitName } from "../cee/lookup";

test("splitName: jméno + příjmení", () => {
  assert.deepEqual(splitName("Jan Novák"), { firstName: "Jan", lastName: "Novák" });
});

test("splitName: víc křestních jmen", () => {
  assert.deepEqual(splitName("Marie Anna Svobodová"), {
    firstName: "Marie Anna",
    lastName: "Svobodová",
  });
});

test("splitName: jediné slovo → jen příjmení", () => {
  assert.deepEqual(splitName("Svoboda"), { firstName: "", lastName: "Svoboda" });
});

test("splitName: ořeže mezery", () => {
  assert.deepEqual(splitName("  Jan  Novák "), { firstName: "Jan", lastName: "Novák" });
});
