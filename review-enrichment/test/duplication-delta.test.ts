// Units for the duplication-removal delta analyzer (#4741, part of epic #4737). Own file (not duplication-scan.test.ts)
// since this is a distinct analyzer, even though it reuses duplication-scan.ts's chunk-matching primitives. Runs
// against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanDuplicationDelta,
  findInternalDuplicatePairs,
  assignSurvivors,
} from "../dist/analyzers/duplication-delta.js";
import { buildMatchIndex } from "../dist/analyzers/duplication-scan.js";
import { renderBrief } from "../dist/render.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

// A run of exactly MIN_RUN (8) significant, non-trivial, non-import lines — long enough after normalization
// (>= 12 chars trimmed) to register as one contiguous significant-line block, short enough to stay readable.
const DUP_BLOCK = [
  "const baseAmountForMiner = minerStats.baseReward * minerStats.decayFactor",
  "const clampedAmountValue = Math.min(minerStats.maxReward, Math.max(0, baseAmountForMiner))",
  "const streakBonusApplied = minerStats.streakBonus * minerStats.consistencyFactor",
  "const violationPenaltyApplied = minerStats.violationCount * minerStats.penaltyWeight",
  "const settledRewardAmount = clampedAmountValue + streakBonusApplied - violationPenaltyApplied",
  "const finalRewardRounded = Math.round(settledRewardAmount * 1000000) / 1000000",
  "const safeFinalReward = Number.isFinite(finalRewardRounded) ? finalRewardRounded : 0",
  "const persistedRewardForMiner = safeFinalReward",
];
const HEADER = "const fileHeaderMarkerForFixture = 'v1'";
const TRAILER = "const fileTrailerMarkerForFixture = 'end'";

// Build a synthetic (patch, oldContent, newContent) trio for a PURE CONTIGUOUS DELETION: oldLines = prefixLines +
// removedLines + suffixLines; newLines = prefixLines + suffixLines. reconstructOldContent only ever reads the
// hunk header's `+` (new-file) start number — never the `-` side — so a single-hunk, all-removed-lines patch
// anchored at prefixLines.length correctly reverse-applies regardless of what the (unread) old-side numbers say.
function buildDeletionFixture(prefixLines, removedLines, suffixLines) {
  const newLines = [...prefixLines, ...suffixLines];
  const oldLines = [...prefixLines, ...removedLines, ...suffixLines];
  const hunkNewStart = prefixLines.length + 1; // 1-based
  const body = removedLines.map((l) => `-${l}`).join("\n");
  return {
    oldContent: oldLines.join("\n"),
    newContent: newLines.join("\n"),
    patch: `@@ -${hunkNewStart},${removedLines.length} +${hunkNewStart},0 @@\n${body}`,
  };
}

const baseReq = (overrides = {}) => ({
  repoFullName: "o/r",
  prNumber: 1,
  headSha: "a".repeat(40),
  githubToken: "tok",
  files: [],
  ...overrides,
});

