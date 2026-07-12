import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { buildBrief } from "../dist/brief.js";
import { counterValue, resetMetrics } from "../dist/metrics.js";

const baseReq = {
  repoFullName: "o/r",
  prNumber: 1,
  diff: "@@ -1 +1 @@",
  files: [{ path: "a.ts", patch: "@@ -1 +1 @@" }],
};

beforeEach(() => {
  resetMetrics();
});

test("records an 'ok' outcome + a duration observation for an analyzer that resolves cleanly", async () => {
  await buildBrief(
    { ...baseReq, analyzers: ["todoMarker"] },
    { todoMarker: async () => [] },
  );
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "ok" }), 1);
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "degraded" }), 0);
});

test("records a 'degraded' outcome when the analyzer's result reports partial:true", async () => {
  await buildBrief(
    { ...baseReq, analyzers: ["todoMarker"] },
    { todoMarker: async () => [{ partial: true }] },
  );
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "degraded" }), 1);
});

test("records a 'timeout' outcome when the analyzer never resolves within its budget", async () => {
  // No explicit budget override: the default "balanced" profile gives a "local"-cost analyzer a 750ms
  // per-analyzer timeout (see scheduler.ts's PROFILE_CONFIG), comfortably below this test's own timeout.
  await buildBrief(
    { ...baseReq, analyzers: ["todoMarker"] },
    { todoMarker: () => new Promise(() => {}) }, // never resolves
  );
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "timeout" }), 1);
});

test("records a degraded/error outcome when the analyzer throws synchronously", async () => {
  await buildBrief(
    { ...baseReq, analyzers: ["todoMarker"] },
    {
      todoMarker: async () => {
        throw new Error("boom");
      },
    },
  );
  // A thrown (non-timeout) failure resolves to "degraded" via timeoutStatus's statusFromDiagnostics fallback.
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "degraded" }), 1);
});

test("records a 'skipped' outcome for every analyzer not in an explicit request list, with no duration series", async () => {
  await buildBrief(
    { ...baseReq, analyzers: ["todoMarker"] },
    { todoMarker: async () => [], conflictMarker: async () => [] },
  );
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "conflictMarker", status: "skipped" }), 1);
});

test("records a 'skipped' outcome for an analyzer the scheduler pre-filters (missing a hard requirement)", async () => {
  await buildBrief(
    { ...baseReq, files: [], analyzers: ["todoMarker"] }, // todoMarker requires files; none provided
    { todoMarker: async () => [] },
  );
  assert.equal(counterValue("rees_analyzer_runs_total", { analyzer: "todoMarker", status: "skipped" }), 1);
});
