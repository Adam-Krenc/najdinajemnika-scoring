import { test } from "node:test";
import assert from "node:assert/strict";
import { splitName, parseIsirResults, isErrorPage } from "../isir/lookup";

test("splitName: jméno + příjmení", () => {
  assert.deepEqual(splitName("Jan Novák"), { jmeno: "Jan", nazev: "Novák" });
});

test("splitName: víc křestních jmen → poslední slovo je příjmení", () => {
  assert.deepEqual(splitName("Jan Petr Novák"), { jmeno: "Jan Petr", nazev: "Novák" });
});

test("splitName: jediné slovo → jen příjmení", () => {
  assert.deepEqual(splitName("Novák"), { jmeno: "", nazev: "Novák" });
});

test("splitName: ořeže okolní mezery a zdvojené mezery", () => {
  assert.deepEqual(splitName("  Jan   Novák  "), { jmeno: "Jan", nazev: "Novák" });
});

test("parseIsirResults: vyčte počet z textu", () => {
  assert.equal(parseIsirResults("Počet nalezených záznamů: 3"), 3);
});

test("parseIsirResults: nula nalezených", () => {
  assert.equal(parseIsirResults("Počet nalezených záznamů: 0"), 0);
});

test("parseIsirResults: fallback na řádky tabulky detailů", () => {
  const html =
    '<a href="/isir/usl/vec-detail.do?id=1">a</a><a href="/isir/usl/vec-detail.do?id=2">b</a>';
  assert.equal(parseIsirResults(html), 2);
});

test("parseIsirResults: žádná shoda → 0", () => {
  assert.equal(parseIsirResults("<html>nic tu není</html>"), 0);
});

test("isErrorPage: detekuje chybu serveru", () => {
  assert.equal(isErrorPage("... Chyba serveru ..."), true);
  assert.equal(isErrorPage("HTTP Error 500"), true);
  assert.equal(isErrorPage("Nedostupný systém"), true);
});

test("isErrorPage: normální stránka → false", () => {
  assert.equal(isErrorPage("Počet nalezených záznamů: 0"), false);
});