// Mock fetch keyed by file path: returns 200 + body for a known path, 404 otherwise. `counter`, if given, records
// every requested URL so a test can assert how many (and which) content fetches were made.
function makeContentFetch(byPath, { counter } = {}) {
  return async (url) => {
    if (counter) counter.push(url);
    for (const [path, body] of Object.entries(byPath)) {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      if (url.includes(`/contents/${encoded}?`)) {
        return new Response(body, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
}

// ── findInternalDuplicatePairs (unit) ───────────────────────────────────────

test("findInternalDuplicatePairs: fewer than 2 blocks yields no pairs", () => {
  assert.deepEqual(findInternalDuplicatePairs([], undefined), []);
  assert.deepEqual(
    findInternalDuplicatePairs([{ norm: ["a single significant line here"], lineNos: [1] }], undefined),
    [],
  );
});

test("findInternalDuplicatePairs: more blocks than the defensive cap (150) are skipped entirely", () => {
  const blocks = Array.from({ length: 151 }, (_, i) => ({
    norm: [`unique significant filler line number ${i} for the cap test`],
    lineNos: [i + 1],
  }));
  assert.deepEqual(findInternalDuplicatePairs(blocks, undefined), []);
});

test("findInternalDuplicatePairs: finds a matching pair with correct block indices, lines, and length", () => {
  const blocks = [
    { norm: DUP_BLOCK, lineNos: [10, 11, 12, 13, 14, 15, 16, 17] }, // index 0
    { norm: ["a totally unrelated short filler line here"], lineNos: [30] }, // index 1 — no match
    { norm: DUP_BLOCK, lineNos: [50, 51, 52, 53, 54, 55, 56, 57] }, // index 2 — duplicate of index 0
  ];
  const pairs = findInternalDuplicatePairs(blocks, undefined);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].i, 0);
  assert.equal(pairs[0].j, 2);
  assert.equal(pairs[0].iLine, 10);
  assert.equal(pairs[0].jLine, 50);
  assert.equal(pairs[0].length, 8);
});

test("findInternalDuplicatePairs: an aborted signal discards any partial pairing (empty, not partial)", () => {
  const blocks = [
    { norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] },
    { norm: DUP_BLOCK, lineNos: [20, 21, 22, 23, 24, 25, 26, 27] },
  ];
  assert.deepEqual(findInternalDuplicatePairs(blocks, AbortSignal.abort()), []);
});

test("findInternalDuplicatePairs: a signal that flips aborted DURING an in-progress match discards the whole result, not a partial pairing", () => {
  // The 4th read of `.aborted` lands inside longestSharedRun's own poll (reads 1-2: each block's index build;
  // read 3: the outer loop's per-i check; read 4: longestSharedRun's first-line poll while comparing the only
  // pair) — everything up to that point looked healthy, but a mid-match abort must still discard the result
  // rather than publish whatever partial comparison had run so far.
  let reads = 0;
  const fakeSignal = {
    get aborted() {
      reads += 1;
      return reads === 4;
    },
  };
  const blocks = [
    { norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] },
    { norm: DUP_BLOCK, lineNos: [20, 21, 22, 23, 24, 25, 26, 27] },
  ];
  assert.deepEqual(findInternalDuplicatePairs(blocks, fakeSignal), []);
});

test("findInternalDuplicatePairs: a candidate whose OWN index build failed is never matched AS a candidate, but still matches normally as a query", () => {
  // buildMatchIndex polls `signal.aborted` once per block build (at the very first line of each block, since the
  // poll interval mask always trips at index 0). A fake signal that reports aborted on ONLY the 3rd read — the
  // check inside block-index-2's own index build — leaves every other read (the earlier/later index builds, the
  // outer loop's per-i checks, and every longestSharedRun call's own poll) seeing "not aborted", so the function
  // proceeds normally apart from block 2's index being unusable as a match TARGET. This mirrors
  // duplication-scan.test.ts's own technique for exercising a mid-loop abort poll via a stateful signal getter.
  let reads = 0;
  const fakeSignal = {
    get aborted() {
      reads += 1;
      return reads === 3;
    },
  };
  const blocks = [
    { norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] }, // index 0
    { norm: ["a totally unrelated short filler line here"], lineNos: [20] }, // index 1
    { norm: DUP_BLOCK, lineNos: [30, 31, 32, 33, 34, 35, 36, 37] }, // index 2 — its own index build "fails"
    { norm: DUP_BLOCK, lineNos: [50, 51, 52, 53, 54, 55, 56, 57] }, // index 3
  ];
  const pairs = findInternalDuplicatePairs(blocks, fakeSignal);
  assert.equal(pairs.length, 2);
  // Block 2 never appears as the CANDIDATE (j) side — its index never built — but its own content is still a
  // valid QUERY (i) side against another block's (successfully built) index.
  assert.equal(pairs.some((p) => p.j === 2), false);
  assert.ok(pairs.some((p) => p.i === 0 && p.j === 3));
  assert.ok(pairs.some((p) => p.i === 2 && p.j === 3));
});

// ── assignSurvivors (unit) ───────────────────────────────────────────────────

test("assignSurvivors: two identical old blocks with only ONE matching new block — exactly one survives", () => {
  // This is the exact scenario a naive per-block "does this text exist anywhere in NEW" check gets wrong: both old
  // copies would independently "see" the single surviving occurrence and both would appear to survive. Greedy
  // assignment must let only ONE claim it.
  const oldBlocks = [
    { norm: DUP_BLOCK, lineNos: [3, 4, 5, 6, 7, 8, 9, 10] },
    { norm: DUP_BLOCK, lineNos: [12, 13, 14, 15, 16, 17, 18, 19] },
  ];
  const newIndices = [buildMatchIndex({ norm: DUP_BLOCK, lineNos: [3, 4, 5, 6, 7, 8, 9, 10] })];
  const survived = assignSurvivors(oldBlocks, newIndices, undefined);
  assert.deepEqual(survived, [true, false]);
});

