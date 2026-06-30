// Units for the doc-comment-vs-signature drift analyzer (#1519). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconstructOldContent,
  extractFunctionParams,
  parseDocParams,
  parseFunctionParams,
  findDocCommentDrift,
  scanDocCommentDrift,
} from "../dist/analyzers/doc-comment-drift.js";
import { renderBrief } from "../dist/render.js";

const baseReq = (files) => ({
  repoFullName: "o/r",
  prNumber: 1,
  headSha: "abc123",
  githubToken: "ght",
  files,
});
const fileWith = (content) => async () => ({ ok: true, text: async () => content });
const status = (code) => async () => ({ ok: code >= 200 && code < 300, status: code, text: async () => "" });
const oldParams = (entries) => new Map(entries.map(([name, ids]) => [name, new Set(ids)]));

const DRIFTED = `/**\n * @param oldName the old one\n */\nexport function doThing(newName) {\n  return newName;\n}\n`;
const DRIFT_PATCH = `@@ -1,6 +1,6 @@\n /**\n  * @param oldName the old one\n  */\n-export function doThing(oldName) {\n+export function doThing(newName) {\n   return newName;\n }`;

test("reconstructOldContent: reverse-applies a patch to rebuild the pre-PR file", () => {
  const old = reconstructOldContent(DRIFTED, DRIFT_PATCH);
  assert.match(old, /function doThing\(oldName\)/); // the old parameter name is restored
  assert.doesNotMatch(old, /newName\) \{/); // the added signature line is dropped
});

test("extractFunctionParams: maps each enumerable named function to its parameter set", () => {
  const map = extractFunctionParams(`export function f(a, b) {}\nfunction g({ x }) {}\nfunction h(c) {}\n`);
  assert.deepEqual([...map.get("f")], ["a", "b"]);
  assert.deepEqual([...map.get("h")], ["c"]);
  assert.equal(map.has("g"), false); // destructured params aren't enumerable → omitted
});

test("extractFunctionParams: excludes a name declared more than once (overload/duplicate)", () => {
  const map = extractFunctionParams(`function dup(a) {}\nfunction other(z) {}\nfunction dup(a, b) {}\n`);
  assert.equal(map.has("dup"), false); // ambiguous — never returns one declaration's params for another
  assert.deepEqual([...map.get("other")], ["z"]);
});

test("reconstructOldContent: bails (null) when the patch context does not match the head content", () => {
  // The context line ` other` doesn't exist in newContent → misaligned patch → fail closed.
  assert.equal(reconstructOldContent(`a\nb\n`, `@@ -1,2 +1,2 @@\n-x\n+a\n other`), null);
});

test("findDocCommentDrift: a duplicate-named function is skipped (no cross-declaration false positive)", () => {
  // Two `dup` declarations; a stale @param on the first must not borrow the other's old params.
  const content = `/**\n * @param gone\n */\nexport function dup(a) {}\nfunction dup(b) {}\n`;
  assert.deepEqual(findDocCommentDrift(content, oldParams([["dup", ["gone", "a"]]])), []);
});

test("parseDocParams: top-level names only; nested and typed/optional handled", () => {
  const jsdoc = `/**\n * @param {string} a\n * @param [b]\n * @param {T} [c=1] desc\n * @param {{x: string}} d\n * @param opts.nested skip-me\n */`;
  assert.deepEqual(parseDocParams(jsdoc), ["a", "b", "c", "d"]);
});

test("parseDocParams: reads a single-line JSDoc block tag, but still not prose inside one", () => {
  assert.deepEqual(parseDocParams(`/** @param oldName the value */`), ["oldName"]); // single-line block
  assert.deepEqual(parseDocParams(`/** describes the @param convention */`), []); // @param buried in prose
});

test("parseDocParams: ignores @param inside prose or an @example body (only real tag lines)", () => {
  const jsdoc = `/**\n * Pass the @param oldName through; see below.\n * @example\n *   doThing(); // @param oldName demo\n * @param realName the only true tag\n */`;
  assert.deepEqual(parseDocParams(jsdoc), ["realName"]);
});

test("parseDocParams: a long malformed @param brace line yields no name (fail-safe, linear)", () => {
  const jsdoc = `/**\n * @param ${"{".repeat(64)} unterminated type and no name\n */`;
  assert.deepEqual(parseDocParams(jsdoc), []);
});

