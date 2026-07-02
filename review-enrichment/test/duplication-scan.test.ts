// Units for the near-verbatim duplication-scan analyzer (#1520). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanDuplication,
  normalizeLine,
  extractAddedBlocks,
  decodeBase64Utf8,
} from "../dist/analyzers/duplication-scan.js";
import { renderBrief } from "../dist/render.js";

// ── helpers ────────────────────────────────────────────────────────────────────

// A run of >= MIN_RUN (8) significant, non-trivial, non-import lines shared between the patch and a source file.
const SHARED = [
  "const totalRewardScaled = baseReward * decayFactor(epochAge)",
  "const clampedScore = Math.min(maxScore, Math.max(minScore, rawScore))",
  "const weightedAverage = sumOfWeights === 0 ? 0 : weightedTotal / sumOfWeights",
  "const normalizedVector = values.map((value) => value / vectorMagnitude)",
  "const adjustedPenalty = penaltyBase * Math.log2(violationCount + 1)",
  "const finalEmission = totalRewardScaled - adjustedPenalty + bonusAmount",
  "const roundedEmission = Math.round(finalEmission * 1000000) / 1000000",
  "const settledEmission = Number.isFinite(roundedEmission) ? roundedEmission : 0",
  "const persistedEmission = await store.write(minerHotkey, settledEmission)",
];

// Build a +-prefixed unified-diff patch that adds the given lines starting at new-file line `start`.
const addedPatch = (addedLines, start = 10) => {
  const body = addedLines.map((l) => `+${l}`).join("\n");
  return `@@ -1,0 +${start},${addedLines.length} @@\n${body}`;
};

// A source file's text where the SHARED block begins at line `at` (1-based), padded above with filler lines.
const sourceWithBlock = (block, at = 5) => {
  const filler = Array.from(
    { length: at - 1 },
    (_, i) => `const fillerVariableNumber${i} = computeFillerValueFromIndex(${i})`,
  );
  return [...filler, ...block].join("\n");
};

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const b64Bytes = (arr) => Buffer.from(Uint8Array.from(arr)).toString("base64");
// Build a real Response so the shared boundedFetchJson body reader (used when no analysis context is injected)
// parses it exactly as it would a live GitHub reply.
const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);

// Mock fetch that switches on the URL: git/trees → the tree; git/blobs/{sha} → that blob's content.
const makeFetch = ({
  tree,
  blobs,
  truncated = false,
  treeOk = true,
  treeBadJson = false,
  blobStatus = {},
  blobThrow = new Set(),
  counter,
}) => {
  return async (url) => {
    if (counter) counter.calls.push(url);
    if (url.includes("/git/trees/")) {
      if (counter) counter.tree++;
      if (!treeOk) return jsonResponse({}, { status: 500 });
      if (treeBadJson) return jsonResponse({ nope: 1 });
      return jsonResponse({
        tree: tree.map((t) => ({ path: t.path, type: "blob", sha: t.sha })),
        truncated,
      });
    }
    const m = /\/git\/blobs\/([0-9a-fA-F]+)/.exec(url);
    if (m) {
      const sha = m[1];
      if (counter) counter.blob++;
      if (blobThrow.has(sha)) throw new Error("network down");
      const code = blobStatus[sha];
      if (code && !(code >= 200 && code < 300)) {
        return jsonResponse({}, { status: code });
      }
      const content = blobs[sha];
      if (content === undefined) {
        return jsonResponse({ encoding: "utf8", content: "x" });
      }
      return jsonResponse({ encoding: "base64", content: b64(content) });
    }
    throw new Error(`unexpected url ${url}`);
  };
};

const baseReq = (overrides = {}) => ({
  repoFullName: "o/r",
  prNumber: 1,
  headSha: "a".repeat(40),
  githubToken: "tok",
  files: [{ path: "src/new-scorer.ts", status: "added", patch: addedPatch(SHARED) }],
  ...overrides,
});

// ── normalizeLine / extractAddedBlocks units ────────────────────────────────────