test("assignSurvivors: both old blocks survive when NEW still has two distinct matching occurrences", () => {
  const oldBlocks = [
    { norm: DUP_BLOCK, lineNos: [3, 4, 5, 6, 7, 8, 9, 10] },
    { norm: DUP_BLOCK, lineNos: [12, 13, 14, 15, 16, 17, 18, 19] },
  ];
  const newIndices = [
    buildMatchIndex({ norm: DUP_BLOCK, lineNos: [3, 4, 5, 6, 7, 8, 9, 10] }),
    buildMatchIndex({ norm: DUP_BLOCK, lineNos: [12, 13, 14, 15, 16, 17, 18, 19] }),
  ];
  assert.deepEqual(assignSurvivors(oldBlocks, newIndices, undefined), [true, true]);
});

test("assignSurvivors: neither old block survives when NEW has no matching occurrence at all", () => {
  const oldBlocks = [
    { norm: DUP_BLOCK, lineNos: [3, 4, 5, 6, 7, 8, 9, 10] },
    { norm: DUP_BLOCK, lineNos: [12, 13, 14, 15, 16, 17, 18, 19] },
  ];
  const newIndices = [buildMatchIndex({ norm: ["something completely unrelated here"], lineNos: [1] })];
  assert.deepEqual(assignSurvivors(oldBlocks, newIndices, undefined), [false, false]);
});

test("assignSurvivors: an empty newIndices array means nothing survives", () => {
  const oldBlocks = [{ norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] }];
  assert.deepEqual(assignSurvivors(oldBlocks, [], undefined), [false]);
});

