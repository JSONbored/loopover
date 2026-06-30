// Units for the unsafe-DOM / code-execution-sink analyzer. Kept separate so analyzer PRs do not collide in one
// shared test file. Covers every branch of detectUnsafeDom/codeOnly/scanPatchForUnsafeDom/scanUnsafeDom plus the
// render arms, using hand-built unified-diff fixtures (no network, no GitHub).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeOnly,
  detectUnsafeDom,
  scanPatchForUnsafeDom,
  scanUnsafeDom,
} from "../dist/analyzers/unsafe-dom.js";
import { renderBrief } from "../dist/render.js";

/** Build a single-hunk patch whose body is the given added lines (each prefixed with `+`). */
const addedPatch = (...lines) =>
  `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;
const req = (files) => ({ repoFullName: "o/r", prNumber: 1, files });

test("detectUnsafeDom flags each unsafe sink kind", () => {
  assert.equal(detectUnsafeDom("el.innerHTML = userInput;")?.kind, "inner-html");
  assert.equal(detectUnsafeDom("node.outerHTML = markup;")?.kind, "inner-html");
  assert.equal(
    detectUnsafeDom("el.insertAdjacentHTML('beforeend', html);")?.kind,
    "inner-html",
  );
  assert.equal(
    detectUnsafeDom("return <div dangerouslySetInnerHTML={{ __html: html }} />;")
      ?.kind,
    "dangerous-jsx",
  );
  assert.equal(detectUnsafeDom("document.write(payload);")?.kind, "document-write");
  assert.equal(detectUnsafeDom("document.writeln(payload);")?.kind, "document-write");
  assert.equal(detectUnsafeDom("const r = eval(expr);")?.kind, "eval-call");
  assert.equal(
    detectUnsafeDom("const f = new Function('a', 'return a');")?.kind,
    "function-ctor",
  );
  assert.equal(
    detectUnsafeDom("setTimeout('doStuff()', 100);")?.kind,
    "set-timeout-string",
  );
  assert.equal(
    detectUnsafeDom("setInterval(`tick()`, 100);")?.kind,
    "set-timeout-string",
  );
});

test("detectUnsafeDom returns a public-safe sink label", () => {
  assert.equal(detectUnsafeDom("el.innerHTML = x;")?.sink, ".innerHTML=");
  assert.equal(detectUnsafeDom("document.write(x);")?.sink, "document.write");
  assert.equal(detectUnsafeDom("eval(x);")?.sink, "eval");
  assert.equal(detectUnsafeDom("new Function(b);")?.sink, "new Function");
  assert.equal(
    detectUnsafeDom("return <b dangerouslySetInnerHTML={h} />;")?.sink,
    "dangerouslySetInnerHTML",
  );
});

test("detectUnsafeDom ignores sinks named only in strings or comments", () => {
  assert.equal(detectUnsafeDom('const s = "el.innerHTML = x";'), null);
  assert.equal(detectUnsafeDom("// el.innerHTML = x"), null);
  assert.equal(detectUnsafeDom("foo(); // document.write(x)"), null);
  assert.equal(detectUnsafeDom("obj.eval(payload);"), null); // member call, not global eval
  assert.equal(detectUnsafeDom("const x = retrieval(y);"), null); // identifier substring
  assert.equal(detectUnsafeDom("setTimeout(fn, 100);"), null); // function arg, not a string
  assert.equal(detectUnsafeDom("if (el.innerHTML === expected) {}"), null); // comparison, not assignment
  assert.equal(detectUnsafeDom("const plain = compute(value);"), null); // no sink
});

test("detectUnsafeDom ignores sinks inside a regex literal (regex-token false-positive class)", () => {
  // Analyzers spell sink patterns AS regex literals; scanning the regex body as code would falsely flag them.
  assert.equal(detectUnsafeDom("const re = /document\\.write\\(/;"), null);
  assert.equal(detectUnsafeDom("if (/\\.innerHTML\\s*=/.test(src)) report();"), null);
  assert.equal(detectUnsafeDom("line = line.replace(/eval\\(/g, '');"), null);
  assert.equal(detectUnsafeDom("const r = /new Function\\(/;"), null);
  // a `/` used as division is NOT a regex: a real sink later on the line is still detected
  assert.equal(
    detectUnsafeDom("const ratio = a / b; el.innerHTML = c;")?.kind,
    "inner-html",
  );
  // a `/` inside a [...] character class does not prematurely terminate the regex literal
  assert.equal(detectUnsafeDom("const re = /[a-z/]eval\\(/;"), null);
});

test("codeOnly blanks string/comment content but keeps interpolation code", () => {
  assert.equal(codeOnly('a "secret" b').includes("secret"), false);
  assert.equal(codeOnly("a // tail comment").includes("tail"), false);
  assert.ok(codeOnly("`x${ realCode }y`").includes("realCode"));
  // escaped quote inside a string, then a real sink outside it
  assert.equal(
    detectUnsafeDom('const s = "he said \\"hi\\""; document.write(x);')?.kind,
    "document-write",
  );
  // escaped backtick inside a template, then a sink in the interpolation
  assert.equal(
    detectUnsafeDom("render(`a\\`b ${ node.innerHTML = v }`);")?.kind,
    "inner-html",
  );
});