test("normalizeLine: drops blanks, trivial, punctuation-only and bare imports; keeps significant code", () => {
  assert.equal(normalizeLine("   "), null);
  assert.equal(normalizeLine("})"), null); // punctuation only
  assert.equal(normalizeLine("} else {"), null); // < MIN_SIGNIFICANT_LEN after trim
  assert.equal(normalizeLine("short"), null); // too short
  assert.equal(normalizeLine("import { foo } from './bar'"), null); // bare import
  assert.equal(normalizeLine("   const x = computeWeightedScore(a, b)  "), "const x = computeWeightedScore(a, b)");
  assert.equal(
    normalizeLine("const   y    =   1234567890 + somethingLong"),
    "const y = 1234567890 + somethingLong",
  ); // internal whitespace collapsed
});

test("extractAddedBlocks: groups consecutive added lines, breaks on context/removed/trivial, tracks new-file line numbers", () => {
  const patch = [
    "@@ -1,2 +5,6 @@",
    "+const firstSignificantLineHere = makeValue(1)",
    "+const secondSignificantLineHere = makeValue(2)",
    " contextLineThatBreaksTheRun",
    "+const thirdSignificantLineHere = makeValue(3)",
    "-removedLineDoesNotCount",
    "+const fourthSignificantLineHere = makeValue(4)",
  ].join("\n");
  const blocks = extractAddedBlocks(patch);
  // block1: lines 5,6 ; block2: line 8 (after one context line at 7) ; block3: line 9 (removed doesn't advance)
  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks[0].lineNos, [5, 6]);
  assert.deepEqual(blocks[1].lineNos, [8]);
  assert.deepEqual(blocks[2].lineNos, [9]);
});

test("extractAddedBlocks: keeps an added line whose content starts with `++` (patch line `+++…`) and keeps line numbers aligned", () => {
  // A pre-increment statement `++counterValueForLoop;` becomes the patch line `+++counterValueForLoop;`. The
  // `+++` file-header marker only appears in the preamble (before the first `@@`), so inside a hunk this is a
  // real added line — it must not be dropped, and it must not shift the following lines' numbers.
  const patch = [
    "@@ -1,0 +10,3 @@",
    "+++counterValueForLoop;",
    "+const secondSignificantLineHere = makeValue(2)",
    "+const thirdSignificantLineHere = makeValue(3)",
  ].join("\n");
  const blocks = extractAddedBlocks(patch);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0].lineNos, [10, 11, 12]); // not [10, 11] with the ++ line dropped
  assert.equal(blocks[0].norm.length, 3);
  assert.ok(blocks[0].norm[0].includes("counterValueForLoop")); // the ++ line survived
});

test("decodeBase64Utf8: decodes UTF-8 blob content without globalThis.Buffer (Cloudflare Worker deployment path)", () => {
  // The production decode must not depend on Node's Buffer. Encode while Buffer exists, then remove it and decode.
  const text = "const computedScore = weight * factor + base\nconst total = computedScore + bonusAmount + café";
  const encoded = b64(text);
  const savedBuffer = globalThis.Buffer;
  globalThis.Buffer = undefined; // simulate a runtime with no Node Buffer (Worker)
  try {
    const out = decodeBase64Utf8(encoded);
    assert.equal(out?.text, text); // atob/TextDecoder path, multi-byte UTF-8 (é) preserved
    assert.ok(out.byteLength >= text.length); // byte length, not UTF-16 code-unit length
  } finally {
    globalThis.Buffer = savedBuffer;
  }
});

test("decodeBase64Utf8: malformed base64 fails safe to null (never throws)", () => {
  assert.equal(decodeBase64Utf8("!!!not base64!!!"), null);
});

test("decodeBase64Utf8: invalid UTF-8 (binary) content fails safe to null (fatal decode)", () => {
  // base64 of the bytes 0xFF 0xFE 0xFD — not valid UTF-8; a binary blob must decode to null, not garbage.
  const invalidUtf8B64 = b64Bytes([0xff, 0xfe, 0xfd]);
  assert.equal(decodeBase64Utf8(invalidUtf8B64), null);
});

