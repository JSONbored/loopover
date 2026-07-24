import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS,
  DEFAULT_MAX_REENTRIES_PER_HOUR,
  DEFAULT_MAX_REENTRIES_PER_SESSION,
  shouldReenter,
  type LoopReentryCandidate,
} from "../../packages/loopover-engine/src/index";

/** Mirrors packages/loopover-engine/test/loop-reentry-policy.test.ts — vitest root coverage for Codecov (#8347). */
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

describe("shouldReenter (vitest mirror of engine node:test suite, #8347)", () => {
  it("barrel: the public entrypoint re-exports the loop-reentry policy (#2338)", () => {
    expect(typeof shouldReenter).toBe("function");
    expect(typeof DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS).toBe("number");
  });

  it("a merged outcome with every counter well within limits re-enters cleanly", () => {
    expect(shouldReenter(baseCandidate({ outcome: "merged" }))).toEqual({ reenter: true, reasons: [] });
  });

  it("kill-switch (#2339): a global kill-switch blocks unconditionally, even with every counter otherwise clear", () => {
    expect(shouldReenter(baseCandidate({ killSwitchScope: "global" }))).toEqual({
      reenter: false,
      reasons: ["global_kill_switch_active"],
    });
  });

  it("kill-switch (#2339): a per-repo kill-switch blocks unconditionally, checked before the circuit breaker or rate caps", () => {
    expect(
      shouldReenter(baseCandidate({ killSwitchScope: "repo", outcome: "disengaged", consecutiveDisengagements: 99 })),
    ).toEqual({ reenter: false, reasons: ["repo_kill_switch_active"] });
  });

  it("kill-switch (#2339): an inactive kill-switch (scope 'none') never itself blocks -- other checks are still evaluated normally", () => {
    expect(shouldReenter(baseCandidate({ killSwitchScope: "none" })).reenter).toBe(true);
  });

  it("an 'other' outcome (neither merged nor disengaged) is never subject to the per-repo circuit breaker", () => {
    expect(shouldReenter(baseCandidate({ outcome: "other" }))).toEqual({ reenter: true, reasons: [] });
  });

  it("circuit breaker: a disengaged outcome at or beyond the consecutive-disengagement ceiling pauses the repo", () => {
    const decision = shouldReenter(
      baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 3, maxConsecutiveDisengagements: 3 }),
    );
    expect(decision.reenter).toBe(false);
    expect(decision.reasons).toEqual(["repo_paused_after_consecutive_disengagements:3>=3"]);
  });

  it("circuit breaker: a disengaged outcome below the ceiling still re-enters", () => {
    expect(
      shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 2, maxConsecutiveDisengagements: 3 }))
        .reenter,
    ).toBe(true);
  });

  it("circuit breaker: a HIGH consecutiveDisengagements count never pauses a repo whose outcome ISN'T disengaged", () => {
    // Exercises the && short-circuit's left-false side distinctly from the right-side threshold check -- a
    // repo could have a high historical tally but just landed a merge, which must not be treated as a pause.
    expect(
      shouldReenter(baseCandidate({ outcome: "merged", consecutiveDisengagements: 99, maxConsecutiveDisengagements: 3 }))
        .reenter,
    ).toBe(true);
  });

  it("rate cap: an hourly re-entry ceiling at or beyond the limit blocks, independent of repo history", () => {
    // baseCandidate defaults to outcome:"merged" — a healthy merge must still respect a spent hourly cap.
    const decision = shouldReenter(baseCandidate({ reentriesThisHour: 4, maxReentriesPerHour: 4 }));
    expect(decision.reenter).toBe(false);
    expect(decision.reasons).toEqual(["hourly_reentry_cap_reached:4>=4"]);
  });

  it("rate cap: an hourly count below the limit does not block", () => {
    expect(shouldReenter(baseCandidate({ reentriesThisHour: 3, maxReentriesPerHour: 4 })).reenter).toBe(true);
  });

  it("rate cap: a session re-entry ceiling at or beyond the limit blocks, independent of the hourly cap", () => {
    const decision = shouldReenter(baseCandidate({ reentriesThisSession: 20, maxReentriesPerSession: 20 }));
    expect(decision.reenter).toBe(false);
    expect(decision.reasons).toEqual(["session_reentry_cap_reached:20>=20"]);
  });

  it("rate cap: a session count below the limit does not block", () => {
    expect(shouldReenter(baseCandidate({ reentriesThisSession: 19, maxReentriesPerSession: 20 })).reenter).toBe(true);
  });

  it("every ceiling that is exceeded is reported, not just the first one checked", () => {
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
    expect(decision.reenter).toBe(false);
    expect(decision.reasons).toHaveLength(3);
  });

  it("default thresholds apply when the candidate omits its own overrides", () => {
    const justUnderDefault = shouldReenter(
      baseCandidate({ outcome: "disengaged", consecutiveDisengagements: DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS - 1 }),
    );
    expect(justUnderDefault.reenter).toBe(true);

    const atDefault = shouldReenter(
      baseCandidate({ outcome: "disengaged", consecutiveDisengagements: DEFAULT_MAX_CONSECUTIVE_DISENGAGEMENTS }),
    );
    expect(atDefault.reenter).toBe(false);

    expect(shouldReenter(baseCandidate({ reentriesThisHour: DEFAULT_MAX_REENTRIES_PER_HOUR })).reenter).toBe(false);
    expect(shouldReenter(baseCandidate({ reentriesThisSession: DEFAULT_MAX_REENTRIES_PER_SESSION })).reenter).toBe(false);
  });

  it("a caller-supplied threshold overrides the default rather than being ignored", () => {
    // A count that would pass under the DEFAULT ceiling must still block under a stricter caller override.
    expect(
      shouldReenter(baseCandidate({ outcome: "disengaged", consecutiveDisengagements: 1, maxConsecutiveDisengagements: 1 }))
        .reenter,
    ).toBe(false);
  });

  it("caller-supplied hourly and session thresholds override the defaults", () => {
    expect(shouldReenter(baseCandidate({ reentriesThisHour: 1, maxReentriesPerHour: 1 })).reenter).toBe(false);
    expect(shouldReenter(baseCandidate({ reentriesThisSession: 1, maxReentriesPerSession: 1 })).reenter).toBe(false);
  });
});
