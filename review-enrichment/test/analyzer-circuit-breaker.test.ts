import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { buildBrief } from "../dist/brief.js";
import {
  isAnalyzerCircuitOpen,
  recordAnalyzerCircuitFailure,
  recordAnalyzerCircuitSuccess,
  resetAnalyzerCircuitsForTest,
} from "../dist/analyzer-circuit-breaker.js";

afterEach(() => {
  resetAnalyzerCircuitsForTest();
});

const baseReq = {
  repoFullName: "JSONbored/gittensory",
  prNumber: 1811,
  analyzers: ["history"],
  githubToken: "token",
  author: "jsonbored",
  headSha: "abcdef1234567890",
  files: [{ path: "src/a.ts", patch: "@@ -1,0 +1,1 @@\n+export const a = 1;" }],
  budget: { timeoutMs: 2000 },
};

test("does not open the circuit before the failure streak threshold — every request still calls the analyzer", async () => {
  let calls = 0;
  const failing = { history: async () => { calls += 1; throw new Error("boom"); } };
  for (let i = 0; i < 2; i += 1) {
    const brief = await buildBrief(baseReq, failing);
    assert.equal(brief.analyzerStatus.history, "degraded");
  }
  assert.equal(calls, 2);
  assert.equal(isAnalyzerCircuitOpen("history"), false);
});

test("opens the circuit after 3 consecutive failures and SKIPS the analyzer on the next request — zero calls to the broken dependency", async () => {
  let calls = 0;
  const failing = { history: async () => { calls += 1; throw new Error("boom"); } };
  for (let i = 0; i < 3; i += 1) {
    await buildBrief(baseReq, failing);
  }
  assert.equal(calls, 3);
  assert.equal(isAnalyzerCircuitOpen("history"), true);

  const brief = await buildBrief(baseReq, failing);

  assert.equal(calls, 3); // UNCHANGED — the 4th "attempt" never happened, it was skipped at planning time
  assert.equal(brief.analyzerStatus.history, "skipped");
  assert.equal(brief.telemetry.analyzers.history.skipReason, "circuit_open");
});

test("a timeout counts as a circuit-breaker failure, same as a thrown error", async () => {
  // 300ms matches scheduler.test.ts's own proven-stable timeout budget: tight enough to time out reliably,
  // but not so tight it races into "capped" (the reserved-response-budget pre-check) instead of "timeout".
  const hanging = { history: async () => new Promise(() => undefined) };
  const timeoutReq = { ...baseReq, budget: { timeoutMs: 300 } };
  for (let i = 0; i < 3; i += 1) {
    const brief = await buildBrief(timeoutReq, hanging);
    assert.equal(brief.analyzerStatus.history, "timeout");
  }
  assert.equal(isAnalyzerCircuitOpen("history"), true);
});

test("a non-throwing DEGRADED/partial result does NOT count as a circuit-breaker failure (the dependency responded)", async () => {
  // resultIsPartial (brief.ts) checks per-entry `.partial === true`, matching the real analyzer-result shape.
  // Uses "secret" (a flat SecretFinding[] result, unlike history's nested similarPastPrs render requirement).
  const secretReq = { ...baseReq, analyzers: ["secret"] };
  const partiallyOk = { secret: async () => [{ file: "a.ts", line: 1, kind: "test", confidence: "high", partial: true }] };
  for (let i = 0; i < 5; i += 1) {
    const brief = await buildBrief(secretReq, partiallyOk);
    assert.equal(brief.analyzerStatus.secret, "degraded");
    assert.notEqual(brief.analyzerStatus.secret, "skipped");
  }
  assert.equal(isAnalyzerCircuitOpen("secret"), false);
});

test("a success resets the streak so it does not carry over into a LATER, separate run of failures", async () => {
  recordAnalyzerCircuitFailure("history");
  recordAnalyzerCircuitFailure("history");
  recordAnalyzerCircuitSuccess("history");
  let calls = 0;
  const failing = { history: async () => { calls += 1; throw new Error("boom"); } };
  // Two MORE failures after the reset — still below the streak threshold on their own.
  await buildBrief(baseReq, failing);
  await buildBrief(baseReq, failing);
  assert.equal(calls, 2);
  assert.equal(isAnalyzerCircuitOpen("history"), false);
});

test("REGRESSION: a circuit-expired analyzer is tried again rather than staying open forever", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    assert.equal(isAnalyzerCircuitOpen("history"), true);

    fakeNow = realNow + 5 * 60_000 + 1; // past the cooldown window

    assert.equal(isAnalyzerCircuitOpen("history"), false);
  } finally {
    Date.now = originalNow;
  }
});

test("recordAnalyzerCircuitSuccess on an analyzer with no prior failures is a safe no-op", () => {
  assert.doesNotThrow(() => recordAnalyzerCircuitSuccess("secret"));
  assert.equal(isAnalyzerCircuitOpen("secret"), false);
});

test("an EXPLICITLY requested analyzer (req.analyzers) is still skipped while its circuit is open — the explicit request can't fix a down dependency", async () => {
  let calls = 0;
  const failing = { history: async () => { calls += 1; throw new Error("boom"); } };
  for (let i = 0; i < 3; i += 1) {
    await buildBrief(baseReq, failing);
  }
  assert.equal(calls, 3);

  const explicitReq = { ...baseReq, analyzers: ["history"] };
  const brief = await buildBrief(explicitReq, failing);

  assert.equal(calls, 3);
  assert.equal(brief.analyzerStatus.history, "skipped");
});
