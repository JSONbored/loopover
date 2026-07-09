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
    "attempt_shadow",
    "attempt_succeeded",
    "attempt_failed",
    "attempt_aborted",
  ]);
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
