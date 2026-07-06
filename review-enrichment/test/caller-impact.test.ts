// Units for the caller-impact analyzer (#1509). Own file (not enrichment.test.ts) so concurrent analyzer PRs do
// not collide. All network is mocked; runs against the compiled dist/. The external-fetch circuit breaker is
// module-global, so every test that performs a search resets it first for isolation.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  candidateCallerPaths,
  collectRemovedExports,
  fileImportsSymbol,
  importBindsSymbol,
  isInternalModulePath,
  isScannablePath,
  scanCallerImpact,
} from "../dist/analyzers/caller-impact.js";
import { renderBrief } from "../dist/render.js";
import { resetExternalFetchCircuitBreakerForTest } from "../dist/external-fetch.js";

const REMOVED_PATCH = [
  "@@ -1,3 +1,2 @@",
  " const keep = 1;",
  "-export function removedHelper() {}",
  " const tail = 2;",
].join("\n");

const searchJson = (items, { total, incomplete = false } = {}) =>
  JSON.stringify({
    total_count: total ?? items.length,
    incomplete_results: incomplete,
    items,
  });

const req = (files, extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  githubToken: "ghp_test",
  headSha: "abc123",
  files,
  ...extra,
});

// A fetch stub: `search` is the JSON body (or a Response) for /search/code; `contents` maps a path substring to
// a body (or a Response). Unmapped contents requests 404.
const stubFetch = ({ search, contents = {} }) =>
  async (url) => {
    if (url.includes("/search/code")) {
      return search instanceof Response ? search : new Response(search, { status: 200 });
    }
    if (url.includes("/contents/")) {
      for (const [needle, body] of Object.entries(contents)) {
        if (url.includes(needle)) {
          return body instanceof Response ? body : new Response(body, { status: 200 });
        }
      }
      return new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  };

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

test("isScannablePath: real source only, excludes decl/build/test", () => {
  assert.equal(isScannablePath("src/utils.ts"), true);
  assert.equal(isScannablePath("src/a.tsx"), true);
  assert.equal(isScannablePath("src/types.d.ts"), false);
  assert.equal(isScannablePath("dist/utils.js"), false);
  assert.equal(isScannablePath("src/utils.test.ts"), false);
  assert.equal(isScannablePath("README.md"), false);
});

test("isInternalModulePath: relative and alias are internal; bare/builtin are not", () => {
  for (const p of ["./x", "../x", ".", "..", "@/x", "~/x", "#internal"]) {
    assert.equal(isInternalModulePath(p), true, p);
  }
  for (const p of ["react", "@scope/pkg", "node:fs", "lodash/merge"]) {
    assert.equal(isInternalModulePath(p), false, p);
  }
});

test("importBindsSymbol: named (incl. alias), default, and namespace bindings", () => {
  assert.equal(importBindsSymbol(" { foo, bar } ", "foo"), true);
  assert.equal(importBindsSymbol(" { foo as local } ", "foo"), true); // imported name matched, not the alias
  assert.equal(importBindsSymbol(" { other as foo } ", "foo"), false); // foo is only a local alias here
  assert.equal(importBindsSymbol(" type { foo } ", "foo"), true);
  assert.equal(importBindsSymbol(" * as foo ", "foo"), true);
  assert.equal(importBindsSymbol(" foo ", "foo"), true);
  assert.equal(importBindsSymbol(" foo, { bar } ", "foo"), true);
  assert.equal(importBindsSymbol(" { bar } ", "foo"), false);
});

test("fileImportsSymbol: only a real internal import counts; text/property/bare-pkg do not", () => {
  assert.equal(fileImportsSymbol(`import { foo } from "./m";\nfoo();`, "foo"), true);
  assert.equal(fileImportsSymbol(`  import { foo as f } from "../m";`, "foo"), true);
  assert.equal(fileImportsSymbol(`export { foo } from "@/m";`, "foo"), true);
  assert.equal(fileImportsSymbol(`import foo from "#internal";`, "foo"), true);
  assert.equal(fileImportsSymbol(`import {\n  foo,\n} from "~/m";`, "foo"), true);
  assert.equal(fileImportsSymbol(`import { foo } from "third-party";`, "foo"), false); // bare package
  assert.equal(fileImportsSymbol(`// foo is used elsewhere\nconst x = obj.foo;`, "foo"), false); // comment/property
  assert.equal(fileImportsSymbol(`const foo = 1;`, "foo"), false); // local declaration
  assert.equal(fileImportsSymbol(`import { bar } from "./m";`, "foo"), false);
});

test("fileImportsSymbol: pathological import-like text is scanned in linear time", () => {
  const source = `${"; import anything\n".repeat(55_000)}Victim`;
  assert.equal(fileImportsSymbol(source, "Victim"), false);
});

test("collectRemovedExports: removed export keyed to old-file line", () => {
  const removed = collectRemovedExports([{ path: "src/utils.ts", patch: REMOVED_PATCH }]);
  assert.deepEqual(removed, [{ file: "src/utils.ts", symbol: "removedHelper", line: 2 }]);
});

test("collectRemovedExports: a symbol re-added anywhere in the PR (move/edit) is not removed", () => {
  const removed = collectRemovedExports([
    { path: "src/utils.ts", patch: REMOVED_PATCH.replace("removedHelper", "movedHelper") },
    { path: "src/moved.ts", patch: ["@@ -0,0 +1,1 @@", "+export function movedHelper() {}"].join("\n") },
  ]);
  assert.deepEqual(removed, []);
});

test("collectRemovedExports: skips entrypoint barrels, tests, short names, and default", () => {
  const barrel = collectRemovedExports([
    { path: "src/index.ts", patch: REMOVED_PATCH.replace("removedHelper", "barrelFn") },
  ]);
  assert.deepEqual(barrel, []);
  const testFile = collectRemovedExports([
    { path: "src/utils.test.ts", patch: REMOVED_PATCH.replace("removedHelper", "specFn") },
  ]);
  assert.deepEqual(testFile, []);
  const shortAndDefault = collectRemovedExports([
    { path: "src/utils.ts", patch: ["@@ -1,2 +1,1 @@", "-export const ab = 1;", "-export default x;"].join("\n") },
  ]);
  assert.deepEqual(shortAndDefault, []);
});

test("collectRemovedExports: nothing removed yields no candidates", () => {
  assert.deepEqual(
    collectRemovedExports([
      { path: "src/utils.ts", patch: ["@@ -0,0 +1,1 @@", "+export function added() {}"].join("\n") },
    ]),
    [],
  );
});

test("candidateCallerPaths: null (unknown) on missing/incomplete/malformed; filters declaring/changed/non-source", () => {
  const changed = new Set(["src/utils.ts", "src/also-changed.ts"]);
  assert.equal(candidateCallerPaths(null, "src/utils.ts", changed), null);
  assert.equal(
    candidateCallerPaths({ total_count: 1, incomplete_results: true, items: [{ path: "src/a.ts" }] }, "src/utils.ts", changed),
    null,
  );
  assert.equal(candidateCallerPaths({ total_count: 1 }, "src/utils.ts", changed), null); // items not an array
  assert.deepEqual(
    candidateCallerPaths(
      {
        items: [
          { path: "src/utils.ts" }, // declaring file
          { path: "src/also-changed.ts" }, // changed by the PR
          { path: "src/gen.d.ts" }, // not scannable
          { path: "src/consumer.ts" },
          { path: "src/consumer.ts" }, // duplicate
          { path: null },
        ],
      },
      "src/utils.ts",
      changed,
    ),
    ["src/consumer.ts"],
  );
});

// ---------------------------------------------------------------------------------------------------------------
// scanCallerImpact — happy path + render
// ---------------------------------------------------------------------------------------------------------------

test("scanCallerImpact: flags a removed export confirmed to be imported by an unchanged file", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const fetchFn = stubFetch({
    search: searchJson([{ path: "src/consumer.ts" }, { path: "src/utils.ts" }]),
    contents: { "consumer.ts": `import { removedHelper } from "./utils";\nremovedHelper();` },
  });
  const findings = await scanCallerImpact(req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]), fetchFn);
  assert.deepEqual(findings, [
    { file: "src/utils.ts", line: 2, symbol: "removedHelper", callers: ["src/consumer.ts"] },
  ]);
  const brief = renderBrief({ callerImpact: findings }).promptSection;
  assert.match(brief, /Removed exports? with live callers/i);
  assert.match(brief, /removedHelper/);
  assert.match(brief, /src\/consumer\.ts/);
});

