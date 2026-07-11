// Units for the real before/after complexity-delta analyzer (#4740, part of epic #4737). Own file (not
// complexity.test.ts) so concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchAndDiffFunctions, scanComplexityDelta } from "../dist/analyzers/complexity-delta.js";
import { renderBrief } from "../dist/render.js";

const baseReq = (files) => ({
  repoFullName: "o/r",
  prNumber: 1,
  headSha: "abc123",
  githubToken: "ght",
  files,
});
const fileWith = (content, init) => async () => new Response(content, init);
const status = (code) => async () => new Response("", { status: code });

// A function whose signature is UNCHANGED but whose body drops 3 of its 4 `if` checks: reconstructOldContent
// reverse-applies this patch onto HEAD_CONTENT to recover a 4-`if` "before" version (complexity 5), diffed
// against the 1-`if` "after" version (complexity 2) -- the exact "simplifies a gnarly existing function" case
// the current diff-hunk-only `complexity` analyzer cannot see at all (its signature line isn't in this diff).
const HEAD_CONTENT = "export function calc(x) {\n  if (a) {}\n  return x;\n}\n";
const CALC_PATCH = [
  "@@ -1,7 +1,4 @@",
  " export function calc(x) {",
  "   if (a) {}",
  "-  if (b) {}",
  "-  if (c) {}",
  "-  if (d) {}",
  "   return x;",
  " }",
].join("\n");

test("matchAndDiffFunctions: a function with an unchanged signature but a simplified body shows a negative (improving) delta", () => {
  // This is the whole point of #4740: complexity.ts's own diff-hunk-only analyzer cannot see this at all, since
  // calc's signature line never appears in a diff -- only its full before/after body content does here.
  const oldContent = "function calc(x) {\n  if (a) {}\n  if (b) {}\n  if (c) {}\n  if (d) {}\n  return x;\n}\n";
  const newContent = "function calc(x) {\n  if (a) {}\n  return x;\n}\n";
  const findings = matchAndDiffFunctions("src/calc.ts", oldContent, newContent);
  assert.deepEqual(findings, [{ file: "src/calc.ts", line: 1, name: "calc", before: 5, after: 2, delta: -3 }]);
});

test("matchAndDiffFunctions: a function that gained branches shows a positive (regressing) delta", () => {
  const oldContent = "function calc(x) {\n  if (a) {}\n  return x;\n}\n";
  const newContent = "function calc(x) {\n  if (a) {}\n  if (b) {}\n  if (c) {}\n  return x;\n}\n";
  const findings = matchAndDiffFunctions("src/calc.ts", oldContent, newContent);
  assert.deepEqual(findings, [{ file: "src/calc.ts", line: 1, name: "calc", before: 2, after: 4, delta: 2 }]);
});

test("matchAndDiffFunctions: a function with no complexity change produces no finding", () => {
  const content = "function calc(x) {\n  if (a) {}\n  return x;\n}\n";
  assert.deepEqual(matchAndDiffFunctions("src/calc.ts", content, content), []);
});

test("matchAndDiffFunctions: a name declared more than once in the OLD version is excluded from matching (ambiguous)", () => {
  const oldContent = "function dup() {\n  if (a) {}\n}\nfunction dup() {\n  if (b) {}\n  if (c) {}\n}\n";
  const newContent = "function dup() {\n  if (a) {}\n  if (b) {}\n}\n";
  // "dup" is excluded from the OLD scan's map (declared twice, ambiguous) -- treated the same as "genuinely new".
  assert.deepEqual(matchAndDiffFunctions("src/x.ts", oldContent, newContent), []);
});

test("matchAndDiffFunctions: a function present only in the NEW version has no finding (that is complexity's own job)", () => {
  const oldContent = "const unrelated = 1;\n";
  const newContent = "function brandNew() {\n  if (a) {}\n}\n";
  assert.deepEqual(matchAndDiffFunctions("src/x.ts", oldContent, newContent), []);
});

test("matchAndDiffFunctions: respects a maxFindings cap", () => {
  const n = 5;
  const oldContent = Array.from({ length: n }, (_, i) => `function fn${i}() {\n  if (a) {}\n}`).join("\n");
  const newContent = Array.from({ length: n }, (_, i) => `function fn${i}() {}`).join("\n");
  const findings = matchAndDiffFunctions("src/x.ts", oldContent, newContent, { maxFindings: 2 });
  assert.equal(findings.length, 2);
});

test("matchAndDiffFunctions: a non-positive maxFindings yields no findings", () => {
  assert.deepEqual(
    matchAndDiffFunctions("src/x.ts", "function calc(x) {}\n", "function calc(x) {\n  if (a) {}\n}\n", {
      maxFindings: 0,
    }),
    [],
  );
});