test("parseFunctionParams: enumerates simple params, strips types/defaults/rest/this", () => {
  assert.deepEqual(parseFunctionParams("a, b, c"), ["a", "b", "c"]);
  assert.deepEqual(parseFunctionParams("a: number, b?: string"), ["a", "b"]);
  assert.deepEqual(parseFunctionParams("a, b = 1"), ["a", "b"]);
  assert.deepEqual(parseFunctionParams("...args"), ["args"]);
  assert.deepEqual(parseFunctionParams("this: Foo, a"), ["a"]);
  assert.deepEqual(parseFunctionParams("opts: { x: string }, b"), ["opts", "b"]);
  assert.deepEqual(parseFunctionParams(""), []);
});

test("parseFunctionParams: comparison defaults and callback/arrow params stay enumerable (no false skip)", () => {
  assert.deepEqual(parseFunctionParams("limit = max > 0 ? max : 1, b"), ["limit", "b"]);
  assert.deepEqual(parseFunctionParams("a = b > c, d"), ["a", "d"]);
  assert.deepEqual(parseFunctionParams("cb: (x: string) => void, b"), ["cb", "b"]);
  assert.deepEqual(parseFunctionParams("a, cb = () => a"), ["a", "cb"]);
});

test("parseFunctionParams: generic types and generic-comma defaults enumerate (a comma inside <…> doesn't split)", () => {
  assert.deepEqual(parseFunctionParams("a: Map<K, V>, b"), ["a", "b"]);
  assert.deepEqual(parseFunctionParams("a: Map<K, readonly V[]>, b"), ["a", "b"]);
  assert.deepEqual(parseFunctionParams("cache = new Map<string, number>(), b"), ["cache", "b"]);
  assert.deepEqual(parseFunctionParams("a: Record<string, Map<K, V>>, b"), ["a", "b"]); // nested generics
  assert.deepEqual(parseFunctionParams("a: Result<string, { x: number }>, b"), ["a", "b"]); // object-type arg
  assert.deepEqual(parseFunctionParams("a: Map<K, (v: V) => void>, b"), ["a", "b"]); // function-type arg
  // a function-type arg followed by a further type arg: the `=>` arrow must not close the generic early.
  assert.deepEqual(parseFunctionParams("a: Foo<K, (v: V) => void, Extra>, b"), ["a", "b"]);
  assert.deepEqual(parseFunctionParams("a = items as Map<K, V>, b"), ["a", "b"]); // generic via `as` keyword
  assert.deepEqual(parseFunctionParams("removed, cache = makeMap<string, number>()"), ["removed", "cache"]); // generic call
});

test("parseFunctionParams: comparison operators are not mistaken for generics (commas still split)", () => {
  // A comparison `<` must not pair with a later comparison `>` and swallow a real comma — spaced OR not, with or
  // without an `=` between them (the `>` is followed by an operand, which a generic close never is).
  assert.deepEqual(parseFunctionParams("a = x < y, b = z > 0, removed"), ["a", "b", "removed"]);
  assert.deepEqual(parseFunctionParams("a = x<y, b = z>0, removed"), ["a", "b", "removed"]);
  assert.deepEqual(parseFunctionParams("a = x<y, b = z > q, removed"), ["a", "b", "removed"]); // spaced `>` comparison
  // a comparison default `<…>` is in expression position (after `=`), so it is never a generic — the `>` may be
  // followed by `?`, `,`, `)` or any operator without swallowing the next parameter's comma.
  assert.deepEqual(parseFunctionParams("a = x<y, removed = z > q ? 1 : 0, b"), ["a", "removed", "b"]);
  assert.deepEqual(parseFunctionParams("a = x<y, removed = (z > w), b"), ["a", "removed", "b"]);
  assert.deepEqual(parseFunctionParams("a = x<y, b = z>=0"), ["a", "b"]); // `>=` is a comparison, not a generic close
  assert.deepEqual(parseFunctionParams("a = x<y, b = z<=0"), ["a", "b"]); // `<=` is a comparison, not a generic open
  assert.deepEqual(parseFunctionParams("a = x<y, b"), ["a", "b"]); // no `=` before the later token, no space
  assert.deepEqual(parseFunctionParams("a = x<y, removed, b"), ["a", "removed", "b"]);
  assert.deepEqual(parseFunctionParams("a = p < q, b"), ["a", "b"]);
  // `removed>0` is not a valid parameter, but the comma after `y` must still split so it is not silently merged
  // into `a`'s segment and returned as ["a","b"]; the malformed segment then fails closed (null), never a wrong enum.
  assert.equal(parseFunctionParams("a = x<y, removed>0, b"), null);
});

