// Units for the coverage-delta analyzer (#1516). Own file (not enrichment.test.ts) so concurrent analyzer PRs
// don't collide. All network is mocked; a real deflated zip is built in-test from node:zlib. Runs against dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  addedLineNumbers,
  parseLcov,
  parseIstanbulJson,
  parseCoberturaXml,
  readZipEntries,
  coverageFileKind,
  pathMatches,
  scanCoverageDelta,
} from "../dist/analyzers/coverage-delta.js";
import { renderBrief } from "../dist/render.js";
import { resetExternalFetchCircuitBreakerForTest } from "../dist/external-fetch.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

// A PR patch that adds new-file lines 11-13 to src/a.ts (12 is a context line, not added).
const PR_PATCH = "@@ -10,3 +10,5 @@\n ctx1\n+add11\n keepctx\n+add13\n+add14\n ctx2";
const LCOV = "SF:src/a.ts\nDA:11,0\nDA:13,5\nDA:14,0\nend_of_record\n";

// Build a ZIP (central directory + EOCD) around entries, deflated (method 8) by default.
function buildZipEntries(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, data, store = false } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(data, "utf8");
    const body = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localRecord = Buffer.concat([local, nameBuf, body]);
    localRecords.push(localRecord);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([central, nameBuf]));
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

// Build a single-entry ZIP around `data` under `name`.
function buildZip(name, data, { store = false } = {}) {
  return buildZipEntries([{ name, data, store }]);
}

const req = (files, over = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 1,
  headSha: "sha123",
  githubToken: "ghp_test",
  files,
  ...over,
});

// Route by URL: runs list, per-run artifacts list, and the artifact zip download.
const routed = ({ runs, artifacts, zip }) => async (url) => {
  if (url.includes("/actions/runs?")) return jsonResponse({ workflow_runs: runs });
  if (url.endsWith("/artifacts")) return jsonResponse({ artifacts });
  if (url.includes("/artifacts/") && url.endsWith("/zip")) {
    return new Response(zip, { status: 200 });
  }
  return jsonResponse({}, 404);
};

const RUNS = [{ id: 7, conclusion: "success", created_at: "2026-06-01T00:00:00Z" }];
const ARTIFACTS = [{ id: 99, name: "coverage-report", size_in_bytes: 1000 }];

test("addedLineNumbers: added new-file lines only, skipping context and removals", () => {
  assert.deepEqual(addedLineNumbers(PR_PATCH), [11, 13, 14]);
  assert.deepEqual(addedLineNumbers(""), []);
  assert.deepEqual(addedLineNumbers("no hunk\n+x"), []); // no @@ header ⇒ inactive
  assert.deepEqual(addedLineNumbers("@@ bad @@\n+x"), []); // header regex fails ⇒ inactive
  // Multiple hunks; "\ No newline" marker is skipped and does not advance the counter.
  assert.deepEqual(addedLineNumbers("@@ -1,0 +1,1 @@\n+a\n@@ -5,1 +5,2 @@\n c\n+b\n\\ No newline"), [1, 6]);
});

test("parseLcov: DA rows with zero hits become uncovered lines", () => {
  const map = parseLcov(LCOV);
  assert.deepEqual([...(map.get("src/a.ts") ?? [])], [11, 14]);
  assert.equal(parseLcov("SF:x\nDA:bad,0\nDA:0,0\nend_of_record").get("x")?.size ?? 0, 0);
  assert.equal(parseLcov("DA:5,0").size, 0); // no SF: scope ⇒ ignored
});

test("parseIstanbulJson: zero-hit statements map to their start line; bad shapes yield empty", () => {
  const json = JSON.stringify({
    "src/a.ts": {
      s: { "0": 1, "1": 0, "2": 0 },
      statementMap: { "0": { start: { line: 11 } }, "1": { start: { line: 13 } }, "2": { start: { line: 14 } } },
    },
    "src/skip.ts": { s: { "0": 3 } }, // no statementMap ⇒ skipped
  });
  const map = parseIstanbulJson(json);
  assert.deepEqual([...(map.get("src/a.ts") ?? [])], [13, 14]);
  assert.equal(map.has("src/skip.ts"), false);
  assert.equal(parseIstanbulJson("not json").size, 0);
  assert.equal(parseIstanbulJson("[]").size, 0); // array ⇒ no file entries with s/statementMap
  assert.equal(parseIstanbulJson("null").size, 0);
});

