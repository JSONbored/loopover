// Units for the cross-file caller-impact / dead-symbol analyzer (#1509). Kept in its own file (not
// enrichment.test.ts) so concurrent analyzer PRs don't collide on a shared test file. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRepo,
  parseExportedNames,
  extractExports,
  collectDiffExports,
  isReferencedInDiff,
  referencesSymbol,
  scanCallerImpact,
} from "../dist/analyzers/caller-impact.js";
import { renderBrief } from "../dist/render.js";

const res = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const throwingFetch = async () => {
  throw new Error("network down");
};

// String substring / RegExp router so each test declares only the endpoints it exercises.
function router(routes) {
  return async (url) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (hit) return handler;
    }
    return res({ items: [] });
  };
}

// ── pure helpers ────────────────────────────────────────────────────────────────

test("parseExportedNames covers the common export forms", () => {
  assert.deepEqual(parseExportedNames("export function foo() {}"), ["foo"]);
  assert.deepEqual(parseExportedNames("export async function bar() {}"), ["bar"]);
  assert.deepEqual(parseExportedNames("export const baz = 1;"), ["baz"]);
  assert.deepEqual(parseExportedNames("export class Qux {}"), ["Qux"]);
  assert.deepEqual(parseExportedNames("export interface IThing {}"), ["IThing"]);
  assert.deepEqual(parseExportedNames("export type TThing = string;"), ["TThing"]);
  assert.deepEqual(parseExportedNames("export enum E {}"), ["E"]);
  assert.deepEqual(parseExportedNames("export namespace NS {}"), ["NS"]);
  assert.deepEqual(parseExportedNames("export declare function dfn(): void;"), ["dfn"]);
  assert.deepEqual(parseExportedNames("export default function main() {}"), ["main"]);
  assert.deepEqual(parseExportedNames("export default class App {}"), ["App"]);
  assert.deepEqual(parseExportedNames("  export function indented() {}"), ["indented"]);
});

test("parseExportedNames handles named export lists with aliases", () => {
  assert.deepEqual(parseExportedNames("export { a, b as c, d };"), ["a", "c", "d"]);
  assert.deepEqual(parseExportedNames("export type { T1, T2 };"), ["T1", "T2"]);
  assert.deepEqual(parseExportedNames('export { x } from "./x";'), ["x"]);
});

test("parseExportedNames returns [] for re-export-all, anonymous default, and non-exports", () => {
  assert.deepEqual(parseExportedNames('export * from "./x";'), []);
  assert.deepEqual(parseExportedNames("export default 42;"), []);
  assert.deepEqual(parseExportedNames("const x = 1;"), []);
  assert.deepEqual(parseExportedNames("import { foo } from './a';"), []);
});

test("collectDiffExports splits removed/added exports and added lines", () => {
  const out = collectDiffExports([
    {
      path: "f.ts",
      patch: "@@ -1,1 +1,2 @@\n-export const removed = 1;\n+export const added = 1;\n+useSomething();",
    },
  ]);
  assert.ok(out.removed.has("removed"));
  assert.ok(out.added.has("added"));
  assert.equal(out.addedExportFile.get("added"), "f.ts");
  assert.ok(out.addedLines.includes("useSomething();"));
});

test("isReferencedInDiff ignores the export declaration and escapes regex metachars", () => {
  assert.equal(isReferencedInDiff("added", ["export const added = 1;", "const y = added + 1;"]), true);
  assert.equal(isReferencedInDiff("lonely", ["export const lonely = 1;"]), false);
  assert.equal(isReferencedInDiff("x$", ["foo(x$);"]), true); // `$` must be escaped, not treated as anchor
});

test("parseRepo rejects unsafe names", () => {
  assert.deepEqual(parseRepo("o/r"), { owner: "o", repo: "r" });
  assert.equal(parseRepo("o"), null);
  assert.equal(parseRepo("o/r/x"), null);
  assert.equal(parseRepo("../x"), null);
});

test("referencesSymbol counts real code references, not comments or strings", () => {
  assert.equal(referencesSymbol("import { foo } from './x';", "foo"), true);
  assert.equal(referencesSymbol("bar(foo);", "foo"), true);
  assert.equal(referencesSymbol("// uses foo here", "foo"), false); // line comment
  assert.equal(referencesSymbol(" * @param foo the thing", "foo"), false); // JSDoc continuation
  assert.equal(referencesSymbol("const s = 'foo';", "foo"), false); // string literal
  assert.equal(referencesSymbol("const t = `foo`;", "foo"), false); // template literal
  assert.equal(referencesSymbol("notfoo + foobar", "foo"), false); // substring only
});

test("extractExports joins a multiline export { } block", () => {
  assert.deepEqual(
    extractExports(["export {", "  alpha,", "  beta,", "};"]).flatMap((e) => e.names),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    extractExports(["export const single = 1;"]).flatMap((e) => e.names),
    ["single"],
  );
});

// ── scanCallerImpact ──────────────────────────────────────────────────────────

test("scanCallerImpact: a removed export with external callers is flagged; changed files are excluded", async () => {
  const fetchImpl = router([
    [
      "%22foo%22",
      res({
        items: [
          { path: "src/caller.ts", text_matches: [{ fragment: "import { foo } from './lib';\nfoo();" }] },
          { path: "src/lib.ts", text_matches: [{ fragment: "export function foo() {}" }] },
        ],
      }),
    ],
  ]);
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/lib.ts", patch: "@@ -1,1 +0,0 @@\n-export function foo(a: string): void;" }],
    },
    fetchImpl,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "foo");
  assert.equal(out[0].kind, "removed-with-callers");
  assert.deepEqual(out[0].callerFiles, ["src/caller.ts"]); // src/lib.ts (changed) filtered out
});