test("parseFunctionParams: fails closed (null) on destructuring or unbalanced brackets", () => {
  assert.equal(parseFunctionParams("{ a, b }"), null);
  assert.equal(parseFunctionParams("[a, b]"), null);
  assert.equal(parseFunctionParams("a, (b"), null);
});

test("findDocCommentDrift: flags a @param that was a real OLD parameter and is now gone (rename)", () => {
  const out = findDocCommentDrift(DRIFTED, oldParams([["doThing", ["oldName"]]]));
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, "doThing");
  assert.equal(out[0].line, 4);
  assert.deepEqual(out[0].staleParams, ["oldName"]);
});

test("findDocCommentDrift: a pre-existing stale @param is NOT flagged when the parameter set didn't change", () => {
  // `oldName` was never a real parameter (old params are `newName`, same as now) — a non-parameter edit elsewhere.
  assert.deepEqual(findDocCommentDrift(DRIFTED, oldParams([["doThing", ["newName"]]])), []);
});

test("findDocCommentDrift: catches a param removed from a multi-line signature", () => {
  const content = `/**\n * @param a\n * @param b\n */\nexport function multi(\n  a,\n) {}\n`;
  const out = findDocCommentDrift(content, oldParams([["multi", ["a", "b"]]]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].staleParams, ["b"]);
});

test("findDocCommentDrift: skips an ambiguous (destructured) current signature", () => {
  const content = `/**\n * @param missing\n */\nexport function f({ a, b }) {\n  return a + b;\n}\n`;
  assert.deepEqual(findDocCommentDrift(content, oldParams([["f", ["missing"]]])), []);
});

test("findDocCommentDrift: no finding when every @param still exists", () => {
  const content = `/**\n * @param a\n * @param b\n */\nfunction g(a, b) {}\n`;
  assert.deepEqual(findDocCommentDrift(content, oldParams([["g", ["a", "b"]]])), []);
});

test("findDocCommentDrift: handles a multi-line signature", () => {
  const content = `/**\n * @param gone\n */\nexport function multi(\n  a: number,\n  b: string,\n) {}\n`;
  const out = findDocCommentDrift(content, oldParams([["multi", ["a", "b", "gone"]]]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].staleParams, ["gone"]);
});

test("findDocCommentDrift: a plain block comment between an earlier JSDoc and the function is not attached", () => {
  const content = `/**\n * @param gone\n */\n/* a plain note */\nexport function f(a) {}\n`;
  assert.deepEqual(findDocCommentDrift(content, oldParams([["f", ["a", "gone"]]])), []);
});

test("findDocCommentDrift: a nested @param (opts.x) is never stale when opts exists", () => {
  const content = `/**\n * @param opts\n * @param opts.x\n */\nfunction h(opts) {}\n`;
  assert.deepEqual(findDocCommentDrift(content, oldParams([["h", ["opts"]]])), []);
});

test("scanDocCommentDrift: a non-parameter signature edit over PRE-EXISTING stale docs is NOT reported", async () => {
  // The PR only changes the RETURN TYPE; `@param ghost` was already stale (never a real parameter).
  const content = `/**\n * @param a\n * @param ghost\n */\nexport function f(a): Promise<void> {}\n`;
  const patch = `@@ -1,5 +1,5 @@\n /**\n  * @param a\n  * @param ghost\n  */\n-export function f(a): void {}\n+export function f(a): Promise<void> {}`;
  assert.deepEqual(await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch }]), fileWith(content)), []);
});

test("scanDocCommentDrift: an unrelated same-named removal elsewhere does NOT trip a return-type-only edit", async () => {
  const content = `const keep = 2;\n/**\n * @param a\n * @param ghost\n */\nexport function f(a): Promise<void> {}\n`;
  const patch = `@@ -1,2 +1,2 @@\n-const ghost = 1;\n+const keep = 2;\n@@ -6,1 +6,1 @@\n-export function f(a): void {}\n+export function f(a): Promise<void> {}`;
  assert.deepEqual(await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch }]), fileWith(content)), []);
});