test("scanDuplication: a match cannot bridge a blank/trivial line in the source (per-block indexing)", async () => {
  // Added: 8 contiguous significant lines. Candidate: the same 8 lines, but split by a blank line into two 4-line
  // blocks. With per-block indexing neither candidate block reaches MIN_RUN (8) contiguously, so there is NO match.
  const eight = SHARED.slice(0, 8);
  const splitCandidate = [...eight.slice(0, 4), "", ...eight.slice(4)].join("\n");
  const fetchImpl = makeFetch({
    tree: [{ path: "src/other.ts", sha: "c".repeat(40) }],
    blobs: { ["c".repeat(40)]: splitCandidate },
  });
  const req = baseReq({ files: [{ path: "src/new.ts", status: "added", patch: addedPatch(eight) }] });
  assert.deepEqual(await scanDuplication(req, fetchImpl), []);
});

test("scanDuplication: mixed-extension PR does not cross-match (a .ts block is not compared to a .py candidate)", async () => {
  // A changed .ts file whose added block lives VERBATIM in a .py candidate file. Cross-extension matching is a bug;
  // the per-extension guard must prevent any finding here.
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    headSha: "a".repeat(40),
    githubToken: "tok",
    files: [
      { path: "src/scorer.ts", status: "added", patch: addedPatch(SHARED) },
      { path: "src/util.py", status: "added", patch: "@@ -1,0 +1,1 @@\n+def helper(value): return value + 1" },
    ],
  };
  const fetchImpl = makeFetch({
    tree: [
      { path: "lib/copy.py", sha: "b".repeat(40) }, // .py file containing the .ts block — must NOT match
      { path: "lib/other.ts", sha: "c".repeat(40) }, // unrelated .ts
    ],
    blobs: {
      ["b".repeat(40)]: sourceWithBlock(SHARED),
      ["c".repeat(40)]: "const unrelatedConstantValue = computeSomethingDifferentEntirely(42)",
    },
  });
  assert.deepEqual(await scanDuplication(req, fetchImpl), []);
});

test("scanDuplication: per-extension budget — a .py duplicate is still found despite >40 unrelated .ts candidates", async () => {
  // 8 significant Python lines for the .py side.
  const PY_SHARED = [
    "total_reward_scaled = base_reward * decay_factor(epoch_age)",
    "clamped_score = min(max_score, max(min_score, raw_score))",
    "weighted_average = 0 if sum_of_weights == 0 else weighted_total / sum_of_weights",
    "normalized_vector = [value / vector_magnitude for value in values]",
    "adjusted_penalty = penalty_base * math.log2(violation_count + 1)",
    "final_emission = total_reward_scaled - adjusted_penalty + bonus_amount",
    "rounded_emission = round(final_emission * 1000000) / 1000000",
    "settled_emission = rounded_emission if math.isfinite(rounded_emission) else 0",
  ];
  // 45 unrelated .ts candidates that would overflow a single global slice(40) and starve the .py side.
  const tsFillers = Array.from({ length: 45 }, (_, i) => ({
    path: `lib/ts/filler${i}.ts`,
    sha: "a".repeat(38) + i.toString().padStart(2, "0"),
  }));
  const pyDup = { path: "lib/py/copy.py", sha: "f".repeat(40) };
  const blobs = { [pyDup.sha]: sourceWithBlock(PY_SHARED) };
  for (const f of tsFillers) {
    blobs[f.sha] = `const noMatchFiller${f.sha.slice(-2)} = computeUnrelatedFillerValue(123456)`;
  }
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    headSha: "a".repeat(40),
    githubToken: "tok",
    files: [
      { path: "src/scorer.ts", status: "added", patch: addedPatch(SHARED) },
      { path: "src/scorer.py", status: "added", patch: addedPatch(PY_SHARED) },
    ],
  };
  const findings = await scanDuplication(req, makeFetch({ tree: [...tsFillers, pyDup], blobs }));
  assert.ok(
    findings.some((x) => x.sourceFile === "lib/py/copy.py" && x.file === "src/scorer.py"),
    JSON.stringify(findings),
  );
});