test("scanCallerImpact: caller list is capped at MAX_CALLERS_PER_FINDING (5)", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const items = Array.from({ length: 7 }, (_, i) => ({ path: `src/c${i}.ts` }));
  const contents = Object.fromEntries(
    items.map((it) => [it.path.split("/").pop(), `import { removedHelper } from "../utils";`]),
  );
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    stubFetch({ search: searchJson(items), contents }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].callers.length, 5);
});

// ---------------------------------------------------------------------------------------------------------------
// scanCallerImpact — fail-closed / no-finding branches
// ---------------------------------------------------------------------------------------------------------------

test("scanCallerImpact: a text-only / property / comment match is NOT a caller", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    stubFetch({
      search: searchJson([{ path: "src/consumer.ts" }]),
      contents: { "consumer.ts": `// removedHelper was here\nconst v = ns.removedHelper;` },
    }),
  );
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: a same-named import from a THIRD-PARTY package is NOT a caller", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    stubFetch({
      search: searchJson([{ path: "src/consumer.ts" }]),
      contents: { "consumer.ts": `import { removedHelper } from "some-pkg";\nremovedHelper();` },
    }),
  );
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: a FAILED search (HTTP 500) degrades to no finding — never a fabricated caller", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) return new Response("upstream error", { status: 500 });
    return new Response("", { status: 404 });
  };
  const findings = await scanCallerImpact(req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]), fetchFn);
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: a MALFORMED search body (invalid JSON) degrades to no finding", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    stubFetch({ search: "}{ not json" }),
  );
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: incomplete_results (partial index) degrades to no finding", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    stubFetch({
      search: searchJson([{ path: "src/consumer.ts" }], { total: 9, incomplete: true }),
      contents: { "consumer.ts": `import { removedHelper } from "./utils";` },
    }),
  );
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: a thrown fetch (network error) degrades to no finding", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) throw new Error("boom");
    return new Response("", { status: 404 });
  };
  const findings = await scanCallerImpact(req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]), fetchFn);
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: an UNREADABLE candidate file (404 contents) is not counted as a caller", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) return new Response(searchJson([{ path: "src/consumer.ts" }]), { status: 200 });
    return new Response("", { status: 404 }); // contents 404
  };
  const findings = await scanCallerImpact(req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]), fetchFn);
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: search with only the declaring + changed files yields no external caller", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const findings = await scanCallerImpact(
    req([
      { path: "src/utils.ts", patch: REMOVED_PATCH },
      { path: "src/also-changed.ts", patch: ["@@ -0,0 +1,1 @@", "+const q = 1;"].join("\n") },
    ]),
    stubFetch({ search: searchJson([{ path: "src/utils.ts" }, { path: "src/also-changed.ts" }]) }),
  );
  assert.deepEqual(findings, []);
});

