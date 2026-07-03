// Units for the undocumented-export analyzer (#2035). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAddedExports,
  exportedSymbols,
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

test("exportedSymbols: multi-declarator const/let/var reports every binding; generics don't fabricate names", () => {
  assert.deepEqual(exportedSymbols("export const a = 1, b = 2;"), ["a", "b"]);
  assert.deepEqual(exportedSymbols("export let x = f(1, 2), y = 3;"), ["x", "y"]); // comma inside a call doesn't split
  assert.deepEqual(exportedSymbols("export const m: Map<K, V> = new Map(), n = 2;"), ["m", "n"]); // no fabricated `V`
  assert.deepEqual(exportedSymbols("export function foo() {}"), ["foo"]); // single-symbol kinds unchanged
  assert.deepEqual(exportedSymbols("export const { a, b } = obj;"), []); // destructuring skipped (conservative)
  assert.deepEqual(exportedSymbols("const notExported = 1;"), []); // not an export
});

test("scanUndocumentedExport: a multi-declarator export reports EVERY undocumented binding", async () => {
  const patch = ["@@ -0,0 +1,1 @@", "+export const alpha = 1, beta = 2;"].join("\n");
  const head = "export const alpha = 1, beta = 2;";
  const findings = await scanUndocumentedExport(req([{ path: "src/index.ts", status: "modified", patch }]), headFetch(head));
  assert.deepEqual(findings, [
    { file: "src/index.ts", line: 1, symbol: "alpha" },
    { file: "src/index.ts", line: 1, symbol: "beta" },
  ]);
});

test("hasPrecedingDocComment: a `//` line or block-comment end above (through blanks) counts as documented", () => {
  assert.equal(hasPrecedingDocComment(["/** doc */", "export const x = 1;"], 1), true);
  assert.equal(hasPrecedingDocComment(["// note", "", "export const x = 1;"], 2), true);
  assert.equal(hasPrecedingDocComment(["export const prev = 0;", "export const x = 1;"], 1), false);
  assert.equal(hasPrecedingDocComment(["export const x = 1;"], 0), false); // nothing above
  // a CODE line with a trailing block comment ends in `*/` but is not documentation
  assert.equal(hasPrecedingDocComment(["const c = 1; /* trailing */", "export const x = 1;"], 1), false);
  // a multi-line JSDoc block counts; a plain (non-doc) block comment does NOT
  assert.equal(hasPrecedingDocComment(["/**", " * doc", " */", "export const x = 1;"], 3), true);
  assert.equal(hasPrecedingDocComment(["/* eslint-disable */", "export const x = 1;"], 1), false);
  assert.equal(hasPrecedingDocComment(["/*", " plain", " */", "export const x = 1;"], 3), false);
  // a doc comment above a DECORATOR on the export still counts (decorator lines are skipped while walking up)
  assert.equal(hasPrecedingDocComment(["/** doc */", "@Component()", "export class Widget {}"], 2), true);
  assert.equal(hasPrecedingDocComment(["@Component()", "export class Widget {}"], 1), false); // decorator only, no doc
});

test("scanUndocumentedExport: flags the undocumented export, not the documented one, and renders it", async () => {
  const findings = await scanUndocumentedExport(req([{ path: "src/index.ts", status: "modified", patch: PATCH }]), headFetch(HEAD));
  assert.deepEqual(findings, [{ file: "src/index.ts", line: 4, symbol: "undoc" }]);
  const brief = renderBrief({ undocumentedExport: findings }).promptSection;
  assert.match(brief, /Undocumented public exports/i);
  assert.match(brief, /undoc/);
});

test("scanUndocumentedExport: fetches the entrypoint at the head ref with a per-segment-encoded path", async () => {
  let calledUrl = "";
  const recording = async (url) => {
    calledUrl = url;
    return url.includes("/contents/") ? rawResponse(HEAD) : new Response("", { status: 404 });
  };
  await scanUndocumentedExport(req([{ path: "src/dir name/index.ts", status: "modified", patch: PATCH }]), recording);
  // path segments are individually encoded (space -> %20) and the head SHA is passed as ?ref=
  assert.match(calledUrl, /\/repos\/octo\/repo\/contents\/src\/dir%20name\/index\.ts\?ref=abc123$/);
});