test("parseCoberturaXml: zero-hit lines within a class scope become uncovered", () => {
  const xml = [
    '<class filename="src/a.ts">',
    '<line number="11" hits="0"/>',
    '<line number="13" hits="4"/>',
    '<line number="14" hits="0"/>',
    "</class>",
    '<line number="99" hits="0"/>', // outside any class scope ⇒ ignored
  ].join("\n");
  assert.deepEqual([...(parseCoberturaXml(xml).get("src/a.ts") ?? [])], [11, 14]);
});

test("readZipEntries: reads a deflated and a stored entry; rejects a non-zip buffer", () => {
  const deflated = readZipEntries(buildZip("lcov.info", LCOV));
  assert.equal(deflated[0]?.name, "lcov.info");
  assert.equal(deflated[0]?.data.toString("utf8"), LCOV);
  const stored = readZipEntries(buildZip("lcov.info", LCOV, { store: true }));
  assert.equal(stored[0]?.data.toString("utf8"), LCOV);
  assert.deepEqual(readZipEntries(Buffer.from("not a zip file at all")), []);
  assert.deepEqual(readZipEntries(Buffer.alloc(4)), []); // shorter than the EOCD record
});

test("readZipEntries: skips non-coverage entries before inflation and bounds inspected entries", () => {
  const junk = "x".repeat(1024 * 1024);
  const manyJunkEntries = Array.from({ length: 70 }, (_, index) => ({ name: `junk-${index}.txt`, data: junk }));
  assert.deepEqual(readZipEntries(buildZipEntries(manyJunkEntries)), []);

  const entries = readZipEntries(
    buildZipEntries([
      ...manyJunkEntries.slice(0, 64),
      { name: "lcov.info", data: LCOV },
    ]),
  );
  assert.deepEqual(entries, []);
});

test("coverageFileKind: recognizes lcov / istanbul / cobertura names, else null", () => {
  assert.equal(coverageFileKind("out/lcov.info"), "lcov");
  assert.equal(coverageFileKind("report.lcov"), "lcov");
  assert.equal(coverageFileKind("coverage/coverage-final.json"), "istanbul");
  assert.equal(coverageFileKind("cobertura.xml"), "cobertura");
  assert.equal(coverageFileKind("coverage.xml"), "cobertura");
  assert.equal(coverageFileKind("README.md"), null);
});

test("pathMatches: exact or workspace-absolute suffix match", () => {
  assert.equal(pathMatches("src/a.ts", "src/a.ts"), true);
  assert.equal(pathMatches("/home/runner/work/repo/repo/src/a.ts", "src/a.ts"), true);
  assert.equal(pathMatches("other/a.ts", "src/a.ts"), false);
});

test("scanCoverageDelta: flags added lines the coverage report marks uncovered (lcov via deflated zip)", async () => {
  const findings = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("lcov.info", LCOV) }),
  );
  assert.deepEqual(findings, [{ file: "src/a.ts", uncoveredLines: [11, 14] }]);
});

test("scanCoverageDelta: an istanbul coverage-final.json artifact is parsed the same way", async () => {
  const json = JSON.stringify({
    "src/a.ts": {
      s: { "0": 0, "1": 2, "2": 0 },
      statementMap: { "0": { start: { line: 11 } }, "1": { start: { line: 13 } }, "2": { start: { line: 14 } } },
    },
  });
  const findings = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("coverage-final.json", json) }),
  );
  assert.deepEqual(findings, [{ file: "src/a.ts", uncoveredLines: [11, 14] }]);
});

test("scanCoverageDelta: fully covered added lines produce no finding", async () => {
  const findings = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("lcov.info", "SF:src/a.ts\nDA:11,2\nDA:13,1\nDA:14,3\nend_of_record") }),
  );
  assert.deepEqual(findings, []);
});

