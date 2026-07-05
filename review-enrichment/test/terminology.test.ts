// Units for the non-inclusive terminology analyzer (#2031). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. No network — pure, stateless per-line tokenization. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenizeLine,
  detectTerminology,
  scanPatchForTerminology,
  scanTerminology,
} from "../dist/analyzers/terminology.js";
import { renderBrief } from "../dist/render.js";

const patchOf = (lines) => `@@ -1,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`;

test("tokenizeLine: splits on camelCase, snake_case, and non-alphanumeric runs; blanks URLs", () => {
  assert.deepEqual(tokenizeLine("masterNode"), ["master", "node"]);
  assert.deepEqual(tokenizeLine("master_key"), ["master", "key"]);
  assert.deepEqual(tokenizeLine('"whitelist" the ip'), ["whitelist", "the", "ip"]);
  assert.deepEqual(tokenizeLine("see https://example.com/master/x now"), ["see", "now"]);
  assert.deepEqual(tokenizeLine("HTTPServer"), ["http", "server"]);
});

test("detectTerminology: flags each banned term with its neutral suggestion", () => {
  assert.deepEqual(detectTerminology("add to the whitelist"), [
    { term: "whitelist", suggestion: "allowlist" },
  ]);
  assert.deepEqual(detectTerminology("the blacklisted range"), [
    { term: "blacklisted", suggestion: "denylisted" },
  ]);
  assert.deepEqual(detectTerminology("masterNode and slaveNode"), [
    { term: "master", suggestion: "main or primary" },
    { term: "slave", suggestion: "replica or secondary" },
  ]);
});

test("detectTerminology: camelCase/acronym plural compounds are INTENTIONALLY matched on their non-inclusive component", () => {
  // An identifier is exactly what this analyzer surfaces: `slaveNodes` tokenizes to [slave, nodes], so the
  // `slave` component is reported even though the literal token `slaveNodes` is not itself in the table.
  assert.deepEqual(detectTerminology("const slaveNodes = []"), [
    { term: "slave", suggestion: "replica or secondary" },
  ]);
  assert.deepEqual(detectTerminology("let masterNodes = 3"), [
    { term: "master", suggestion: "main or primary" },
  ]);
  assert.deepEqual(detectTerminology("blacklistIDs.push(id)"), [
    { term: "blacklist", suggestion: "denylist" },
  ]);
});

test("detectTerminology: TOKEN-based — no substring false positives", () => {
  assert.deepEqual(detectTerminology("register for the masterclass"), []);
  assert.deepEqual(detectTerminology("email the postmaster"), []);
  assert.deepEqual(detectTerminology("a mastermind plan"), []);
  assert.deepEqual(detectTerminology("the word slavery here"), []);
  assert.deepEqual(detectTerminology("enslaved is unrelated"), []);
});

test("detectTerminology: a term appearing twice on one line is reported once", () => {
  assert.deepEqual(detectTerminology("whitelist plus another whitelist"), [
    { term: "whitelist", suggestion: "allowlist" },
  ]);
});

test("detectTerminology: a URL containing a banned word does not trip a finding", () => {
  assert.deepEqual(detectTerminology("fetch http://host/master/list.json"), []);
});

test("detectTerminology: case-insensitive — Whitelist and WHITELIST both match", () => {
  assert.deepEqual(detectTerminology("the Whitelist"), [{ term: "whitelist", suggestion: "allowlist" }]);
  assert.deepEqual(detectTerminology("the WHITELIST"), [{ term: "whitelist", suggestion: "allowlist" }]);
});

test("scanPatchForTerminology: flags terms on added lines with correct locations", () => {
  const findings = scanPatchForTerminology(
    "src/net.ts",
    patchOf(["const masterHost = cfg;", "// add ip to whitelist", "const ok = true;"]),
  );
  assert.deepEqual(findings, [
    { file: "src/net.ts", line: 1, term: "master", suggestion: "main or primary" },
    { file: "src/net.ts", line: 2, term: "whitelist", suggestion: "allowlist" },
  ]);
});

test("scanPatchForTerminology: only ADDED lines are scanned; new-file line numbers stay correct", () => {
  const patch = [
    "@@ -10,2 +10,2 @@",
    " function configure() {", // context line 10
    "-  const whitelist = old;", // removed, does not advance
    "+  const whitelist = fresh;", // new-file line 11
  ].join("\n");
  assert.deepEqual(scanPatchForTerminology("src/a.ts", patch), [
    { file: "src/a.ts", line: 11, term: "whitelist", suggestion: "allowlist" },
  ]);
});

test("scanPatchForTerminology: enforces the maxFindings cap", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `const blacklist${i} = whitelist;`);
  const findings = scanPatchForTerminology("src/a.ts", patchOf(lines), { maxFindings: 5 });
  assert.equal(findings.length, 5);
  assert.deepEqual(
    scanPatchForTerminology("src/a.ts", patchOf(lines), { maxFindings: 0 }),
    [],
  );
});

test("scanPatchForTerminology: a single line with two distinct terms emits two findings (each consumes a cap slot)", () => {
  const findings = scanPatchForTerminology(
    "src/a.ts",
    patchOf(["move from blacklist to whitelist"]),
  );
  assert.deepEqual(findings, [
    { file: "src/a.ts", line: 1, term: "blacklist", suggestion: "denylist" },
    { file: "src/a.ts", line: 1, term: "whitelist", suggestion: "allowlist" },
  ]);
  // ...and that pair fills a maxFindings:1 budget with just the first term, proving multi-term-per-line capping.
  assert.deepEqual(scanPatchForTerminology("src/a.ts", patchOf(["blacklist and whitelist"]), { maxFindings: 1 }), [
    { file: "src/a.ts", line: 1, term: "blacklist", suggestion: "denylist" },
  ]);
});

test("scanTerminology: scans every changed file and honors the global cap", async () => {
  const wlLines = Array.from({ length: 30 }, () => "add to whitelist");
  const findings = await scanTerminology({
    repoFullName: "octo/repo",
    prNumber: 1,
    files: [
      { path: "src/a.ts", patch: patchOf(["clean line"]) },
      { path: "src/b.ts", patch: patchOf(wlLines) },
    ],
  });
  assert.equal(findings.length, 25);
  assert.ok(findings.every((f) => f.file === "src/b.ts"));
});

test("scanTerminology: no files yields no findings", async () => {
  assert.deepEqual(await scanTerminology({ repoFullName: "octo/repo", prNumber: 1 }), []);
});

test("renderBrief: terminology findings render location, term, and suggestion", () => {
  const { promptSection } = renderBrief({
    terminology: [
      { file: "src/net.ts", line: 1, term: "master", suggestion: "main or primary" },
      { file: "src/net.ts", line: 2, term: "whitelist", suggestion: "allowlist" },
    ],
  });
  assert.match(promptSection, /Non-inclusive terminology/);
  assert.match(promptSection, /src\/net\.ts:1/);
  assert.match(promptSection, /master/);
  assert.match(promptSection, /allowlist/);
});