test("parseAddedExports: an INDENTED export (e.g. an unexported-namespace member) is not scanned — top-level only", () => {
  const patch = ["@@ -1,0 +1,1 @@", "+  export const nested = 1;"].join("\n");
  assert.deepEqual(parseAddedExports(patch), []); // column-1 anchor: only public module-level exports count
});

test("scanUndocumentedExport: an export inside an unexported namespace is not reported (not public API)", async () => {
  const nsPatch = ["@@ -0,0 +1,3 @@", "+namespace Internal {", "+  export const helper = 1;", "+}"].join("\n");
  const nsHead = ["namespace Internal {", "  export const helper = 1;", "}"].join("\n");
  const findings = await scanUndocumentedExport(
    req([{ path: "src/index.ts", status: "modified", patch: nsPatch }]),
    headFetch(nsHead),
  );
  assert.deepEqual(findings, []); // the indented namespace member is not a public export → no false positive
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

test("scanUndocumentedExport: an oversized response (content-length over the cap) is not read → no finding", async () => {
  const oversized = async (url) =>
    url.includes("/contents/")
      ? new Response(HEAD, { status: 200, headers: { "content-length": "2000000" } }) // > MAX_FETCH_BYTES (1 MB)
      : new Response("", { status: 404 });
  const findings = await scanUndocumentedExport(
    req([{ path: "src/index.ts", status: "modified", patch: PATCH }]),
    oversized,
  );
  assert.deepEqual(findings, []); // the bounded-read guard bails before parsing content
});

test("scanUndocumentedExport: entrypoints without added exports don't consume the file budget", async () => {
  // MAX_FILES worth of index files that add NO export must not crowd out a later index file that does.
  const noop = "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;";
  const fillers = Array.from({ length: 10 }, (_, i) => ({ path: `p${i}/index.ts`, status: "modified", patch: noop }));
  const real = { path: "real/index.ts", status: "modified", patch: PATCH };
  const findings = await scanUndocumentedExport(req([...fillers, real]), headFetch(HEAD));
  assert.deepEqual(findings, [{ file: "real/index.ts", line: 4, symbol: "undoc" }]);
});

test("scanUndocumentedExport: preserves the { file, line, symbol } contract through the render", async () => {
  const findings = await scanUndocumentedExport(req([{ path: "pkg/index.ts", status: "modified", patch: PATCH }]), headFetch(HEAD));
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ["file", "line", "symbol"]);
  assert.deepEqual(findings[0], { file: "pkg/index.ts", line: 4, symbol: "undoc" });
  const brief = renderBrief({ undocumentedExport: findings }).promptSection;
  assert.match(brief, /pkg\/index\.ts:4/); // file:line preserved by the inline renderer
  assert.match(brief, /\bundoc\b/); // symbol preserved
});

test("scanUndocumentedExport: a rejected fetch or a non-OK (404) response yields no finding (fail-safe)", async () => {
  const files = [{ path: "src/index.ts", status: "modified", patch: PATCH }];
  const rejecting = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await scanUndocumentedExport(req(files), rejecting), []); // fetch throws → caught → no finding
  const notOk = async () => new Response("nope", { status: 404 });
  assert.deepEqual(await scanUndocumentedExport(req(files), notOk), []); // resp.ok false → content skipped
});

test("scanUndocumentedExport: no token or no headSha → skipped (no finding, no throw)", async () => {
  const files = [{ path: "src/index.ts", status: "modified", patch: PATCH }];
  assert.deepEqual(await scanUndocumentedExport(req(files, { githubToken: undefined }), headFetch(HEAD)), []);
  assert.deepEqual(await scanUndocumentedExport(req(files, { headSha: undefined }), headFetch(HEAD)), []);
});
