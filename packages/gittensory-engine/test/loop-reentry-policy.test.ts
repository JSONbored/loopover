import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS,
  DEFAULT_MAX_REENTRIES_PER_HOUR,
  DEFAULT_MAX_REENTRIES_PER_SESSION,
  shouldReenter,
  type LoopReentryCandidate,
} from "../dist/index.js";

function baseCandidate(overrides: Partial<LoopReentryCandidate> = {}): LoopReentryCandidate {
  return {
    killSwitchScope: "none",
    repoFullName: "acme/widgets",
    outcome: "merged",
    consecutiveDisengagements: 0,
    reentriesThisHour: 0,
    reentriesThisSession: 0,
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the loop-reentry policy (#2338)", () => {
  assert.equal(typeof shouldReenter, "function");
  assert.equal(typeof DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS, "number");
});

test("a merged outcome with every counter well within limits re-enters cleanly", () => {
  const decision = shouldReenter(baseCandidate({ outcome: "merged" }));
  assert.deepEqual(decision, { reenter: true, reasons: [] });
});

test("kill-switch (#2339): a global kill-switch blocks unconditionally, even with every counter otherwise clear", () => {
  const decision = shouldReenter(baseCandidate({ killSwitchScope: "global" }));
  assert.deepEqual(decision, { reenter: false, reasons: ["global_kill_switch_active"] });
});

test("kill-switch (#2339): a per-repo kill-switch blocks unconditionally, checked before the circuit breaker or rate caps", () => {
  const decision = shouldReenter(
    baseCandidate({ killSwitchScope: "repo", outcome: "disengaged", consecutiveDisengagements: 99 }),
  );
  assert.deepEqual(decision, { reenter: false, reasons: ["repo_kill_switch_active"] });
});

test("kill-switch (#2339): an inactive kill-switch (scope 'none') never itself blocks -- other checks are still evaluated normally", () => {
  const decision = shouldReenter(baseCandidate({ killSwitchScope: "none" }));
  assert.equal(decision.reenter, true);
});

test("an 'other' outcome (neither merged nor disengaged) is never subject to the per-repo circuit breaker", () => {
  const decision = shouldReenter(baseCandidate({ outcome: "other" }));
  assert.deepEqual(decision, { reenter: true, reasons: [] });
});

test("circuit breaker: a disengaged outcome at or beyond the consecutive-disengagement ceiling pauses the repo", () => {
  const decision = shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 3, maxConsecutiveDisengagements: 3 }));
  assert.equal(decision.reenter, false);
  assert.deepEqual(decision.reasons, ["repo_paused_after_consecutive_disengagements:3>=3"]);
});

test("circuit breaker: a disengaged outcome below the ceiling still re-enters", () => {
  const decision = shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 2, maxConsecutiveDisengagements: 3 }));
  assert.equal(decision.reenter, true);
});

test("circuit breaker: a HIGH consecutiveDisengagements count never pauses a repo whose outcome ISN'T disengaged", () => {
  // Exercises the && short-circuit's left-false side distinctly from the right-side threshold check -- a
  // repo could have a high historical tally but just landed a merge, which must not be treated as a pause.
  const decision = shouldReenter(baseCandidate({ outcome: "merged", consecutiveDisengagements: 99, maxConsecutiveDisengagements: 3 }));
  assert.equal(decision.reenter, true);
});

test("rate cap: an hourly re-entry ceiling at or beyond the limit blocks, independent of repo history", () => {
  const decision = shouldReenter(baseCandidate({ reentriesThisHour: 4, maxReentriesPerHour: 4 }));
  assert.equal(decision.reenter, false);
  assert.deepEqual(decision.reasons, ["hourly_reentry_cap_reached:4>=4"]);
});

test("rate cap: an hourly count below the limit does not block", () => {
  const decision = shouldReenter(baseCandidate({ reentriesThisHour: 3, maxReentriesPerHour: 4 }));
  assert.equal(decision.reenter, true);
});

test("rate cap: a session re-entry ceiling at or beyond the limit blocks, independent of the hourly cap", () => {
  const decision = shouldReenter(baseCandidate({ reentriesThisSession: 20, maxReentriesPerSession: 20 }));
  assert.equal(decision.reenter, false);
  assert.deepEqual(decision.reasons, ["session_reentry_cap_reached:20>=20"]);
});

test("rate cap: a session count below the limit does not block", () => {
  const decision = shouldReenter(baseCandidate({ reentriesThisSession: 19, maxReentriesPerSession: 20 }));
  assert.equal(decision.reenter, true);
});

test("every ceiling that is exceeded is reported, not just the first one checked", () => {
  const decision = shouldReenter(
    baseCandidate({
      outcome: "disengaged",
      consecutiveDisengagements: 5,
      maxConsecutiveDisengagements: 3,
      reentriesThisHour: 10,
      maxReentriesPerHour: 4,
      reentriesThisSession: 30,
      maxReentriesPerSession: 20,
    }),
  );
  assert.equal(decision.reenter, false);
  assert.equal(decision.reasons.length, 3);
});

test("default thresholds apply when the candidate omits its own overrides", () => {
  const justUnderDefault = shouldReenter(
    baseCandidate({ outcome: "disengaged", consecutiveDisengagements: DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS - 1 }),
  );
  assert.equal(justUnderDefault.reenter, true);

  const atDefault = shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS }));
  assert.equal(atDefault.reenter, false);

  const atHourlyDefault = shouldReenter(baseCandidate({ reentriesThisHour: DEFAULT_MAX_REENTRIES_PER_HOUR }));
  assert.equal(atHourlyDefault.reenter, false);

  const atSessionDefault = shouldReenter(baseCandidate({ reentriesThisSession: DEFAULT_MAX_REENTRIES_PER_SESSION }));
  assert.equal(atSessionDefault.reenter, false);
});

test("a caller-supplied threshold overrides the default rather than being ignored", () => {
  // A count that would pass under the DEFAULT ceiling must still block under a stricter caller override.
  const decision = shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 1, maxConsecutiveDisengagements: 1 }));
  assert.equal(decision.reenter, false);
});