test("assignSurvivors: an already-aborted signal leaves every block unconfirmed (false)", () => {
  const oldBlocks = [{ norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const newIndices = [buildMatchIndex({ norm: DUP_BLOCK, lineNos: [1, 2, 3, 4, 5, 6, 7, 8] })];
  assert.deepEqual(assignSurvivors(oldBlocks, newIndices, AbortSignal.abort()), [false]);
});

// ── scanDuplicationDelta: fail-safe guards ──────────────────────────────────

test("scanDuplicationDelta: fails safe with no githubToken", async () => {
  const out = await scanDuplicationDelta(baseReq({ githubToken: undefined }), async () => {
    throw new Error("should not fetch");
  });
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: fails safe with no headSha", async () => {
  const out = await scanDuplicationDelta(baseReq({ headSha: undefined }), async () => {
    throw new Error("should not fetch");
  });
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: fails safe on an already-aborted signal without fetching", async () => {
  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" }] }),
    async () => {
      throw new Error("should not fetch");
    },
    { signal: AbortSignal.abort() },
  );
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: fails safe on a bad repoFullName", async () => {
  // A non-empty, otherwise-qualifying files array, so this genuinely exercises the slug guard rather than
  // short-circuiting on "no candidate files" first. A leading-dot owner segment (".." here) must be rejected —
  // not just any non-alphanumeric character — since every character in ".." individually passes a bare
  // `[A-Za-z0-9._-]+` class check (dots are allowed); only a first-character requirement catches it.
  const req = baseReq({
    repoFullName: "../evil",
    files: [{ path: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" }],
  });
  const out = await scanDuplicationDelta(req, async () => {
    throw new Error("should not fetch");
  });
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: fails safe on a repoFullName with the wrong number of segments", async () => {
  const req = baseReq({
    repoFullName: "only-one-segment",
    files: [{ path: "src/a.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" }],
  });
  const out = await scanDuplicationDelta(req, async () => {
    throw new Error("should not fetch");
  });
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: no candidate files (removed status, missing patch, wrong extension, excluded path) → [] without fetching", async () => {
  const req = baseReq({
    files: [
      { path: "src/gone.ts", status: "removed", patch: "@@ -1,1 +0,0 @@\n-x" },
      { path: "src/no-patch.ts", status: "modified" },
      { path: "README.md", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
      { path: "src/generated.d.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
    ],
  });
  const out = await scanDuplicationDelta(req, async () => {
    throw new Error("should not fetch");
  });
  assert.deepEqual(out, []);
});

// ── scanDuplicationDelta: reconstructOldContent null vs "" (DISTINCT cases) ─

test("scanDuplicationDelta: reconstructOldContent returning null (unreconstructable patch) skips the file", async () => {
  // Hunk anchored far past the head content's length — reconstructOldContent bails to null (mirrors its own
  // "bails when a hunk starts beyond the head content's length" test).
  const headContent = "const shortLine = 1\nconst anotherShortLine = 2";
  const req = baseReq({
    files: [{ path: "src/broken.ts", status: "modified", patch: "@@ -1,1 +9999,1 @@\n-x" }],
  });
  const out = await scanDuplicationDelta(req, makeContentFetch({ "src/broken.ts": headContent }));
  assert.deepEqual(out, []);
});

test('scanDuplicationDelta: reconstructOldContent returning "" (wholly new file) skips the file — distinct from null', async () => {
  // A pure-addition patch (old range 0,0): the file did not exist before this PR. reconstructOldContent correctly
  // returns "" here (not null) — both are falsy, but this exercises the OTHER falsy branch from the null case above.
  const newFileLines = ["const brandNewLineOne = 1", "const brandNewLineTwo = 2", "const brandNewLineThree = 3"];
  const headContent = newFileLines.join("\n");
  const patch = `@@ -0,0 +1,${newFileLines.length} @@\n${newFileLines.map((l) => `+${l}`).join("\n")}`;
  const req = baseReq({
    files: [{ path: "src/brand-new.ts", status: "added", patch }],
  });
  const out = await scanDuplicationDelta(req, makeContentFetch({ "src/brand-new.ts": headContent }));
  assert.deepEqual(out, []);
});

// ── scanDuplicationDelta: detection ─────────────────────────────────────────

test("scanDuplicationDelta: a PR that consolidates two near-identical old blocks into one produces a resolved-duplication finding", async () => {
  const prefixLines = [HEADER, "", ...DUP_BLOCK, ""];
  const removedLines = [...DUP_BLOCK, ""]; // the second (now-gone) copy, plus its trailing blank
  const suffixLines = [TRAILER];
  const { oldContent, newContent, patch } = buildDeletionFixture(prefixLines, removedLines, suffixLines);
  // Sanity-check the fixture plumbing itself before trusting the analyzer's output against it.
  assert.equal(newContent.split("\n").length, prefixLines.length + suffixLines.length);
  assert.equal(oldContent.split("\n").length, prefixLines.length + removedLines.length + suffixLines.length);

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/rewards.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/rewards.ts": newContent }),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "src/rewards.ts");
  assert.equal(out[0].lines, 8);
  // The SECOND (removed) copy began at old-content line 12 (1 header + 1 blank + 8 lines + 1 blank + 1);
  // the surviving copy it used to duplicate began at old-content line 3.
  assert.equal(out[0].line, 12);
  assert.equal(out[0].duplicateOfLine, 3);
});

test("scanDuplicationDelta: no finding when both old copies still survive in the new content (unresolved duplication)", async () => {
  // Only the header text changes; BOTH copies of DUP_BLOCK are untouched in old and new — nothing was consolidated.
  const OLD_HEADER = "const fileHeaderMarkerForFixture = 'old'";
  const NEW_HEADER = "const fileHeaderMarkerForFixture = 'new'";
  const oldLines = [OLD_HEADER, "", ...DUP_BLOCK, "", ...DUP_BLOCK, "", TRAILER];
  const newLines = [NEW_HEADER, "", ...DUP_BLOCK, "", ...DUP_BLOCK, "", TRAILER];
  const patch = `@@ -1,1 +1,1 @@\n-${OLD_HEADER}\n+${NEW_HEADER}`;

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/rewards.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/rewards.ts": newLines.join("\n") }),
  );
  assert.deepEqual(out, []);
});

test("scanDuplicationDelta: a duplicate pair where NEITHER old block survives is still reported (both sides gone)", async () => {
  const REPLACEMENT = [
    "const totallyDifferentComputationHere = doSomethingElse(inputValue)",
    "const anotherUnrelatedComputationLine = doAnotherThing(inputValue)",
  ];
  const prefixLines = [HEADER, "", ...DUP_BLOCK, "", ...DUP_BLOCK, "", TRAILER];
  const newLines = [HEADER, "", ...REPLACEMENT, "", TRAILER];
  // Both DUP_BLOCK copies (and their surrounding blanks) are replaced by REPLACEMENT — a single hunk covering the
  // whole middle section: context HEADER + blank, then remove both copies + their blanks, add REPLACEMENT + blank.
  const patch = [
    "@@ -1,2 +1,2 @@",
    ` ${HEADER}`,
    " ",
    ...DUP_BLOCK.map((l) => `-${l}`),
    "-",
    ...DUP_BLOCK.map((l) => `-${l}`),
    "-",
    ...REPLACEMENT.map((l) => `+${l}`),
    "+",
  ].join("\n");
  const oldContent = prefixLines.join("\n");
  const newContent = newLines.join("\n");
  // Sanity-check the fixture's intended pre-PR shape (21 lines: header, blank, 2x[8-line block + blank], trailer)
  // before trusting the analyzer's output against it.
  assert.equal(oldContent.split("\n").length, prefixLines.length);

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/rewards.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/rewards.ts": newContent }),
  );
  // Both copies are gone, so BOTH sides of the pair are reported (each references the other as its pre-PR
  // duplicate partner).
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((f) => f.line).sort((a, b) => a - b),
    [3, 12],
  );
  for (const finding of out) {
    assert.equal(finding.file, "src/rewards.ts");
    assert.equal(finding.lines, 8);
  }
});

test("scanDuplicationDelta: three mutually-duplicated old blocks collapsed to one report each removed block exactly once", async () => {
  const removedLines = [...DUP_BLOCK, "", ...DUP_BLOCK, ""]; // second and third copies removed
  const { newContent, patch } = buildDeletionFixture(
    [HEADER, "", ...DUP_BLOCK, ""],
    removedLines,
    [TRAILER],
  );

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/rewards.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/rewards.ts": newContent }),
  );
  // Exactly 2 findings (the two removed copies), never one finding per PAIR (which would be 3 for a 3-way mutual
  // match: (1,2), (1,3), (2,3)) — the same OLD block is never reported twice.
  assert.equal(out.length, 2);
  const reportedLines = out.map((f) => f.line).sort((a, b) => a - b);
  assert.deepEqual(reportedLines, [12, 21]);
  for (const finding of out) {
    assert.equal(finding.duplicateOfLine, 3); // both resolve against the surviving first copy
  }
});

// ── scanDuplicationDelta: network fail-safety + bounding ────────────────────

test("scanDuplicationDelta: a file whose content fetch fails (404) is skipped; scan continues to the next file", async () => {
  const prefixLines = [HEADER, "", ...DUP_BLOCK, ""];
  const removedLines = [...DUP_BLOCK, ""];
  const { newContent, patch } = buildDeletionFixture(prefixLines, removedLines, [TRAILER]);

  const req = baseReq({
    files: [
      { path: "src/missing.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-a\n+b" },
      { path: "src/rewards.ts", status: "modified", patch },
    ],
  });
  const out = await scanDuplicationDelta(req, makeContentFetch({ "src/rewards.ts": newContent }));
  assert.equal(out.length, 1);
  assert.equal(out[0].file, "src/rewards.ts");
});

test("scanDuplicationDelta: a signal aborted right as the first file's fetch resolves skips that file AND stops before the next", async () => {
  // Realistic, non-contrived cancellation: the caller's controller fires while our fetch was already in flight,
  // landing right between the fetch resolving and the rest of that file's processing. The first file's (already
  // truthy) content is discarded rather than analyzed, and the second file's fetch is never even attempted.
  const controller = new AbortController();
  const okBody = "const shortHeadContentLineOne = 1\nconst shortHeadContentLineTwo = 2";
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    controller.abort(); // simulate the cancellation landing exactly as this fetch completes
    return new Response(okBody, { status: 200 });
  };
  const req = baseReq({
    files: [
      { path: "src/first.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" },
      { path: "src/second.ts", status: "modified", patch: "@@ -1,1 +1,1 @@\n-x\n+y" },
    ],
  });
  const out = await scanDuplicationDelta(req, fetchImpl, { signal: controller.signal });
  assert.deepEqual(out, []);
  assert.equal(fetchCalls, 1); // the second file's fetch never happens — the per-file loop's abort check stops it
});

