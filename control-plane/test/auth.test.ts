// Mirrors packages/discovery-index/test/auth.test.ts exactly (same source, duplicated per auth.ts's own
// header comment) -- ported to node:test since control-plane uses that runner, not vitest.
import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSharedSecret, verifyBearer } from "../dist/index.js";

test("normalizeSharedSecret trims copied whitespace and surrounding quotes", () => {
  assert.equal(normalizeSharedSecret('  "sek"\n'), "sek");
  assert.equal(normalizeSharedSecret(" 'sek' "), "sek");
  assert.equal(normalizeSharedSecret(" \n "), undefined);
  assert.equal(normalizeSharedSecret(undefined), undefined);
  assert.equal(normalizeSharedSecret('""'), undefined); // quotes stripped from an empty string stay empty
});

test("verifyBearer accepts normalized service secrets and bearer tokens", () => {
  assert.equal(verifyBearer("Bearer sek", "sek"), true);
  assert.equal(verifyBearer("Bearer   sek  ", ' "sek"\n'), true);
  assert.equal(verifyBearer("bearer sek", "sek"), true);
});

test("verifyBearer rejects missing, malformed, and mismatched headers", () => {
  assert.equal(verifyBearer(undefined, "sek"), false);
  assert.equal(verifyBearer("Basic sek", "sek"), false);
  assert.equal(verifyBearer("Bearer nope", "sek"), false);
  assert.equal(verifyBearer("Bearer sek", " \n "), false);
  assert.equal(verifyBearer("Bearer sekret", "sek"), false);
});
