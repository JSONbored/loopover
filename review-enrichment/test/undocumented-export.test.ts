// Units for the undocumented-export analyzer (#2035). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAddedExports,
  hasPrecedingDocComment,
  scanUndocumentedExport,
} from "../dist/analyzers/undocumented-export.js";
import { renderBrief } from "../dist/render.js";

// The head file that this PR produces: a documented export (preceding JSDoc) and an undocumented one.
const HEAD = ["/** A documented helper. */", "export function documented() {}", "", "export const undoc = 1;"].join("\n");
// The diff that added both exports (new-file lines 1-4 line up with HEAD).
const PATCH = ["@@ -0,0 +1,4 @@", "+/** A documented helper. */", "+export function documented() {}", "+", "+export const undoc = 1;"].join("\n");

const rawResponse = (text) => new Response(text, { status: 200 });
const headFetch = (text) => async (url) => (url.includes("/contents/") ? rawResponse(text) : new Response("", { status: 404 }));
const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

test("parseAddedExports: collects direct added exports with new-file line numbers, ignores re-exports", () => {
  assert.deepEqual(parseAddedExports(PATCH), [
    { symbol: "documented", newLine: 2 },
    { symbol: "undoc", newLine: 4 },
  ]);
  // context/deletions keep the new-line cursor aligned; `export { x }` and `export *` are not direct declarations
  const mixed = ["@@ -5,2 +5,3 @@", " const keep = 1;", "-old", "+export type Added = string;", "+export { Added };", "+export * from './x';"].join("\n");
  assert.deepEqual(parseAddedExports(mixed), [{ symbol: "Added", newLine: 6 }]);
});

test("hasPrecedingDocComment: a `//` line or block-comment end above (through blanks) counts as documented", () => {
  assert.equal(hasPrecedingDocComment(["/** doc */", "export const x = 1;"], 1), true);
  assert.equal(hasPrecedingDocComment(["// note", "", "export const x = 1;"], 2), true);
  assert.equal(hasPrecedingDocComment(["export const prev = 0;", "export const x = 1;"], 1), false);
  assert.equal(hasPrecedingDocComment(["export const x = 1;"], 0), false); // nothing above
});

test("scanUndocumentedExport: flags the undocumented export, not the documented one, and renders it", async () => {
  const findings = await scanUndocumentedExport(req([{ path: "src/index.ts", status: "modified", patch: PATCH }]), headFetch(HEAD));
  assert.deepEqual(findings, [{ file: "src/index.ts", line: 4, symbol: "undoc" }]);
  const brief = renderBrief({ undocumentedExport: findings }).promptSection;
  assert.match(brief, /Undocumented public exports/i);
  assert.match(brief, /undoc/);
});

test("scanUndocumentedExport: a non-entrypoint file is skipped (only index.* is scanned)", async () => {
  const findings = await scanUndocumentedExport(
    req([{ path: "src/helpers.ts", status: "modified", patch: PATCH }]),
    headFetch(HEAD),
  );
  assert.deepEqual(findings, []);
});

test("scanUndocumentedExport: an export whose head line no longer declares it is skipped (fail closed)", async () => {
  // HEAD does not contain `undoc` at line 4 → the added export cannot be confirmed → no finding.
  const shifted = ["export const somethingElse = 2;", "", "", "export const alsoElse = 3;"].join("\n");
  const findings = await scanUndocumentedExport(
    req([{ path: "src/index.ts", status: "modified", patch: PATCH }]),
    headFetch(shifted),
  );
  assert.deepEqual(findings, []);
});

test("scanUndocumentedExport: no token or no headSha → skipped (no finding, no throw)", async () => {
  const files = [{ path: "src/index.ts", status: "modified", patch: PATCH }];
  assert.deepEqual(await scanUndocumentedExport(req(files, { githubToken: undefined }), headFetch(HEAD)), []);
  assert.deepEqual(await scanUndocumentedExport(req(files, { headSha: undefined }), headFetch(HEAD)), []);
});
