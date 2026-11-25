import { test } from "node:test";
import assert from "node:assert/strict";
import { TEXT, CITY, SITE, COVER } from "../src/ui/i18n.js";

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("French and English have the same keys, none empty, with the same placeholders", () => {
  const fr = TEXT.fr;
  const en = TEXT.en;
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const k of Object.keys(fr) as (keyof typeof fr)[]) {
    assert.ok(fr[k].trim() && en[k].trim(), `empty text for ${k}`);
    assert.deepEqual(vars(fr[k]), vars(en[k]), `placeholders differ for ${k}`);
  }
  for (const table of [CITY, SITE, COVER]) assert.deepEqual(Object.keys(table.fr).sort(), Object.keys(table.en).sort());
});