test("scanComplexityDelta: a function with an unchanged signature but a simplified body shows a negative delta end to end", async () => {
  // Drives the REAL entrypoint: fetches head content, reverse-applies the patch via reconstructOldContent, and
  // diffs -- not just the pure matchAndDiffFunctions helper above.
  const findings = await scanComplexityDelta(
    baseReq([{ path: "src/calc.ts", patch: CALC_PATCH }]),
    fileWith(HEAD_CONTENT),
  );
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], { file: "src/calc.ts", line: 1, name: "calc", before: 5, after: 2, delta: -3 });
});

test("scanComplexityDelta: requires a github token and a head sha", async () => {
  assert.deepEqual(
    await scanComplexityDelta(
      { repoFullName: "o/r", prNumber: 1, headSha: "x", files: [{ path: "src/a.ts", patch: CALC_PATCH }] },
      fileWith(HEAD_CONTENT),
    ),
    [],
  );
  assert.deepEqual(
    await scanComplexityDelta(
      { repoFullName: "o/r", prNumber: 1, githubToken: "t", files: [{ path: "src/a.ts", patch: CALC_PATCH }] },
      fileWith(HEAD_CONTENT),
    ),
    [],
  );
});

test("scanComplexityDelta: rejects multi-segment repo slugs without fetching", async () => {
  let called = false;
  const out = await scanComplexityDelta(
    {
      repoFullName: "o/r/extra",
      prNumber: 1,
      headSha: "abc123",
      githubToken: "ght",
      files: [{ path: "src/a.ts", patch: CALC_PATCH }],
    },
    async () => {
      called = true;
      return fileWith(HEAD_CONTENT)();
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanComplexityDelta: skips non-source, test, and patch-less files without fetching", async () => {
  let called = false;
  const out = await scanComplexityDelta(
    baseReq([
      { path: "README.md", patch: CALC_PATCH },
      { path: "src/a.test.ts", patch: CALC_PATCH },
      { path: "src/a.ts" }, // no patch at all
    ]),
    async () => {
      called = true;
      return fileWith(HEAD_CONTENT)();
    },
  );
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanComplexityDelta: fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanComplexityDelta(baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]), status(404)), []);
  assert.deepEqual(
    await scanComplexityDelta(baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]), async () => {
      throw new Error("network");
    }),
    [],
  );
});

test("scanComplexityDelta: skips oversized file responses before reading the body", async () => {
  let bodyAccessed = false;
  const out = await scanComplexityDelta(baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]), async () => ({
    ok: true,
    headers: new Headers({ "content-length": "1000001" }),
    get body() {
      bodyAccessed = true;
      return new Response(HEAD_CONTENT).body;
    },
  }));
  assert.deepEqual(out, []);
  assert.equal(bodyAccessed, false);
});

test("scanComplexityDelta: a response with no body yields no findings", async () => {
  const out = await scanComplexityDelta(
    baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]),
    async () => ({ ok: true, headers: new Headers(), body: null }),
  );
  assert.deepEqual(out, []);
});

test("scanComplexityDelta: cancels streamed file responses that exceed the byte cap", async () => {
  let canceled = false;
  const chunk = new Uint8Array(500_001);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const out = await scanComplexityDelta(baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]), async () => new Response(stream));
  assert.deepEqual(out, []);
  assert.equal(canceled, true);
});

test("scanComplexityDelta: stops on an already-aborted signal", async () => {
  const out = await scanComplexityDelta(baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]), fileWith(HEAD_CONTENT), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(out, []);
});

test("scanComplexityDelta: an abort that becomes true before the body read begins yields no findings for that file", async () => {
  // The signal is still false when the per-file loop's pre-fetch check runs, but flips true INSIDE the fetch
  // itself, before the Response is even returned. The shared boundedFetchText helper (#4759) has no signal-polling
  // of its own inside its read loop -- it just reads whatever Response the mocked fetchImpl hands back, which
  // succeeds here regardless of the signal's state -- so it's the loop's OWN post-fetch check that must catch the
  // now-true signal and discard this file's content.
  const abortController = new AbortController();
  const out = await scanComplexityDelta(
    baseReq([{ path: "src/a.ts", patch: CALC_PATCH }]),
    async () => {
      abortController.abort();
      return new Response(HEAD_CONTENT);
    },
    { signal: abortController.signal },
  );
  assert.deepEqual(out, []);
});