test("scanDuplication: total blob fetches across all changed extensions never exceed the global MAX_FETCHES budget", async () => {
  // Two extensions, each with 25 candidates (50 total). Round-robin under ONE global budget must cap total fetches.
  const PY = [
    "py_total_reward = base_reward * decay_factor_for_epoch(epoch_age)",
    "py_clamped_score = min(max_score, max(min_score, raw_score_value))",
    "py_weighted_avg = 0 if total_weight == 0 else weighted_sum / total_weight",
    "py_normalized = [value / vector_magnitude for value in raw_values]",
    "py_adjusted_penalty = penalty_base * log2_of(violation_count + 1)",
    "py_final_emission = py_total_reward - py_adjusted_penalty + bonus_amount",
    "py_rounded = round(py_final_emission * 1000000) / 1000000.0",
    "py_settled = py_rounded if is_finite_number(py_rounded) else 0.0",
  ];
  const tsFillers = Array.from({ length: 25 }, (_, i) => ({ path: `lib/ts/f${i}.ts`, sha: "a".repeat(38) + i.toString().padStart(2, "0") }));
  const pyFillers = Array.from({ length: 25 }, (_, i) => ({ path: `lib/py/f${i}.py`, sha: "b".repeat(38) + i.toString().padStart(2, "0") }));
  const blobs = {};
  for (const f of [...tsFillers, ...pyFillers]) {
    blobs[f.sha] = `const unrelatedFiller${f.sha.slice(-2)} = computeUnrelatedFillerValue(987654)`;
  }
  const counter = { calls: [], tree: 0, blob: 0 };
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    headSha: "a".repeat(40),
    githubToken: "tok",
    files: [
      { path: "src/a.ts", status: "added", patch: addedPatch(SHARED) },
      { path: "src/b.py", status: "added", patch: addedPatch(PY) },
    ],
  };
  await scanDuplication(req, makeFetch({ tree: [...tsFillers, ...pyFillers], blobs, counter }));
  assert.ok(counter.blob <= 30, `blob fetches=${counter.blob} exceeded MAX_FETCHES (30)`);
  assert.ok(counter.blob > 0, "expected some candidate fetches");
});

test("extractAddedBlocks: empty/undefined patch → no blocks", () => {
  assert.deepEqual(extractAddedBlocks(undefined), []);
  assert.deepEqual(extractAddedBlocks(""), []);
});

test("scanDuplication: an oversized candidate blob is skipped so it cannot eat the budget", async () => {
  // The SHARED block IS present in this candidate, but the file exceeds MAX_FILE_BYTES → never scanned → no finding.
  const oversized = sourceWithBlock(SHARED) + "\n" + "x".repeat(500_001);
  const fetch = makeFetch({
    tree: [{ path: "src/huge-generated.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: oversized },
  });
  assert.deepEqual(await scanDuplication(baseReq(), fetch), []);
});

// ── scanDuplication detection ────────────────────────────────────────────────────

test("scanDuplication: detects a near-verbatim duplicate with correct head vs source location and line count", async () => {
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) },
  });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "src/new-scorer.ts");
  assert.equal(findings[0].line, 10); // patch starts the added block at new-file line 10
  assert.equal(findings[0].sourceFile, "src/existing-scorer.ts");
  assert.equal(findings[0].sourceLine, 5); // SHARED block begins at line 5 in the source
  assert.equal(findings[0].lines, SHARED.length); // entire 9-line run matched
});

test("scanDuplication: a run shorter than MIN_RUN is not flagged (no false positive)", async () => {
  const short = SHARED.slice(0, 7); // 7 < MIN_RUN (8)
  const req = baseReq({
    files: [{ path: "src/new-scorer.ts", status: "added", patch: addedPatch(short) }],
  });
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: sourceWithBlock(short, 5) },
  });
  assert.deepEqual(await scanDuplication(req, fetchImpl), []);
});

test("scanDuplication: boilerplate-only / import-only added lines are never flagged", async () => {
  const boilerplate = Array.from({ length: 12 }, (_, i) => `import { thing${i} } from './m${i}'`);
  const req = baseReq({
    files: [{ path: "src/new-scorer.ts", status: "added", patch: addedPatch(boilerplate) }],
  });
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: boilerplate.join("\n") },
  });
  assert.deepEqual(await scanDuplication(req, fetchImpl), []);
});

