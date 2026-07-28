import assert from "node:assert/strict";
import { test } from "node:test";

import { validateBenchmarkProposal, validateBenchmarkTask } from "../dist/index.js";

// #9260 (harness #9216, epic #8534): the action-space acceptance boundary any candidate agent's output
// crosses. Same discipline as attestation-envelope.test.ts: every rejection path asserted, and the errors
// are checked for the exact field path an agent author would need to fix their emitter.

const TASK = {
  schemaVersion: 1,
  benchmarkId: "sn74-maintainer-actions-2026q3",
  snapshotRef: "a1".repeat(32),
  workUnitId: "acme/widgets#123",
  horizonDays: 14,
  frozenAt: "2026-07-01T00:00:00.000Z",
};

const PROPOSAL = {
  schemaVersion: 1,
  benchmarkId: TASK.benchmarkId,
  snapshotRef: TASK.snapshotRef,
  workUnitId: TASK.workUnitId,
  subject: { kind: "agent", id: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty" },
  prediction: { kind: "act", action: { kind: "merge" } },
};

function errorsOf(result: { valid: boolean; errors?: string[] }): string[] {
  assert.equal(result.valid, false);
  return (result as { errors: string[] }).errors;
}

test("accepts every action kind with exactly its own parameters, plus first-class abstention", () => {
  const predictions = [
    { kind: "abstain" },
    { kind: "act", action: { kind: "merge" } },
    { kind: "act", action: { kind: "hold" } },
    { kind: "act", action: { kind: "close", reasonClass: "duplicate" } },
    { kind: "act", action: { kind: "request_changes", blockingConcern: "The retry loop drops the final attempt." } },
    { kind: "act", action: { kind: "label", labels: ["bug", "needs-tests"] } },
  ];
  for (const prediction of predictions) {
    const result = validateBenchmarkProposal({ ...PROPOSAL, prediction });
    assert.equal(result.valid, true, JSON.stringify(prediction));
    if (result.valid) assert.deepEqual(result.proposal.prediction, prediction);
  }
});

test("REGRESSION: the action set is CLOSED — an unrecognized action is a validation error, never a zero-scored entry", () => {
  const errors = errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action: { kind: "approve" } } }));
  assert.ok(errors.some((error) => error.includes("prediction.action.kind: expected one of merge, close, request_changes, label, hold")), errors.join("; "));
});

test("REGRESSION: parameters that do not apply to the action are a validation error, not silently ignored", () => {
  // A merge carrying labels, a hold carrying a reason, a close carrying a concern: each names the stray key.
  const cases = [
    [{ kind: "merge", labels: ["bug"] }, 'prediction.action.labels: unexpected key for action "merge"'],
    [{ kind: "hold", reasonClass: "spam" }, 'prediction.action.reasonClass: unexpected key for action "hold"'],
    [{ kind: "close", reasonClass: "spam", blockingConcern: "x" }, 'prediction.action.blockingConcern: unexpected key for action "close"'],
  ] as const;
  for (const [action, expected] of cases) {
    const errors = errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action } }));
    assert.ok(errors.includes(expected), `${JSON.stringify(action)} → ${errors.join("; ")}`);
  }
});

test("close requires a reason CLASS from the closed list; request_changes requires a bounded non-blank concern", () => {
  assert.ok(errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action: { kind: "close" } } }))
    .some((error) => error.includes("prediction.action.reasonClass")));
  assert.ok(errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action: { kind: "close", reasonClass: "because" } } }))
    .some((error) => error.includes("defective, duplicate, spam, stale, out_of_scope")));
  for (const blockingConcern of [undefined, "", "   ", "x".repeat(501)]) {
    const action = blockingConcern === undefined ? { kind: "request_changes" } : { kind: "request_changes", blockingConcern };
    assert.ok(errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action } }))
      .some((error) => error.includes("prediction.action.blockingConcern")), JSON.stringify(blockingConcern));
  }
});

test("label carries a bounded, duplicate-free, non-blank label set — each failing entry named by index", () => {
  const bad = [
    [{ kind: "label" }, "prediction.action.labels: expected 1-20 labels"],
    [{ kind: "label", labels: [] }, "prediction.action.labels: expected 1-20 labels"],
    [{ kind: "label", labels: Array.from({ length: 21 }, (_, index) => `l${index}`) }, "prediction.action.labels: expected 1-20 labels"],
    [{ kind: "label", labels: ["ok", ""] }, "prediction.action.labels[1]:"],
    [{ kind: "label", labels: ["ok", "   "] }, "prediction.action.labels[1]:"],
    [{ kind: "label", labels: ["ok", 7] }, "prediction.action.labels[1]:"],
    [{ kind: "label", labels: ["x".repeat(101)] }, "prediction.action.labels[0]:"],
    [{ kind: "label", labels: ["bug", "bug"] }, 'prediction.action.labels[1]: duplicate label "bug"'],
  ] as const;
  for (const [action, expected] of bad) {
    const errors = errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action } }));
    assert.ok(errors.some((error) => error.includes(expected)), `${JSON.stringify(action)} → ${errors.join("; ")}`);
  }
});