test("scanCoverageDelta: requires a github token, a head sha, and a single valid repo slug", async () => {
  const call = routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("lcov.info", LCOV) });
  const files = [{ path: "src/a.ts", patch: PR_PATCH }];
  assert.deepEqual(await scanCoverageDelta(req(files, { githubToken: undefined }), call), []);
  assert.deepEqual(await scanCoverageDelta(req(files, { headSha: undefined }), call), []);
  assert.deepEqual(await scanCoverageDelta(req(files, { repoFullName: "octo/repo/extra" }), call), []);
  assert.deepEqual(await scanCoverageDelta(req(files, { repoFullName: "bad slug/x!" }), call), []);
});

test("scanCoverageDelta: a PR that adds no lines never touches the network", async () => {
  let called = false;
  const out = await scanCoverageDelta(req([{ path: "src/a.ts", patch: "@@ -5,2 +5,0 @@\n-gone1\n-gone2" }]), async () => {
    called = true;
    return jsonResponse({});
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("scanCoverageDelta: no successful run, or no coverage artifact, yields no finding", async () => {
  const files = [{ path: "src/a.ts", patch: PR_PATCH }];
  const noRuns = await scanCoverageDelta(req(files), routed({ runs: [], artifacts: ARTIFACTS, zip: Buffer.alloc(0) }));
  assert.deepEqual(noRuns, []);
  const noArtifact = await scanCoverageDelta(
    req(files),
    routed({ runs: RUNS, artifacts: [{ id: 1, name: "build-logs", size_in_bytes: 10 }], zip: Buffer.alloc(0) }),
  );
  assert.deepEqual(noArtifact, []);
});

test("scanCoverageDelta: an oversized artifact is skipped before download", async () => {
  const findings = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: [{ id: 99, name: "coverage", size_in_bytes: 50 * 1024 * 1024 }], zip: buildZip("lcov.info", LCOV) }),
  );
  assert.deepEqual(findings, []);
});

test("scanCoverageDelta: a coverage report for a different file is not matched", async () => {
  const findings = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("lcov.info", "SF:src/other.ts\nDA:11,0\nend_of_record") }),
  );
  assert.deepEqual(findings, []);
});

test("scanCoverageDelta: fails safe on a non-ok runs fetch or a throwing fetch", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const files = [{ path: "src/a.ts", patch: PR_PATCH }];
  assert.deepEqual(await scanCoverageDelta(req(files), async () => jsonResponse({}, 500)), []);
  resetExternalFetchCircuitBreakerForTest();
  assert.deepEqual(
    await scanCoverageDelta(req(files), async () => {
      throw new Error("network");
    }),
    [],
  );
});

test("scanCoverageDelta: fails safe when the zip download errors", async () => {
  resetExternalFetchCircuitBreakerForTest();
  const out = await scanCoverageDelta(req([{ path: "src/a.ts", patch: PR_PATCH }]), async (url) => {
    if (url.includes("/actions/runs?")) return jsonResponse({ workflow_runs: RUNS });
    if (url.endsWith("/artifacts")) return jsonResponse({ artifacts: ARTIFACTS });
    return new Response("nope", { status: 500 });
  });
  assert.deepEqual(out, []);
});

test("scanCoverageDelta: stops on an already-aborted signal without a finding", async () => {
  const out = await scanCoverageDelta(
    req([{ path: "src/a.ts", patch: PR_PATCH }]),
    routed({ runs: RUNS, artifacts: ARTIFACTS, zip: buildZip("lcov.info", LCOV) }),
    { signal: AbortSignal.abort() },
  );
  assert.deepEqual(out, []);
});

test("renderBrief emits a public-safe coverage-delta block", () => {
  const { promptSection } = renderBrief({
    coverageDelta: [{ file: "src/a.ts", uncoveredLines: [11, 14] }],
  });
  assert.match(promptSection, /Coverage gaps on changed lines/);
  assert.match(promptSection, /src\/a\.ts/);
  assert.match(promptSection, /11, 14/);
});

test("renderBrief omits the coverage-delta block when there are no findings", () => {
  assert.equal(renderBrief({ coverageDelta: [] }).promptSection, "");
});