test("scanDuplication: the changed file itself is excluded as a candidate", async () => {
  // Only candidate in the tree IS the changed file → no other source to match against → no finding.
  const counter = { calls: [], tree: 0, blob: 0 };
  const fetchImpl = makeFetch({
    tree: [{ path: "src/new-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) },
    counter,
  });
  assert.deepEqual(await scanDuplication(baseReq(), fetchImpl), []);
  assert.equal(counter.blob, 0); // no blob fetched — the only tree entry was the changed file
});

test("scanDuplication: only same-extension candidates are considered", async () => {
  const counter = { calls: [], tree: 0, blob: 0 };
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.py", sha: "b".repeat(40) }], // .py vs changed .ts
    blobs: { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) },
    counter,
  });
  assert.deepEqual(await scanDuplication(baseReq(), fetchImpl), []);
  assert.equal(counter.blob, 0); // wrong extension → never fetched
});

// ── fail-safe guards ─────────────────────────────────────────────────────────────

test("scanDuplication: fails safe with no githubToken", async () => {
  assert.deepEqual(await scanDuplication(baseReq({ githubToken: undefined }), async () => {
    throw new Error("should not fetch");
  }), []);
});

test("scanDuplication: fails safe with no headSha", async () => {
  assert.deepEqual(await scanDuplication(baseReq({ headSha: undefined }), async () => {
    throw new Error("should not fetch");
  }), []);
});

test("scanDuplication: fails safe on a bad repoFullName", async () => {
  assert.deepEqual(await scanDuplication(baseReq({ repoFullName: "../evil" }), async () => {
    throw new Error("should not fetch");
  }), []);
});

test("scanDuplication: fails safe when the tree fetch is non-OK", async () => {
  const fetchImpl = makeFetch({ tree: [], blobs: {}, treeOk: false });
  assert.deepEqual(await scanDuplication(baseReq(), fetchImpl), []);
});

test("scanDuplication: fails safe on malformed tree json (no tree array)", async () => {
  const fetchImpl = makeFetch({ tree: [], blobs: {}, treeBadJson: true });
  assert.deepEqual(await scanDuplication(baseReq(), fetchImpl), []);
});

test("scanDuplication: a candidate whose blob fetch is non-OK is skipped, scan continues", async () => {
  const fetchImpl = makeFetch({
    tree: [
      { path: "src/broken.ts", sha: "b".repeat(40) }, // non-OK blob
      { path: "src/existing-scorer.ts", sha: "c".repeat(40) }, // good duplicate
    ],
    blobs: { ["c".repeat(40)]: sourceWithBlock(SHARED, 5) },
    blobStatus: { ["b".repeat(40)]: 404 },
  });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-scorer.ts");
});

test("scanDuplication: a candidate whose blob fetch throws is skipped, scan continues", async () => {
  const fetchImpl = makeFetch({
    tree: [
      { path: "src/broken.ts", sha: "b".repeat(40) },
      { path: "src/existing-scorer.ts", sha: "c".repeat(40) },
    ],
    blobs: { ["c".repeat(40)]: sourceWithBlock(SHARED, 5) },
    blobThrow: new Set(["b".repeat(40)]),
  });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-scorer.ts");
});

test("scanDuplication: a candidate blob with non-base64 encoding is skipped", async () => {
  // "src/plain.ts" returns encoding utf8 (not base64) → decoded to null → skipped; the real dup still matches.
  const fetchImpl = makeFetch({
    tree: [
      { path: "src/plain.ts", sha: "b".repeat(40) },
      { path: "src/existing-scorer.ts", sha: "c".repeat(40) },
    ],
    blobs: { ["c".repeat(40)]: sourceWithBlock(SHARED, 5) }, // b-sha has no entry → utf8 fallback in mock
  });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-scorer.ts");
});

test("scanDuplication: a truncated tree still works on the returned entries", async () => {
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) },
    truncated: true,
  });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
});

// ── bounding ──────────────────────────────────────────────────────────────────────