test("scanDuplicationDelta: the per-pair loop stops immediately after an i-side push reaches MAX_FINDINGS, never checking that pair's j-side", async () => {
  // 13 independent two-block "neither side survives" groups (each internally duplicated, but distinguished from
  // every other group by a unique first line so groups never cross-match). Each group normally contributes 2
  // findings (i-side then j-side); the 13th group's i-side push is the 25th finding overall, so its OWN j-side —
  // which would otherwise also qualify — must never be reached.
  const pairBlock = (groupIndex) => [
    `const uniqueGroupMarkerForFindingsCapTest${groupIndex} = computeMarkerValue(${groupIndex})`,
    ...DUP_BLOCK.slice(1),
  ];
  const groups = 13;
  const removedLines = Array.from({ length: groups }, (_, k) => {
    const block = pairBlock(k);
    return [...block, "", ...block, ""]; // two copies of this group's block, each followed by a blank
  }).flat();
  const prefixLines = [HEADER, ""];
  const { newContent, patch } = buildDeletionFixture(prefixLines, removedLines, [TRAILER]);

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/many-groups.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/many-groups.ts": newContent }),
  );
  assert.equal(out.length, 25);
});

test("scanDuplicationDelta: uses the analysis-context fetchText when supplied, instead of the bare fetch path", async () => {
  const prefixLines = [HEADER, "", ...DUP_BLOCK, ""];
  const removedLines = [...DUP_BLOCK, ""];
  const { newContent, patch } = buildDeletionFixture(prefixLines, removedLines, [TRAILER]);

  let analysisCalls = 0;
  const analysis = {
    fetchText: async (_url, _opts) => {
      analysisCalls += 1;
      return { ok: true, status: 200, data: newContent, bytes: newContent.length, elapsedMs: 0, endpointCategory: "github-contents" };
    },
  };
  const req = baseReq({ files: [{ path: "src/rewards.ts", status: "modified", patch }] });
  const out = await scanDuplicationDelta(
    req,
    async () => {
      throw new Error("bare fetch should not be used when analysis.fetchText is supplied");
    },
    { analysis },
  );
  assert.equal(analysisCalls, 1);
  assert.equal(out.length, 1);
});