test("scanComplexityDelta: an abort that fires only after a file's content is fully read stops further files", async () => {
  // The signal flips true DURING the body read's final chunk. The shared boundedFetchText helper (#4759) has no
  // signal-polling of its own inside its read loop, so it finishes reading this (mocked, in-memory) stream and
  // returns the content successfully -- the loop's OWN post-fetch check must still catch it and stop before a
  // second file is ever fetched.
  const abortController = new AbortController();
  let fetchCalls = 0;
  const out = await scanComplexityDelta(
    baseReq([
      { path: "src/a.ts", patch: CALC_PATCH },
      { path: "src/b.ts", patch: CALC_PATCH },
    ]),
    async () => {
      fetchCalls += 1;
      let pullCount = 0;
      const stream = new ReadableStream({
        pull(controller) {
          pullCount += 1;
          if (pullCount === 1) {
            controller.enqueue(new TextEncoder().encode(HEAD_CONTENT));
          } else {
            abortController.abort();
            controller.close();
          }
        },
      });
      return new Response(stream);
    },
    { signal: abortController.signal },
  );
  assert.deepEqual(out, []);
  assert.equal(fetchCalls, 1);
});

test("scanComplexityDelta: an unreconstructable (malformed/mismatched) patch degrades to no findings, not a crash", async () => {
  // The context line " other" does not match the mocked head content -> reconstructOldContent returns null.
  const out = await scanComplexityDelta(
    baseReq([{ path: "src/a.ts", patch: "@@ -1,2 +1,2 @@\n-x\n+a\n other" }]),
    fileWith("a\nb\n"),
  );
  assert.deepEqual(out, []);
});

test("scanComplexityDelta: a wholly new file (patch reverse-applies to an empty string) degrades to no findings, not a crash", async () => {
  // Distinct from the null case above: the patch reverse-applies CLEANLY but yields zero old-side content (a
  // wholly-added file). Both are falsy and must be handled identically via truthiness.
  const newFileContent = "export function add(x, y) {\n  return x + y;\n}\n";
  const newFilePatch = "@@ -0,0 +1,3 @@\n+export function add(x, y) {\n+  return x + y;\n+}";
  const out = await scanComplexityDelta(
    baseReq([{ path: "src/new.ts", patch: newFilePatch }]),
    fileWith(newFileContent),
  );
  assert.deepEqual(out, []);
});

test("scanComplexityDelta: respects the findings cap across files and stops fetching further ones once reached", async () => {
  const n = 26; // one more than DEFAULT_MAX_FINDINGS (25), so the 26th function must be dropped
  const newLines = [];
  const patchBody = [];
  for (let i = 0; i < n; i++) {
    newLines.push(`function fn${i}() {`, "}");
    patchBody.push(` function fn${i}() {`, "-  if (a) {}", " }");
  }
  const newContent = `${newLines.join("\n")}\n`;
  const patch = [`@@ -1,${n * 3} +1,${n * 2} @@`, ...patchBody].join("\n");

  let fetchCalls = 0;
  const out = await scanComplexityDelta(
    baseReq([
      { path: "src/many.ts", patch },
      { path: "src/never-reached.ts", patch },
    ]),
    async () => {
      fetchCalls += 1;
      return new Response(newContent);
    },
  );
  assert.equal(out.length, 25);
  assert.equal(fetchCalls, 1); // the cap was hit mid-file-1, so file 2 is never fetched
});

test("scanComplexityDelta: uses the analysis-context fetchText when supplied, instead of the bare fetch path", async () => {
  // #4759: the file-content fetch now goes through the shared boundedFetchText helper, which prefers
  // options.analysis.fetchText (mirrors duplication-delta.ts's own fetchFileAtHead) when an AnalysisContext is
  // supplied — the raw fetchFn passed as the second positional arg must never be invoked in that case.
  let analysisCalls = 0;
  const analysis = {
    fetchText: async (_url, _opts) => {
      analysisCalls += 1;
      return {
        ok: true,
        status: 200,
        data: HEAD_CONTENT,
        bytes: HEAD_CONTENT.length,
        elapsedMs: 0,
        endpointCategory: "github-contents",
      };
    },
  };
  const findings = await scanComplexityDelta(
    baseReq([{ path: "src/calc.ts", patch: CALC_PATCH }]),
    async () => {
      throw new Error("bare fetch should not be used when analysis.fetchText is supplied");
    },
    { analysis },
  );
  assert.equal(analysisCalls, 1);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], { file: "src/calc.ts", line: 1, name: "calc", before: 5, after: 2, delta: -3 });
});

test("renderBrief emits a public-safe complexity-delta block", () => {
  const { promptSection } = renderBrief({
    complexityDelta: [{ file: "src/calc.ts", line: 1, name: "calc", before: 5, after: 2, delta: -3 }],
  });
  assert.match(promptSection, /Complexity delta/);
  assert.match(promptSection, /src\/calc\.ts:1/);
  assert.match(promptSection, /calc/);
  assert.match(promptSection, /5.*2.*-3/);
});
