#!/usr/bin/env node
// Bin-packs the full test/**/*.test.ts file set into N balanced shards by historical duration (greedy
// LPT -- Longest Processing Time first: sort files descending by duration, repeatedly assign the next
// file to whichever shard currently has the smallest total), replacing vitest's own --shard (file
// COUNT only, no duration awareness -- confirmed via real per-shard CI timing data to produce a
// consistent ~20-30% gap between the slowest and fastest shard, every sampled run at the time).
//
// Deliberately scoped to the full-suite case only -- see ci.yml's "Test with coverage" step for how
// this output is (and is NOT) consumed. A PR using scoped test selection (--changed=origin/main)
// keeps vitest's own native --shard: that file set isn't known until vitest resolves --changed
// itself, so a precomputed assignment can't apply to it without duplicating vitest's own dependency-
// graph resolution here.
//
// HARD INVARIANT, checked before any output is written: the union of every shard's file list must
// equal EXACTLY the discovered test file set, with no file in more than one shard. A violation means
// this script would make CI silently never run some test file at all -- exactly the failure class that
// this whole session's Codecov-enforcement work exists to prevent, just introduced by the tool meant
// to speed that same pipeline up. This refuses to write ANY output if the invariant doesn't hold,
// rather than risk it: a hard failure here (a broken CI step everyone sees) is a wildly better outcome
// than a silent one (missing coverage nobody notices until something ships broken).

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "test";
const EXCLUDED_DIR = join(TEST_ROOT, "workers"); // mirrors vitest.config.ts's exclude: ["test/workers/**/*.test.ts"]

const shardsArg = Number(process.argv.find((a) => a.startsWith("--shards="))?.split("=")[1] ?? 3);
const timingArg = process.argv.find((a) => a.startsWith("--timing="))?.split("=")[1];
const outputArg = process.argv.find((a) => a.startsWith("--output="))?.split("=")[1];
if (!outputArg) throw new Error("--output=<path> is required");

function discoverTestFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === EXCLUDED_DIR) continue;
      results.push(...discoverTestFiles(full));
    } else if (entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function loadTimingData(path) {
  if (!path || !existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed.averageSecondsByFile ?? {};
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function packShards(files, durationByFile, shardCount) {
  // New/untracked files (no historical row -- a file added since the last timing refresh, or the
  // refresh workflow hasn't run yet at all) get the median of known files' durations rather than 0:
  // treating an unknown file as free would let a burst of newly-added heavy test files land in the
  // same shard unbalanced, silently reintroducing the exact imbalance this script exists to remove.
  // If NO file has any known duration at all (the real state before the first timing refresh has ever
  // run), median() of an empty array is 0 -- every file would tie at the same weight, which matters
  // below, not just as an edge case: see the tie-break comment.
  const knownDurations = Object.values(durationByFile);
  const fallback = median(knownDurations);

  const weighted = files
    .map((file) => ({ file, duration: durationByFile[file] ?? fallback }))
    .sort((a, b) => b.duration - a.duration);

  const shards = Array.from({ length: shardCount }, (_unused, index) => ({ index, files: [], total: 0 }));
  // Picking the lightest shard via a plain reduce always resolves ties in favor of the FIRST shard
  // (shard.total < min.total is never true between two equal totals, so the running minimum never
  // moves off its starting candidate) -- harmless when durations vary, but catastrophic whenever many
  // files tie at the same weight: every one of them would collapse onto shard 1 while the rest stay
  // empty. This is the real, common case, not a theoretical one -- it's exactly what happens on this
  // script's very first run, before any timing data has ever been fetched (every file falls back to
  // the same value, verified by running this script with no --timing argument against this repo's
  // real ~1000 test files: without the rotation below, 100% of them landed in shard 1). Rotating the
  // tie-break starting point after every assignment makes N equal-weight files distribute round-robin
  // across all shards instead, regardless of whether the tied weight happens to be zero or not.
  let tiebreakStart = 0;
  for (const { file, duration } of weighted) {
    let lightest = shards[tiebreakStart];
    for (let offset = 1; offset < shardCount; offset += 1) {
      const candidate = shards[(tiebreakStart + offset) % shardCount];
      if (candidate.total < lightest.total) lightest = candidate;
    }
    lightest.files.push(file);
    lightest.total += duration;
    tiebreakStart = (lightest.index + 1) % shardCount;
  }
  return shards;
}

function assertInvariant(files, shards) {
  const original = new Set(files);
  const seen = new Set();
  const duplicates = [];
  for (const shard of shards) {
    for (const file of shard.files) {
      if (seen.has(file)) duplicates.push(file);
      seen.add(file);
    }
  }
  const missing = files.filter((file) => !seen.has(file));
  const extra = [...seen].filter((file) => !original.has(file));

  if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
    const details = [
      missing.length > 0 ? `missing from every shard: ${JSON.stringify(missing)}` : null,
      duplicates.length > 0 ? `assigned to more than one shard: ${JSON.stringify(duplicates)}` : null,
      extra.length > 0 ? `assigned but not in the discovered file set: ${JSON.stringify(extra)}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    throw new Error(`compute-test-shards: shard-assignment invariant violated -- ${details}`);
  }
}

if (!existsSync(TEST_ROOT)) {
  throw new Error(`compute-test-shards: ${TEST_ROOT}/ does not exist -- run this from the repo root`);
}
const files = discoverTestFiles(TEST_ROOT).sort(); // sorted for deterministic ordering before weighting
if (files.length === 0) throw new Error(`compute-test-shards: discovered zero test files under ${TEST_ROOT}/ -- refusing to write an empty assignment`);

const durationByFile = loadTimingData(timingArg);
const shards = packShards(files, durationByFile, shardsArg);
assertInvariant(files, shards);

const assignment = {};
shards.forEach((shard, index) => {
  assignment[String(index + 1)] = shard.files;
});

writeFileSync(outputArg, JSON.stringify(assignment));

const knownCount = files.filter((f) => f in durationByFile).length;
console.log(`Assigned ${files.length} files to ${shardsArg} shards (${knownCount} with known timing, ${files.length - knownCount} using the fallback estimate).`);
shards.forEach((shard, index) => {
  console.log(`  shard ${index + 1}: ${shard.files.length} files, ~${shard.total.toFixed(1)}s estimated`);
});