test("prediction shape: non-object, unknown kind, stray keys, and a malformed action object are each named", () => {
  assert.deepEqual(errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: "merge" })), ["prediction: expected an object"]);
  assert.deepEqual(errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "guess" } })), ['prediction.kind: expected "abstain" or "act"']);
  // An abstention carries NOTHING else — a smuggled action alongside an abstain is contradictory.
  assert.deepEqual(
    errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "abstain", action: { kind: "merge" } } })),
    ["prediction.action: unexpected key"],
  );
  assert.deepEqual(
    errorsOf(validateBenchmarkProposal({ ...PROPOSAL, prediction: { kind: "act", action: [] } })),
    ["prediction.action: expected an object"],
  );
});

test("proposal envelope: every identity/subject rejection names its field path", () => {
  assert.deepEqual(errorsOf(validateBenchmarkProposal(null)), ["proposal: expected an object"]);
  assert.deepEqual(errorsOf(validateBenchmarkProposal([])), ["proposal: expected an object"]);
  const cases = [
    [{ ...PROPOSAL, schemaVersion: 2 }, "schemaVersion: expected the literal 1"],
    [{ ...PROPOSAL, extra: true }, "extra: unexpected key"],
    [{ ...PROPOSAL, benchmarkId: "" }, "benchmarkId:"],
    [{ ...PROPOSAL, benchmarkId: "b".repeat(129) }, "benchmarkId:"],
    [{ ...PROPOSAL, snapshotRef: "XYZ" }, "snapshotRef: expected 64 lowercase hex characters"],
    [{ ...PROPOSAL, workUnitId: "" }, "workUnitId:"],
    [{ ...PROPOSAL, workUnitId: "w".repeat(257) }, "workUnitId:"],
    [{ ...PROPOSAL, subject: "me" }, "subject: expected an object"],
    [{ ...PROPOSAL, subject: { kind: "validator", id: "x" } }, 'subject.kind: expected "agent"'],
    [{ ...PROPOSAL, subject: { kind: "agent", id: "" } }, "subject.id:"],
    [{ ...PROPOSAL, subject: { kind: "agent", id: "i".repeat(257) } }, "subject.id:"],
    [{ ...PROPOSAL, subject: { kind: "agent", id: "x", hotwallet: "no" } }, "subject.hotwallet: unexpected key"],
  ] as const;
  for (const [raw, expected] of cases) {
    const errors = errorsOf(validateBenchmarkProposal(raw));
    assert.ok(errors.some((error) => error.includes(expected)), `${expected} ∉ ${errors.join("; ")}`);
  }
});

test("a multi-defect proposal reports ONE error per failing path, not just the first", () => {
  const errors = errorsOf(validateBenchmarkProposal({
    schemaVersion: 2,
    benchmarkId: "",
    snapshotRef: "nope",
    workUnitId: "",
    subject: { kind: "agent", id: "" },
    prediction: { kind: "act", action: { kind: "close" } },
  }));
  assert.ok(errors.length >= 5, errors.join("; "));
});

test("validateBenchmarkTask: accepts the published task shape and pins the horizon to the TASK side", () => {
  const result = validateBenchmarkTask(TASK);
  assert.equal(result.valid, true);
  if (result.valid) assert.equal(result.task.horizonDays, 14);
  // The horizon is not a proposal field at all — an agent cannot pick a flattering one.
  assert.deepEqual(
    errorsOf(validateBenchmarkProposal({ ...PROPOSAL, horizonDays: 3 })),
    ["horizonDays: unexpected key"],
  );
});

test("validateBenchmarkTask: rejection paths — envelope, version, stray keys, horizon bounds, frozenAt shape", () => {
  assert.deepEqual(errorsOf(validateBenchmarkTask("t")), ["task: expected an object"]);
  const cases = [
    [{ ...TASK, schemaVersion: 0 }, "schemaVersion: expected the literal 1"],
    [{ ...TASK, surprise: 1 }, "surprise: unexpected key"],
    [{ ...TASK, benchmarkId: "" }, "benchmarkId:"],
    [{ ...TASK, snapshotRef: "short" }, "snapshotRef:"],
    [{ ...TASK, workUnitId: "" }, "workUnitId:"],
    [{ ...TASK, horizonDays: 0 }, "horizonDays: expected an integer in [1, 365]"],
    [{ ...TASK, horizonDays: 366 }, "horizonDays: expected an integer in [1, 365]"],
    [{ ...TASK, horizonDays: 1.5 }, "horizonDays: expected an integer in [1, 365]"],
    [{ ...TASK, horizonDays: "14" }, "horizonDays: expected an integer in [1, 365]"],
    [{ ...TASK, frozenAt: "yesterday" }, "frozenAt: expected an ISO-8601 datetime string"],
    [{ ...TASK, frozenAt: "2026-13-45T99:99:99Z" }, "frozenAt: expected an ISO-8601 datetime string"],
    [{ ...TASK, frozenAt: "" }, "frozenAt: expected an ISO-8601 datetime string"],
  ] as const;
  for (const [raw, expected] of cases) {
    const errors = errorsOf(validateBenchmarkTask(raw));
    assert.ok(errors.some((error) => error.includes(expected)), `${expected} ∉ ${errors.join("; ")}`);
  }
});
