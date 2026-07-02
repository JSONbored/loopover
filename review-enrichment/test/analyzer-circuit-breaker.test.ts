import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { buildBrief } from "../dist/brief.js";
import {
  isAnalyzerCircuitOpen,
  recordAnalyzerCircuitFailure,
  recordAnalyzerCircuitSuccess,
  releaseAnalyzerCircuitProbe,
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

// Half-open probing (#2624 review follow-up): once the cooldown expires, only ONE caller should get to
// re-try the analyzer at a time — a burst of concurrent requests must not all hit the same still-unhealthy
// dependency simultaneously just because the cooldown clock happened to expire.
test("REGRESSION: below the failure-streak threshold, isAnalyzerCircuitOpen never claims a probe — a second concurrent caller is NOT skipped as circuit_open", async () => {
  // Before the fix, isAnalyzerCircuitOpen claimed probeClaimed for ANY existing state (cooldownUntilMs <=
  // nowMs is true even at cooldownUntilMs === 0, i.e. never-tripped), so a circuit with only 1-2 recorded
  // failures would spuriously block a second concurrent caller — even though the breaker never actually opened.
  recordAnalyzerCircuitFailure("history");
  recordAnalyzerCircuitFailure("history"); // 2 failures — still below the 3-failure trip threshold

  assert.equal(isAnalyzerCircuitOpen("history"), false); // first caller — not open
  assert.equal(isAnalyzerCircuitOpen("history"), false); // second, concurrent caller — also not open

  let calls = 0;
  const failing = { history: async () => { calls += 1; throw new Error("boom"); } };
  const [first, second] = await Promise.all([buildBrief(baseReq, failing), buildBrief(baseReq, failing)]);

  assert.equal(calls, 2); // both concurrent calls actually invoked the analyzer
  assert.notEqual(first.analyzerStatus.history, "skipped");
  assert.notEqual(second.analyzerStatus.history, "skipped");
});

test("half-open: only the FIRST caller after cooldown expiry gets to probe — a second caller in the same instant is still blocked", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    fakeNow = realNow + 5 * 60_000 + 1; // past the cooldown window

    assert.equal(isAnalyzerCircuitOpen("history"), false); // first caller claims the probe
    assert.equal(isAnalyzerCircuitOpen("history"), true); // second caller, same instant — still blocked
  } finally {
    Date.now = originalNow;
  }
});

test("half-open: a successful probe fully closes the circuit — a later caller is not treated as another probe", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    fakeNow = realNow + 5 * 60_000 + 1;

    assert.equal(isAnalyzerCircuitOpen("history"), false); // claims the probe
    recordAnalyzerCircuitSuccess("history");

    assert.equal(isAnalyzerCircuitOpen("history"), false); // fully closed, not "another probe"
  } finally {
    Date.now = originalNow;
  }
});

test("half-open: a failed probe re-extends the cooldown and immediately blocks new callers again", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    fakeNow = realNow + 5 * 60_000 + 1;

    assert.equal(isAnalyzerCircuitOpen("history"), false); // claims the probe
    recordAnalyzerCircuitFailure("history", fakeNow);

    assert.equal(isAnalyzerCircuitOpen("history"), true); // re-tripped, new cooldown active
  } finally {
    Date.now = originalNow;
  }
});

test("releaseAnalyzerCircuitProbe frees a claimed slot without recording an outcome, so a later caller can still probe immediately", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    recordAnalyzerCircuitFailure("history");
    fakeNow = realNow + 5 * 60_000 + 1;

    assert.equal(isAnalyzerCircuitOpen("history"), false); // claims the probe
    assert.equal(isAnalyzerCircuitOpen("history"), true); // second caller blocked

    releaseAnalyzerCircuitProbe("history"); // e.g. the probing analyzer never ran (budget-capped)

    assert.equal(isAnalyzerCircuitOpen("history"), false); // released — a fresh probe can be claimed
  } finally {
    Date.now = originalNow;
  }
});