test("scanDocCommentDrift: a parameter the PR actually removed IS reported", async () => {
  const content = `/**\n * @param a\n * @param removed\n */\nexport function f(a) {}\n`;
  const patch = `@@ -1,5 +1,5 @@\n /**\n  * @param a\n  * @param removed\n  */\n-export function f(a, removed) {}\n+export function f(a) {}`;
  const findings = await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch }]), fileWith(content));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].staleParams, ["removed"]);
});

test("scanDocCommentDrift: a removed param is still reported when a sibling param has a generic-comma default", async () => {
  // Regression for the false negative: `cache`'s `new Map<string, number>()` default must not make the function
  // unparseable and silently hide the removed-and-still-documented `removed` parameter.
  const content = `/**\n * @param [removed=1] the removed one\n * @param cache the cache\n */\nexport function f(cache = new Map<string, number>()) {}\n`;
  const patch = `@@ -1,5 +1,5 @@\n /**\n  * @param [removed=1] the removed one\n  * @param cache the cache\n  */\n-export function f(removed, cache = new Map<string, number>()) {}\n+export function f(cache = new Map<string, number>()) {}`;
  const findings = await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch }]), fileWith(content));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].staleParams, ["removed"]);
});

test("scanDocCommentDrift: a removed param is still reported beside a sibling with a generic-CALL default", async () => {
  // Regression for the false negative: `cache`'s `makeMap<string, number>()` (a generic call, not `new`) default
  // must not make the function unparseable and hide the removed-and-documented `removed` parameter.
  const content = `/**\n * @param [removed=1] the removed one\n * @param cache the cache\n */\nexport function f(cache = makeMap<string, number>()) {}\n`;
  const patch = `@@ -1,5 +1,5 @@\n /**\n  * @param [removed=1] the removed one\n  * @param cache the cache\n  */\n-export function f(removed, cache = makeMap<string, number>()) {}\n+export function f(cache = makeMap<string, number>()) {}`;
  const findings = await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch }]), fileWith(content));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].staleParams, ["removed"]);
});

test("scanDocCommentDrift: fetches the file at headSha and reports drift", async () => {
  const findings = await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch: DRIFT_PATCH }]), fileWith(DRIFTED));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "src/a.ts");
  assert.deepEqual(findings[0].staleParams, ["oldName"]);
});

test("scanDocCommentDrift: requires a github token and a head sha", async () => {
  assert.deepEqual(await scanDocCommentDrift({ repoFullName: "o/r", prNumber: 1, headSha: "x", files: [{ path: "src/a.ts", patch: DRIFT_PATCH }] }, fileWith(DRIFTED)), []);
  assert.deepEqual(await scanDocCommentDrift({ repoFullName: "o/r", prNumber: 1, githubToken: "t", files: [{ path: "src/a.ts", patch: DRIFT_PATCH }] }, fileWith(DRIFTED)), []);
});

test("scanDocCommentDrift: skips non-source and test files without fetching", async () => {
  let called = false;
  const out = await scanDocCommentDrift(
    baseReq([
      { path: "README.md", patch: DRIFT_PATCH },
      { path: "src/a.test.ts", patch: DRIFT_PATCH },
    ]),
    async () => {
      called = true;
      return fileWith(DRIFTED)();
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanDocCommentDrift: fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch: DRIFT_PATCH }]), status(404)), []);
  assert.deepEqual(
    await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch: DRIFT_PATCH }]), async () => {
      throw new Error("network");
    }),
    [],
  );
});

test("scanDocCommentDrift: stops on an already-aborted signal", async () => {
  const out = await scanDocCommentDrift(baseReq([{ path: "src/a.ts", patch: DRIFT_PATCH }]), fileWith(DRIFTED), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(out, []);
});

test("renderBrief emits a public-safe doc-comment-drift block", () => {
  const { promptSection } = renderBrief({
    docCommentDrift: [{ file: "src/a.ts", line: 4, symbol: "doThing", staleParams: ["oldName"] }],
  });
  assert.match(promptSection, /Doc-comment drift/);
  assert.match(promptSection, /src\/a\.ts:4/);
  assert.match(promptSection, /doThing/);
  assert.match(promptSection, /oldName/);
});
