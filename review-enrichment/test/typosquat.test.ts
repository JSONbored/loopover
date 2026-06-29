// Units for the typosquat + dependency-confusion analyzer (#1501). Kept in its own file (not enrichment.test.ts)
// so concurrent analyzer PRs don't collide on a shared test file. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  damerauLevenshtein,
  canonicalize,
  classifyTyposquat,
  isPublished,
  scanTyposquat,
} from "../dist/analyzers/typosquat.js";
import { renderBrief } from "../dist/render.js";

// A package.json diff that ADDS one dependency (a single `+` line → from === null).
const npmAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"` }],
});

// Fetch stubs returning a minimal Response-like shape (status + ok), matching the other analyzer tests.
const status = (code) => async () => ({ status: code, ok: code >= 200 && code < 300 });
const throwingFetch = async () => {
  throw new Error("network down");
};

test("damerauLevenshtein: substitution, indel, transposition, and bounded early-exit", () => {
  assert.equal(damerauLevenshtein("expres", "express"), 1); // one insertion
  assert.equal(damerauLevenshtein("lodahs", "lodash"), 1); // adjacent transposition
  assert.equal(damerauLevenshtein("axios", "axios"), 0);
  assert.equal(damerauLevenshtein("abc", "xyz"), 3);
  assert.equal(damerauLevenshtein("kitten", "sitting", 2), 3); // exceeds bound → max + 1
  assert.equal(damerauLevenshtein("react", "preact-compat", 2), 3); // length gap > bound short-circuits
});

test("canonicalize maps digit homoglyphs and strips separators", () => {
  assert.equal(canonicalize("l0dash"), "lodash");
  assert.equal(canonicalize("lo-dash"), "lodash");
  assert.equal(canonicalize("LO_DASH"), "lodash");
  assert.equal(canonicalize("expr3ss"), "express");
});

test("classifyTyposquat: exact match is safe", () => {
  assert.equal(classifyTyposquat("npm", "react"), null);
  assert.equal(classifyTyposquat("npm", "React"), null); // case-insensitive
});

test("classifyTyposquat: homoglyph / separator variants", () => {
  assert.deepEqual(classifyTyposquat("npm", "l0dash"), {
    similarTo: "lodash",
    distance: 0,
    reason: "homoglyph/separator variant of 'lodash'",
  });
  assert.equal(classifyTyposquat("npm", "lo-dash")?.similarTo, "lodash");
});

test("classifyTyposquat: scoped names are intentionally not classified (namespace-protected)", () => {
  // Scope-swap is deliberately out of scope: an npm scope cannot be published to without owning it, so a popular
  // tail under any scope is not claimable impersonation. Crucially, the offline tail-vs-popular heuristic cannot
  // tell a legitimate `@chakra-ui/react` / `@types/react` from a hypothetical `@evil/react` without an
  // authoritative scope-ownership source, so it would only manufacture false positives. We flag none.
  assert.equal(classifyTyposquat("npm", "@types/react"), null); // DefinitelyTyped mirrors the name by design
  assert.equal(classifyTyposquat("npm", "@chakra-ui/react"), null); // a real, published, legitimate scoped package
  assert.equal(classifyTyposquat("npm", "@acme/express"), null); // an arbitrary first-party scope
  assert.equal(classifyTyposquat("npm", "@evil/react"), null); // an unfamiliar scope is indistinguishable offline
});

test("classifyTyposquat: known-legitimate near-neighbours are not flagged", () => {
  assert.equal(classifyTyposquat("npm", "preact"), null); // one edit from `react`, but a real package
});

test("classifyTyposquat: edit distance with short-name guard", () => {
  assert.equal(classifyTyposquat("npm", "expres")?.distance, 1); // express, len ok
  assert.equal(classifyTyposquat("PyPI", "reqests")?.similarTo, "requests");
  assert.equal(classifyTyposquat("npm", "ws"), null); // too short to flag a distance-1 neighbour
  assert.equal(classifyTyposquat("npm", "totally-unrelated-name"), null);
  assert.equal(classifyTyposquat("Go", "anything"), null); // unsupported ecosystem
});

test("isPublished: definitive 404/200, undeterminable otherwise", async () => {
  assert.equal(await isPublished("npm", "x", status(404)), false);
  assert.equal(await isPublished("npm", "x", status(200)), true);
  assert.equal(await isPublished("npm", "x", status(500)), null);
  assert.equal(await isPublished("npm", "x", throwingFetch), null);
  assert.equal(await isPublished("Go", "x", status(404)), null); // unsupported ecosystem
  assert.equal(await isPublished("npm", "x", status(404), AbortSignal.abort()), null);
});

test("scanTyposquat flags a typosquat without any registry call", async () => {
  let called = false;
  const findings = await scanTyposquat(npmAdd("expres"), async () => {
    called = true;
    return status(404)();
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "typosquat");
  assert.equal(findings[0].similarTo, "express");
  assert.equal(findings[0].package, "expres");
  assert.equal(called, false); // a name match never needs the registry
});

test("scanTyposquat flags dependency-confusion on a 404 unscoped name", async () => {
  const findings = await scanTyposquat(npmAdd("acme-internal-utils"), status(404));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "confusion");
  assert.match(findings[0].reason, /publicly claimable/);
});

test("scanTyposquat: a published unscoped name is not flagged", async () => {
  const findings = await scanTyposquat(npmAdd("acme-internal-utils"), status(200));
  assert.deepEqual(findings, []);
});

test("scanTyposquat: scoped names are never confusion-checked", async () => {
  let called = false;
  const findings = await scanTyposquat(npmAdd("@acme/internal"), async () => {
    called = true;
    return status(404)();
  });
  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test("scanTyposquat: a version bump (existing name) is ignored", async () => {
  const bump = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "package.json", patch: `@@ -1,1 +1,1 @@\n-  "expres": "^1.0.0"\n+  "expres": "^2.0.0"` }],
  };
  assert.deepEqual(await scanTyposquat(bump, status(404)), []);
});

test("scanTyposquat fails safe when the registry fetch throws", async () => {
  assert.deepEqual(await scanTyposquat(npmAdd("acme-internal-utils"), throwingFetch), []);
});

test("scanTyposquat stops on an already-aborted signal", async () => {
  const findings = await scanTyposquat(npmAdd("expres"), status(404), { signal: AbortSignal.abort() });
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe typosquat block", () => {
  const { promptSection } = renderBrief({
    typosquat: [
      { ecosystem: "npm", package: "expres", version: "1.0.0", kind: "typosquat", similarTo: "express", distance: 1, reason: "edit distance 1 from 'express'" },
      { ecosystem: "npm", package: "acme-internal", version: "0.0.1", kind: "confusion", reason: "not published on the public npm registry — an unscoped name that is publicly claimable (dependency-confusion)" },
    ],
  });
  assert.match(promptSection, /Typosquat \/ dependency-confusion risks/);
  assert.match(promptSection, /likely typosquat of/);
  assert.match(promptSection, /expres@1\.0\.0/);
  assert.match(promptSection, /publicly claimable/);
});