test("scanDuplication: respects MAX_FETCHES (caps candidate blob fetches at 30)", async () => {
  // 50 same-extension non-matching candidates → only MAX_FETCHES (30) blobs fetched.
  const tree = Array.from({ length: 50 }, (_, i) => ({
    path: `src/zzz/cand${String(i).padStart(3, "0")}.ts`,
    sha: (i + 16).toString(16).padStart(40, "0"),
  }));
  const blobs = {};
  for (const t of tree) blobs[t.sha] = "const irrelevantNonMatchingContentLine = makeUniqueValue()";
  const counter = { calls: [], tree: 0, blob: 0 };
  const fetchImpl = makeFetch({ tree, blobs, counter });
  await scanDuplication(baseReq(), fetchImpl);
  assert.equal(counter.blob, 30);
});

test("scanDuplication: bounds matching work for highly repetitive added and candidate blocks", async () => {
  // Regression for an availability bug: the same MIN_RUN window can appear thousands of times in both the added
  // block and candidate. The scan should keep enough starts to report the duplicate, but must not compare every
  // added window against every candidate start and extend each pair synchronously.
  const repeated = Array.from(
    { length: 1600 },
    () => "const repeatedSignificantLine = computeRepeatedValueForDuplicationScan(inputValue)",
  );
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-repeated.ts", sha: "d".repeat(40) }],
    blobs: { ["d".repeat(40)]: repeated.join("\n") },
  });
  const req = baseReq({
    files: [{ path: "src/new-repeated.ts", status: "added", patch: addedPatch(repeated) }],
  });

  const started = performance.now();
  const findings = await scanDuplication(req, fetchImpl);
  const elapsedMs = performance.now() - started;

  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-repeated.ts");
  assert.equal(findings[0].lines, repeated.length);
  assert.ok(elapsedMs < 1000, `repetitive scan took ${elapsedMs}ms`);
});

test("scanDuplication: finds the longest run after repeated earlier window decoys", async () => {
  // Regression for PR #1946: every real MIN_RUN window can have more than eight earlier decoy starts. The scanner
  // must still compare the true later start and report the full run, not the shorter first decoy.
  const duplicate = Array.from(
    { length: 12 },
    (_, i) => `const duplicateScanLine${i} = computeSharedDuplicateValue(inputValue, ${i})`,
  );
  const decoys = [];
  for (let repeat = 0; repeat < 9; repeat += 1) {
    for (let start = 0; start + 8 <= duplicate.length; start += 1) {
      decoys.push(...duplicate.slice(start, start + 8));
      decoys.push(
        `const decoyBreakLine${repeat}_${start} = computeDifferentDuplicateValue(inputValue, ${repeat}, ${start})`,
      );
    }
  }
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-with-decoys.ts", sha: "e".repeat(40) }],
    blobs: { ["e".repeat(40)]: [...decoys, ...duplicate].join("\n") },
  });
  const req = baseReq({
    files: [{ path: "src/new-with-decoys.ts", status: "added", patch: addedPatch(duplicate) }],
  });

  const findings = await scanDuplication(req, fetchImpl);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-with-decoys.ts");
  assert.equal(findings[0].sourceLine, decoys.length + 1);
  assert.equal(findings[0].lines, duplicate.length);
});

test("scanDuplication: respects MAX_CANDIDATES (only the closest 40 candidates are considered)", async () => {
  // 100 candidates but MAX_CANDIDATES=40 caps the set; combined with MAX_FETCHES=30 only 30 blobs fetched, and the
  // proximity sort means the in-directory candidate (sharing src/) is preferred and the match is still found.
  const tree = [
    { path: "src/existing-scorer.ts", sha: "b".repeat(40) }, // shares src/ → high proximity → fetched first
  ];
  for (let i = 0; i < 100; i++) {
    tree.push({
      path: `far/away/dir/cand${String(i).padStart(3, "0")}.ts`,
      sha: (i + 32).toString(16).padStart(40, "0"),
    });
  }
  const blobs = { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) };
  for (const t of tree) if (!(t.sha in blobs)) blobs[t.sha] = "const unrelatedFillerContentLine = uniqueValue()";
  const counter = { calls: [], tree: 0, blob: 0 };
  const fetchImpl = makeFetch({ tree, blobs, counter });
  const findings = await scanDuplication(baseReq(), fetchImpl);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sourceFile, "src/existing-scorer.ts");
  assert.ok(counter.blob <= 30); // MAX_FETCHES still bounds the work
});