test("releaseAnalyzerCircuitProbe on an analyzer with no circuit state, or no claimed probe, is a safe no-op", () => {
  assert.doesNotThrow(() => releaseAnalyzerCircuitProbe("secret"));
  recordAnalyzerCircuitFailure("secret");
  assert.doesNotThrow(() => releaseAnalyzerCircuitProbe("secret")); // tripped but cooling down, no probe claimed
  assert.equal(isAnalyzerCircuitOpen("secret"), false); // below the streak threshold — unaffected either way
});

test("end-to-end: two concurrent buildBrief calls right after cooldown expiry — only the FIRST invokes the analyzer, the second is skipped as circuit_open", async () => {
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("secret");
    recordAnalyzerCircuitFailure("secret");
    recordAnalyzerCircuitFailure("secret");
    fakeNow = realNow + 5 * 60_000 + 1;

    let calls = 0;
    const secretReq = { ...baseReq, analyzers: ["secret"] };
    const ok = { secret: async () => { calls += 1; return []; } };
    // Async functions run synchronously up to their first `await`, so both buildBrief() calls' planning
    // phases (fully synchronous, including isAnalyzerCircuitOpen) resolve in call order BEFORE either
    // promise is awaited — this deterministically reproduces the "burst right after cooldown expiry" race.
    const [first, second] = await Promise.all([buildBrief(secretReq, ok), buildBrief(secretReq, ok)]);

    assert.equal(calls, 1);
    assert.notEqual(first.analyzerStatus.secret, "skipped");
    assert.equal(second.analyzerStatus.secret, "skipped");
    assert.equal(second.telemetry.analyzers.secret.skipReason, "circuit_open");
  } finally {
    Date.now = originalNow;
  }
});

test("REGRESSION: a half-open probe claim is not leaked when the SAME planning pass skips the analyzer for an UNRELATED reason", async () => {
  // Before the fix, isAnalyzerCircuitOpen was checked FIRST in skipReasonForAnalyzer, so it could claim the
  // half-open probe even for a request that's about to be skipped for a totally unrelated reason (e.g. no
  // added lines for "secret"). Since a plan.skipped item never reaches runAnalyzer -- the only place a
  // claimed probe is released -- that claim would leak forever, permanently blocking every later request
  // from ever probing the analyzer again even once it's actually healthy.
  const realNow = Date.now();
  let fakeNow = realNow;
  const originalNow = Date.now;
  try {
    Date.now = () => fakeNow;
    recordAnalyzerCircuitFailure("secret");
    recordAnalyzerCircuitFailure("secret");
    recordAnalyzerCircuitFailure("secret");
    fakeNow = realNow + 5 * 60_000 + 1; // past the cooldown window

    // A pure deletion (no `+` line) — "secret" requires added lines, so this is skipped as "no_added_lines",
    // unrelated to the circuit breaker.
    const noAddedLinesReq = {
      ...baseReq,
      analyzers: ["secret"],
      files: [{ path: "src/a.ts", patch: "@@ -1,1 +1,0 @@\n-export const a = 1;" }],
    };
    const noop = { secret: async () => [] };
    const unrelatedSkip = await buildBrief(noAddedLinesReq, noop);
    assert.equal(unrelatedSkip.analyzerStatus.secret, "skipped");
    assert.equal(unrelatedSkip.telemetry.analyzers.secret.skipReason, "no_added_lines");

    // A LATER, normal request must still be able to claim a fresh probe — not spuriously blocked as
    // circuit_open by a claim the unrelated skip above should never have made in the first place.
    let calls = 0;
    const secretReq = { ...baseReq, analyzers: ["secret"] };
    const ok = { secret: async () => { calls += 1; return []; } };
    const probe = await buildBrief(secretReq, ok);

    assert.equal(calls, 1);
    assert.notEqual(probe.analyzerStatus.secret, "skipped");
  } finally {
    Date.now = originalNow;
  }
});