test("scanPatchForUnsafeDom cites the new-file line and skips header/removed/context lines", () => {
  const patch = [
    "--- a/app.ts",
    "+++ b/app.ts",
    "@@ -1,2 +1,3 @@",
    " context();", // context line: newLine advances
    "-old.innerHTML = a;", // removed line: ignored, does not advance newLine
    "+el.innerHTML = b;", // added at new-file line 2
  ].join("\n");
  const findings = scanPatchForUnsafeDom("app.ts", patch);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    file: "app.ts",
    line: 2,
    kind: "inner-html",
    sink: ".innerHTML=",
  });
});

test("scanPatchForUnsafeDom tracks line numbers across multiple hunks", () => {
  const patch = [
    "@@ -1,1 +1,1 @@",
    "+document.write(a);", // line 1
    "@@ -10,1 +20,2 @@",
    " keep();", // line 20
    "+eval(b);", // line 21
  ].join("\n");
  const findings = scanPatchForUnsafeDom("a.ts", patch);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].line, 1);
  assert.equal(findings[1].line, 21);
});

test("scanPatchForUnsafeDom skips pathologically long lines", () => {
  const long = `el.innerHTML = ${"x".repeat(2001)};`;
  const findings = scanPatchForUnsafeDom("a.ts", `@@ -1,0 +1,1 @@\n+${long}`);
  assert.equal(findings.length, 0);
});

test("scanPatchForUnsafeDom honors the finding budget", () => {
  assert.deepEqual(
    scanPatchForUnsafeDom("a.ts", addedPatch("eval(x);"), { maxFindings: 0 }),
    [],
  );
  const capped = scanPatchForUnsafeDom(
    "a.ts",
    addedPatch("eval(a);", "eval(b);", "eval(c);"),
    { maxFindings: 2 },
  );
  assert.equal(capped.length, 2);
});

test("scanPatchForUnsafeDom throws when the signal is already aborted", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () =>
      scanPatchForUnsafeDom("a.ts", addedPatch("eval(x);"), {
        signal: controller.signal,
      }),
    /analyzer_aborted/,
  );
});

test("scanUnsafeDom scans code files and skips non-code or patch-less files", async () => {
  const findings = await scanUnsafeDom(
    req([
      { path: "src/app.tsx", patch: addedPatch("el.innerHTML = a;") }, // scanned
      { path: "README.md", patch: addedPatch("document.write(x);") }, // skipped: not a code path
      { path: "src/no-patch.ts" }, // skipped: no patch
    ]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "src/app.tsx");
});

test("scanUnsafeDom returns [] when the request carries no files", async () => {
  assert.deepEqual(await scanUnsafeDom({ repoFullName: "o/r", prNumber: 1 }), []);
});

test("scanUnsafeDom caps total findings at the global budget", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `eval(x${i});`);
  const findings = await scanUnsafeDom(
    req([{ path: "a.ts", patch: addedPatch(...many) }]),
  );
  assert.equal(findings.length, 25);
});

test("scanUnsafeDom throws when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    scanUnsafeDom(
      req([{ path: "a.ts", patch: addedPatch("eval(x);") }]),
      controller.signal,
    ),
    /analyzer_aborted/,
  );
});

test("renderBrief includes the unsafe-DOM section when findings exist", () => {
  const { promptSection } = renderBrief({
    unsafeDom: [{ file: "src/a.ts", line: 3, kind: "eval-call", sink: "eval" }],
  });
  assert.match(promptSection, /Unsafe DOM \/ code-execution sinks/);
  assert.match(promptSection, /src\/a\.ts:3/);
  assert.match(promptSection, /eval-call/);
});

test("renderBrief omits the unsafe-DOM section when there are no findings", () => {
  const { promptSection } = renderBrief({ unsafeDom: [] });
  assert.equal(promptSection, "");
});