test("scanDuplicationDelta: caps total findings at the shared DEFAULT_MAX_FINDINGS (25)", async () => {
  // 27 mutually-identical old copies of DUP_BLOCK, only the first survives → 26 raw resolved-duplication
  // candidates, capped at 25.
  const copies = 27;
  const removedLines = Array.from({ length: copies - 1 }, () => [...DUP_BLOCK, ""]).flat(); // all but the first copy
  const prefixLines = [HEADER, "", ...DUP_BLOCK, ""];
  const { newContent, patch } = buildDeletionFixture(prefixLines, removedLines, [TRAILER]);

  const out = await scanDuplicationDelta(
    baseReq({ files: [{ path: "src/many-dupes.ts", status: "modified", patch }] }),
    makeContentFetch({ "src/many-dupes.ts": newContent }),
  );
  assert.equal(out.length, 25);
});

// ── render ───────────────────────────────────────────────────────────────────

test("renderBrief emits a public-safe resolved-duplication block with file:line, escaping paths, never the code", () => {
  const { promptSection } = renderBrief({
    duplicationDelta: [{ file: "src/rewards.ts", line: 12, duplicateOfLine: 3, lines: 8 }],
  });
  assert.match(promptSection, /Resolved duplication/);
  assert.match(promptSection, /`src\/rewards\.ts:12`/);
  assert.match(promptSection, /`src\/rewards\.ts:3`/);
  assert.match(promptSection, /~8 lines/);
  assert.ok(!promptSection.includes("baseAmountForMiner")); // no code content ever leaks into the rendered brief
});

test("renderBrief omits the resolved-duplication section when there are no findings", () => {
  assert.equal(renderBrief({ duplicationDelta: [] }).promptSection, "");
});

test("renderBrief escapes a backtick in a duplicationDelta path (no code-span breakout)", () => {
  const { promptSection } = renderBrief({
    duplicationDelta: [{ file: "src/we`ird.ts", line: 1, duplicateOfLine: 2, lines: 8 }],
  });
  assert.ok(!promptSection.includes("we`ird"));
});