test("scanCallerImpact: a signature change with external callers is flagged as changed-with-callers", async () => {
  const fetchImpl = router([
    ["%22bar%22", res({ items: [{ path: "src/caller.ts", text_matches: [{ fragment: "bar(1);" }] }] })],
  ]);
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [
        {
          path: "src/lib.ts",
          patch: "@@ -1,1 +1,1 @@\n-export function bar(a: string): void;\n+export function bar(a: number): void;",
        },
      ],
    },
    fetchImpl,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "changed-with-callers");
});

test("scanCallerImpact: an identical export on both sides (moved) is not searched or flagged", async () => {
  let searched = false;
  const tracking = async (url) => {
    if (url.includes("/search/code")) searched = true;
    return res({ items: [{ path: "src/caller.ts" }] });
  };
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/lib.ts", patch: "@@ -1,1 +1,1 @@\n-export function baz(): void;\n+export function baz(): void;" }],
    },
    tracking,
  );
  assert.deepEqual(out, []);
  assert.equal(searched, false);
});

test("scanCallerImpact: a new export referenced nowhere is dead-on-arrival (no network call)", async () => {
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/util.ts", patch: "@@ -0,0 +1,1 @@\n+export const newThing = 1;" }],
    },
    throwingFetch, // must NOT be called for the dead-on-arrival (diff-only) path
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "newThing");
  assert.equal(out[0].kind, "dead-on-arrival");
  assert.deepEqual(out[0].callerFiles, []);
});

test("scanCallerImpact: a new export used elsewhere in the diff is not dead", async () => {
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/util.ts", patch: "@@ -0,0 +1,2 @@\n+export const used = 1;\n+const x = used + 1;" }],
    },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: a new export from a public entrypoint is not flagged dead", async () => {
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/index.ts", patch: "@@ -0,0 +1,1 @@\n+export const apiThing = 1;" }],
    },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: no token returns [] without any fetch", async () => {
  const out = await scanCallerImpact(
    { repoFullName: "o/r", prNumber: 1, files: [{ path: "src/lib.ts", patch: "@@ @@\n-export function foo(): void;" }] },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: a diff with no export churn returns []", async () => {
  const out = await scanCallerImpact(
    { repoFullName: "o/r", prNumber: 1, githubToken: "t", files: [{ path: "src/lib.ts", patch: "@@ -0,0 +1,1 @@\n+const local = 1;" }] },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: a rate-limited Code Search drops that symbol without throwing", async () => {
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/lib.ts", patch: "@@ -1,1 +0,0 @@\n-export function foo(): void;" }],
    },
    router([["/search/code", res({}, { ok: false, status: 403 })]]),
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: an unsafe repoFullName is rejected before any fetch", async () => {
  const out = await scanCallerImpact(
    { repoFullName: "o/r/../x", prNumber: 1, githubToken: "t", files: [{ path: "a.ts", patch: "@@ @@\n-export const z = 1;" }] },
    throwingFetch,
  );
  assert.deepEqual(out, []);
});

test("scanCallerImpact: a hit only in a comment, string, or markdown is NOT counted as a caller", async () => {
  const fetchImpl = router([
    [
      "%22foo%22",
      res({
        items: [
          { path: "src/comment.ts", text_matches: [{ fragment: "// foo is documented here" }] },
          { path: "docs/readme.md", text_matches: [{ fragment: "the foo helper is great" }] },
          { path: "src/strings.ts", text_matches: [{ fragment: "const label = 'foo';" }] },
        ],
      }),
    ],
  ]);
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/lib.ts", patch: "@@ -1,1 +0,0 @@\n-export function foo(): void;" }],
    },
    fetchImpl,
  );
  assert.deepEqual(out, []); // comment-only, markdown, and string-only matches are not real callers
});

test("scanCallerImpact: a comment mention does not suppress dead-on-arrival", async () => {
  const out = await scanCallerImpact(
    {
      repoFullName: "o/r",
      prNumber: 1,
      githubToken: "t",
      files: [{ path: "src/util.ts", patch: "@@ -0,0 +1,2 @@\n+export const newThing = 1;\n+// TODO wire newThing later" }],
    },
    throwingFetch,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "dead-on-arrival");
  assert.equal(out[0].symbol, "newThing");
});

test("scanCallerImpact: dead-on-arrival runs without a token (diff-only, no network)", async () => {
  const out = await scanCallerImpact(
    { repoFullName: "o/r", prNumber: 1, files: [{ path: "src/util.ts", patch: "@@ -0,0 +1,1 @@\n+export const orphan = 1;" }] },
    throwingFetch, // no token ⇒ no network; must not be called
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "dead-on-arrival");
  assert.equal(out[0].symbol, "orphan");
});

// ── render ──────────────────────────────────────────────────────────────────────

test("renderBrief emits a public-safe caller-impact block", () => {
  const { promptSection } = renderBrief({
    callerImpact: [
      { symbol: "foo", kind: "removed-with-callers", callerFiles: ["src/a.ts", "src/b.ts"] },
      { symbol: "bar", kind: "changed-with-callers", callerFiles: ["src/c.ts"] },
      { symbol: "baz", kind: "dead-on-arrival", callerFiles: [] },
    ],
  });
  assert.match(promptSection, /Cross-file API impact/);
  assert.match(promptSection, /`foo` removed\/renamed but still referenced in 2 unchanged files/);
  assert.match(promptSection, /`bar` signature-changed but still referenced in 1 unchanged file\b/);
  assert.match(promptSection, /`baz` is exported but referenced nowhere in this PR \(dead-on-arrival\)/);
  assert.match(promptSection, /`src\/a\.ts`, `src\/b\.ts`/);
});