test("scanDuplication: an already-aborted signal yields [] without fetching", async () => {
  const counter = { calls: [], tree: 0, blob: 0 };
  const fetchImpl = makeFetch({
    tree: [{ path: "src/existing-scorer.ts", sha: "b".repeat(40) }],
    blobs: { ["b".repeat(40)]: sourceWithBlock(SHARED, 5) },
    counter,
  });
  const findings = await scanDuplication(baseReq(), fetchImpl, { signal: AbortSignal.abort() });
  assert.deepEqual(findings, []);
  assert.equal(counter.tree, 0); // never even fetched the tree
});

test("scanDuplication: aborting inside the synchronous matcher discards a partial best run", async () => {
  // Regression for PR #1946 follow-up: cancellation during longestSharedRun must stop the scan, not publish the
  // current best prefix as if the full comparison had completed.
  const longShared = Array.from(
    { length: 1100 },
    (_, i) => `const abortSensitiveDuplicateLine${i} = computeAbortSensitiveDuplicateValue(inputValue, ${i})`,
  );
  let blobServed = false;
  let readsAfterBlob = 0;
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true,
    get() {
      if (!blobServed) return false;
      readsAfterBlob += 1;
      return readsAfterBlob >= 5;
    },
  });
  const req = baseReq({
    files: [{ path: "src/new-long-copy.ts", status: "added", patch: addedPatch(longShared) }],
  });
  const baseFetch = makeFetch({
    tree: [{ path: "src/existing-long-copy.ts", sha: "d".repeat(40) }],
    blobs: { ["d".repeat(40)]: sourceWithBlock(longShared, 5) },
  });
  const fetchImpl = async (url) => {
    const response = await baseFetch(url);
    if (url.includes("/git/blobs/")) blobServed = true;
    return response;
  };

  const findings = await scanDuplication(req, fetchImpl, { signal: controller.signal });

  assert.deepEqual(findings, []);
  assert.equal(readsAfterBlob, 5);
});

test("scanDuplication: no changed source files → [] without fetching", async () => {
  const req = baseReq({
    files: [{ path: "README.md", status: "modified", patch: addedPatch(SHARED) }],
  });
  let called = false;
  await scanDuplication(req, async () => {
    called = true;
    throw new Error("nope");
  });
  assert.equal(called, false);
});

test("scanDuplication: removed files and no added-block files are ignored", async () => {
  const req = baseReq({
    files: [
      { path: "src/gone.ts", status: "removed", patch: addedPatch(SHARED) }, // removed → skipped
    ],
  });
  let called = false;
  await scanDuplication(req, async () => {
    called = true;
    throw new Error("nope");
  });
  assert.equal(called, false);
});

// ── render ──────────────────────────────────────────────────────────────────────

test("renderBrief emits a public-safe duplication block with file:line, escaping paths, never the code", () => {
  const { promptSection } = renderBrief({
    duplication: [
      { file: "src/new-scorer.ts", line: 10, sourceFile: "src/existing-scorer.ts", sourceLine: 5, lines: 9 },
    ],
  });
  assert.match(promptSection, /Near-verbatim duplicated code/);
  assert.match(promptSection, /`src\/new-scorer\.ts:10`/);
  assert.match(promptSection, /`src\/existing-scorer\.ts:5`/);
  assert.match(promptSection, /~9 lines/);
  // No code content from SHARED ever leaks into the rendered brief.
  assert.ok(!promptSection.includes("totalRewardScaled"));
});

test("renderBrief escapes a backtick in a duplication path (no code-span breakout)", () => {
  const { promptSection } = renderBrief({
    duplication: [
      { file: "src/we`ird.ts", line: 1, sourceFile: "src/o`ther.ts", sourceLine: 2, lines: 8 },
    ],
  });
  assert.ok(!promptSection.includes("we`ird")); // raw backtick neutralized by safeCodeSpan
});
