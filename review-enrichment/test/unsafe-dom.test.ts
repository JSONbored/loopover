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
  assert.equal(codeOnly('a "secret" b').code.includes("secret"), false);
  assert.equal(codeOnly("a // tail comment").code.includes("tail"), false);
  assert.ok(codeOnly("`x${ realCode }y`").code.includes("realCode"));
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

test("detectUnsafeDom does not flag a safe timer when a comment/string later names a timer", () => {
  // a safe setTimeout(fn) must not be reported because a later comment or string mentions a string-bodied timer
  assert.equal(detectUnsafeDom('setTimeout(fn, 1); // setTimeout("x")'), null);
  assert.equal(
    detectUnsafeDom("setTimeout(fn, 1); const s = \"setTimeout('x')\";"),
    null,
  );
  assert.equal(detectUnsafeDom("setInterval(handler, 1000);"), null);
  // a genuine string-bodied timer is still flagged
  assert.equal(detectUnsafeDom("setTimeout('run()', 1);")?.kind, "set-timeout-string");
  assert.equal(detectUnsafeDom("setInterval(`tick()`, 1);")?.kind, "set-timeout-string");
});

test("codeOnly treats `/` after an expression-start keyword as a regex literal", () => {
  assert.equal(detectUnsafeDom("return /document\\.write\\(/.test(src);"), null);
  assert.equal(detectUnsafeDom("throw /eval\\(/;"), null);
  assert.equal(detectUnsafeDom("yield /new Function\\(/;"), null);
  // a keyword-LIKE identifier (not the keyword itself) before `/` stays a division operator
  assert.equal(
    detectUnsafeDom("const returns = a / b; el.innerHTML = c;")?.kind,
    "inner-html",
  );
});

test("detectUnsafeDom flags dangerouslySetInnerHTML only as a prop/object assignment", () => {
  assert.equal(
    detectUnsafeDom("<div dangerouslySetInnerHTML={{ __html: x }} />")?.kind,
    "dangerous-jsx",
  );
  assert.equal(
    detectUnsafeDom("const props = { dangerouslySetInnerHTML: { __html: x } };")
      ?.kind,
    "dangerous-jsx",
  );
  // a bare identifier of the same name is not a sink
  assert.equal(detectUnsafeDom("const dangerouslySetInnerHTML = computeFlag();"), null);
});

test("codeOnly strips block-comment text", () => {
  assert.equal(detectUnsafeDom("foo(); /* el.innerHTML = x */ bar();"), null);
  // a real sink before a block comment is still detected
  assert.equal(detectUnsafeDom("el.innerHTML = y; /* note */")?.kind, "inner-html");
});

test("codeOnly recursively strips sinks inside template interpolation", () => {
  assert.equal(detectUnsafeDom('const s = `${"document.write(x)"}`;'), null);
  assert.equal(detectUnsafeDom("const s = `${ /eval\\(/ }`;"), null);
  // a real sink that is actual code inside the interpolation is still detected
  assert.equal(
    detectUnsafeDom("const h = `${ (el.innerHTML = v) }`;")?.kind,
    "inner-html",
  );
});

test("scanPatchForUnsafeDom carries block-comment state across added lines", () => {
  const patch = [
    "@@ -1,0 +1,4 @@",
    "+/* a comment that mentions",
    "+ document.write(x) and more",
    "+*/",
    "+el.innerHTML = real;",
  ].join("\n");
  const findings = scanPatchForUnsafeDom("a.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "inner-html");
  assert.equal(findings[0].line, 4);
  // a new hunk is non-contiguous, so block-comment state does not carry across it
  const patch2 = [
    "@@ -1,0 +1,1 @@",
    "+/* opened here",
    "@@ -5,0 +9,1 @@",
    "+document.write(x);",
  ].join("\n");
  const f2 = scanPatchForUnsafeDom("a.ts", patch2);
  assert.equal(f2.length, 1);
  assert.equal(f2[0].line, 9);
});

test("detectUnsafeDom flags compound assignment to innerHTML/outerHTML", () => {
  assert.equal(detectUnsafeDom("el.innerHTML += html;")?.kind, "inner-html");
  assert.equal(detectUnsafeDom("node.outerHTML += markup;")?.kind, "inner-html");
  // an equality comparison is still excluded
  assert.equal(detectUnsafeDom("if (el.innerHTML == x) {}"), null);
});

test("codeOnly brace-matches interpolation past strings/regex/nested-templates so later sinks survive", () => {
  assert.equal(
    detectUnsafeDom('const h = `${ foo("}") || (el.innerHTML = x) }`;')?.kind,
    "inner-html",
  );
  assert.equal(
    detectUnsafeDom("const h = `${ /}/.test(s) || (el.innerHTML = x) }`;")?.kind,
    "inner-html",
  );
  assert.equal(
    detectUnsafeDom("const h = `${ `}` + (document.write(x), 1) }`;")?.kind,
    "document-write",
  );
});

test("scanPatchForUnsafeDom honors a block comment opened on a context line", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " /* an existing comment that opens here",
    "+ document.write(x) still inside the comment",
    " */",
    "+el.innerHTML = real;",
  ].join("\n");
  const findings = scanPatchForUnsafeDom("a.ts", patch);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "inner-html");
});