test("scanCallerImpact: aborted signal returns [] without any finding", async () => {
  resetExternalFetchCircuitBreakerForTest();
  let searched = false;
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) searched = true;
    return new Response(searchJson([{ path: "src/consumer.ts" }]), { status: 200 });
  };
  const findings = await scanCallerImpact(
    req([{ path: "src/utils.ts", patch: REMOVED_PATCH }]),
    fetchFn,
    { signal: AbortSignal.abort() },
  );
  assert.deepEqual(findings, []);
  assert.equal(searched, false);
});

test("scanCallerImpact: no token / no headSha / invalid slug / no removed exports all return []", async () => {
  const failFetch = async () => new Response("", { status: 500 });
  const files = [{ path: "src/utils.ts", patch: REMOVED_PATCH }];
  assert.deepEqual(await scanCallerImpact(req(files, { githubToken: undefined }), failFetch), []);
  assert.deepEqual(await scanCallerImpact(req(files, { headSha: undefined }), failFetch), []);
  assert.deepEqual(await scanCallerImpact(req(files, { repoFullName: "not-a-slug" }), failFetch), []);
  assert.deepEqual(
    await scanCallerImpact(req(files, { repoFullName: "octo/re po" }), failFetch),
    [],
  );
  assert.deepEqual(
    await scanCallerImpact(
      req([{ path: "src/utils.ts", patch: ["@@ -0,0 +1,1 @@", "+export function added() {}"].join("\n") }]),
      failFetch,
    ),
    [],
  );
});

test("scanCallerImpact: enforces the search cap at MAX_SEARCHES (6)", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const files = Array.from({ length: 9 }, (_, i) => ({
    path: `src/f${i}.ts`,
    patch: REMOVED_PATCH.replace("removedHelper", `removedHelper${i}`),
  }));
  let searches = 0;
  const fetchFn = async (url) => {
    if (url.includes("/search/code")) {
      searches += 1;
      return new Response(searchJson([]), { status: 200 });
    }
    return new Response("", { status: 404 });
  };
  await scanCallerImpact(req(files), fetchFn);
  assert.equal(searches, 6);
});

test("renderBrief: omits the caller-impact section when there are no findings", () => {
  assert.equal(renderBrief({ callerImpact: [] }).promptSection, "");
});
