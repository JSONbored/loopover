import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_LOG_EVENT_TYPES,
  createAttemptLogBuffer,
  formatAttemptLogJsonl,
  normalizeAttemptLogEvent,
} from "../dist/index.js";

test("ATTEMPT_LOG_EVENT_TYPES is a fixed vocabulary", () => {
  assert.deepEqual([...ATTEMPT_LOG_EVENT_TYPES], [
    "attempt_started",
    "attempt_tool_edit",
    "attempt_shadow",
    "attempt_succeeded",
    "attempt_failed",
    "attempt_aborted",
    "attempt_outcome_summary",
  ]);
});

test("normalizeAttemptLogEvent leaves provider/costUsd/tokensUsed null when omitted, and passes through real values", () => {
  const omitted = normalizeAttemptLogEvent({
    eventType: "attempt_started",
    attemptId: "a-1",
    actionClass: "codegen",
    mode: "live",
    reason: "live run",
  });
  assert.equal(omitted.provider, null);
  assert.equal(omitted.costUsd, null);
  assert.equal(omitted.tokensUsed, null);

  const withValues = normalizeAttemptLogEvent({
    eventType: "attempt_outcome_summary",
    attemptId: "a-1",
    actionClass: "attempt_submitted",
    mode: "live",
    reason: "attempt finished",
    provider: "claude-cli",
    costUsd: 0.42,
    tokensUsed: 1000,
  });
  assert.equal(withValues.provider, "claude-cli");
  assert.equal(withValues.costUsd, 0.42);
  assert.equal(withValues.tokensUsed, 1000);
});

test("normalizeAttemptLogEvent rejects a negative/non-finite costUsd or tokensUsed, never coercing to 0", () => {
  const base = {
    eventType: "attempt_outcome_summary",
    attemptId: "a-1",
    actionClass: "attempt_submitted",
    mode: "live",
    reason: "attempt finished",
  };
  assert.throws(() => normalizeAttemptLogEvent({ ...base, costUsd: -1 }), /invalid_cost_usd/);
  assert.throws(() => normalizeAttemptLogEvent({ ...base, costUsd: Number.NaN }), /invalid_cost_usd/);
  assert.throws(() => normalizeAttemptLogEvent({ ...base, costUsd: "0.5" }), /invalid_cost_usd/);
  assert.throws(() => normalizeAttemptLogEvent({ ...base, tokensUsed: -1 }), /invalid_tokens_used/);
  assert.throws(() => normalizeAttemptLogEvent({ ...base, provider: "" }), /invalid_provider/);
});

test("normalizeAttemptLogEvent validates mode and payload round-trip", () => {
  const normalized = normalizeAttemptLogEvent({
    eventType: "attempt_shadow",
    attemptId: "a-1",
    actionClass: "codegen",
    mode: "dry_run",
    reason: "dry-run shadow",
    payload: { workingDirectory: "/tmp/work" },
  });
  assert.equal(normalized.mode, "dry_run");
  assert.equal(JSON.parse(normalized.payloadJson).workingDirectory, "/tmp/work");
});

test("normalizeAttemptLogEvent rejects unknown event types and modes", () => {
  const base = {
    attemptId: "a-1",
    actionClass: "codegen",
    mode: "dry_run",
    reason: "x",
  };
  assert.throws(() => normalizeAttemptLogEvent({ ...base, eventType: "bogus" }), /invalid_event_type/);
  assert.throws(() => normalizeAttemptLogEvent({ ...base, eventType: "attempt_shadow", mode: "bogus" }), /invalid_mode/);
  assert.throws(() => normalizeAttemptLogEvent(null), /invalid_event/);
});

test("createAttemptLogBuffer appends normalized rows and exports JSONL", () => {
  const buffer = createAttemptLogBuffer();
  buffer.append({
    eventType: "attempt_started",
    attemptId: "a-1",
    actionClass: "codegen",
    mode: "live",
    reason: "live run",
  });
  buffer.append({
    eventType: "attempt_succeeded",
    attemptId: "a-1",
    actionClass: "codegen",
    mode: "live",
    reason: "done",
  });
  assert.equal(buffer.events().length, 2);
  const jsonl = formatAttemptLogJsonl(buffer.events());
  assert.equal(jsonl.split("\n").length, 2);
  assert.equal(buffer.jsonl(), jsonl);
});
