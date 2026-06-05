import { test } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqualStr } from "../lib/secret";

test("shodné řetězce → true", () => {
  assert.equal(timingSafeEqualStr("super-secret-123", "super-secret-123"), true);
});

test("odlišné řetězce stejné délky → false", () => {
  assert.equal(timingSafeEqualStr("aaaaaa", "aaaaab"), false);
});

test("odlišná délka → false (bez výjimky)", () => {
  assert.equal(timingSafeEqualStr("short", "much-longer-secret"), false);
});

test("prázdné řetězce → true", () => {
  assert.equal(timingSafeEqualStr("", ""), true);
});

test("UTF-8 znaky se porovnají správně", () => {
  assert.equal(timingSafeEqualStr("příliš-žluťoučký", "příliš-žluťoučký"), true);
  assert.equal(timingSafeEqualStr("příliš", "prilis"), false);
});
