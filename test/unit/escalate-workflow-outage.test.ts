import { describe, expect, it } from "vitest";

import {
  AUTOMATION_RUN_NAME_MARKER,
  isAutomationDispatched,
  leadingNonSuccessCount,
  outageIssueTitle,
  type WorkflowRunSummary,
} from "../../scripts/escalate-workflow-outage";

// #10146: a post-merge workflow going red blocks nothing and pages no one.
//
// #9951 built this counting for the publish workflows after they failed on every main commit for as far back
// as the run history went, unnoticed. The same thing then happened to selfhost.yml: it caught migration
// 0209's SQLite-only AUTOINCREMENT (#10138) correctly on the FIRST push and stayed red for five consecutive
// runs while PRs kept merging. Two instances of one class is when the mechanism belongs in one place, so the
// bash moved into a script both workflows call -- and the arithmetic that decides "flake or outage" is the
// part worth pinning, because getting it wrong in either direction destroys the alert's usefulness.
//
// #10234 added the second axis: WHO started the run. A maintainer's hand retry fails just as deterministically
// as an outage does, so counting it escalated #10171 against a workflow that was never broken.

/** A run the release automation dispatched: `run-name:` stamped the marker into `display_title`. */
function automated(conclusion: string | null | undefined): WorkflowRunSummary {
  return { conclusion, event: "workflow_dispatch", displayTitle: `Publish Miner Package ${AUTOMATION_RUN_NAME_MARKER}` };
}

/** A run a human started with `gh workflow run`: identical on every other field, marker absent. */
function manual(conclusion: string | null | undefined): WorkflowRunSummary {
  return { conclusion, event: "workflow_dispatch", displayTitle: "Publish Miner Package" };
}

/** A push-triggered run (selfhost.yml). No dispatch ambiguity exists for it. */
function pushed(conclusion: string | null | undefined): WorkflowRunSummary {
  return { conclusion, event: "push", displayTitle: "self-host" };
}

describe("leadingNonSuccessCount (#10146)", () => {
  it("counts the unbroken run of non-successes at the HEAD of the history", () => {
    // Newest-first, as the GitHub API returns it.
    expect(leadingNonSuccessCount([automated("failure"), automated("failure"), automated("success"), automated("failure")])).toBe(2);
  });

  it("is zero when the most recent run succeeded, however bad the history behind it", () => {
    // A fixed workflow must stop alerting immediately -- an alert that persists after the fix gets muted,
    // and then the NEXT real outage is invisible.
    expect(leadingNonSuccessCount([automated("success"), ...Array(4).fill(automated("failure"))])).toBe(0);
  });

  it("REGRESSION: a window with NO success anywhere reports the whole window, not zero", () => {
    // The case the whole mechanism exists for, and the easiest to get backwards. `indexOf("success")`
    // returns -1 here; treating that as a count reports "no failures" for the single worst possible state --
    // a workflow that has never once succeeded in its recorded history. That is precisely the shape #9951
    // found (publish red on every commit as far back as the history went) and the shape selfhost.yml was in
    // for five runs.
    expect(leadingNonSuccessCount([automated("failure"), automated("failure"), automated("failure")])).toBe(3);
    expect(leadingNonSuccessCount(Array(10).fill(automated("failure")))).toBe(10);
  });

  it("treats cancelled, timed_out and null as non-successes — only an actual success breaks the streak", () => {
    // A cancelled or still-unrecorded run is not evidence the workflow works. Counting it as a success would
    // silently reset the streak and suppress the alert.
    expect(
      leadingNonSuccessCount([automated("cancelled"), automated("timed_out"), automated(null), automated(undefined), automated("failure"), automated("success")]),
    ).toBe(5);
  });

  it("is zero for an empty history, so a brand-new workflow never alerts", () => {
    expect(leadingNonSuccessCount([])).toBe(0);
  });

  it("does not treat a non-'success' string as success on a prefix match", () => {
    expect(leadingNonSuccessCount([automated("successful"), automated("success")])).toBe(1);
  });
});

describe("leadingNonSuccessCount ignores hand dispatches (#10234)", () => {
  it("REGRESSION #10171: six manual failures in a row do not escalate", () => {
    // The exact shape that filed a bogus outage issue: six consecutive publish-miner.yml failures, every one
    // a hand `gh workflow run` against main failing ETARGET on a contract version that was not published
    // yet. The workflow was never broken -- the next automated run succeeded with no code change.
    expect(leadingNonSuccessCount(Array(6).fill(manual("failure")))).toBe(0);
  });

  it("REGRESSION #10171: manual failures sitting ON TOP of an automated success still do not escalate", () => {
    // The full #10171 history, newest-first. Excluding (rather than merely "not resetting") is what makes
    // this 0: the automated run underneath them succeeded, so there is no outage at any depth.
    const history = [...Array(6).fill(manual("failure")), automated("success"), automated("success")];
    expect(leadingNonSuccessCount(history)).toBe(0);
  });

  it("still escalates a genuine automated streak that manual runs are interleaved with", () => {
    // The load-bearing half: filtering must not become a way for a real outage to hide. Three automated
    // failures reach the threshold whether or not a maintainer retried by hand in between.
    const history = [automated("failure"), manual("success"), automated("failure"), manual("failure"), automated("failure"), automated("success")];
    expect(leadingNonSuccessCount(history)).toBe(3);
  });

  it("a manual SUCCESS cannot mask a real automated outage", () => {
    // The dangerous direction of the same rule. If a hand retry succeeded, that says nothing about the
    // automated path -- counting it as a streak-breaker would suppress an outage that is still live.
    expect(leadingNonSuccessCount([manual("success"), automated("failure"), automated("failure"), automated("failure")])).toBe(3);
  });

  it("a history of nothing but manual runs reports 0, not its full length", () => {
    // The no-success-anywhere rule now applies to the FILTERED list. Reading `length` off the unfiltered
    // history here would escalate on a workflow the automation has never once run.
    expect(leadingNonSuccessCount([manual("failure"), manual("cancelled"), manual("failure")])).toBe(0);
  });

  it("leaves push-triggered workflows (selfhost.yml) counting exactly as before", () => {
    // selfhost.yml is the OTHER caller, and it is push-triggered. Narrowing to "stamped dispatches only"
    // would have silently switched its alert off -- the regression this change most easily causes.
    expect(leadingNonSuccessCount([pushed("failure"), pushed("failure"), pushed("failure")])).toBe(3);
    expect(leadingNonSuccessCount([pushed("success"), pushed("failure")])).toBe(0);
  });
});

describe("isAutomationDispatched (#10234)", () => {
  it("reads the marker out of display_title, which is the only field that carries it", () => {
    expect(isAutomationDispatched(automated("failure"))).toBe(true);
    expect(isAutomationDispatched(manual("failure"))).toBe(false);
  });

  it("treats every non-dispatch trigger as automation", () => {
    // push / schedule / workflow_run cannot be hand-triggered in the way this guards against.
    for (const event of ["push", "schedule", "workflow_run", "repository_dispatch"]) {
      expect(isAutomationDispatched({ conclusion: "failure", event, displayTitle: "anything" })).toBe(true);
    }
  });

  it("treats a missing display_title as manual rather than crashing", () => {
    // The API returns display_title for every run today, but an absent one must fail SAFE -- toward "do not
    // escalate" -- not throw inside the alerting path, which is deliberately never allowed to fail the caller.
    expect(isAutomationDispatched({ conclusion: "failure", event: "workflow_dispatch", displayTitle: null })).toBe(false);
    expect(isAutomationDispatched({ conclusion: "failure", event: "workflow_dispatch", displayTitle: undefined })).toBe(false);
  });

  it("a null event is treated as automation, since only a KNOWN workflow_dispatch is ambiguous", () => {
    expect(isAutomationDispatched({ conclusion: "failure", event: null, displayTitle: "x" })).toBe(true);
  });
});

describe("outageIssueTitle", () => {
  it("is derived from the workflow file, so the reuse lookup finds the issue this outage already filed", () => {
    // Filing once per outage instead of once per commit is the difference between an alert and noise, and it
    // depends entirely on this string being stable and identifying.
    expect(outageIssueTitle("selfhost.yml")).toBe("workflow outage: selfhost.yml has failed on consecutive runs");
    expect(outageIssueTitle("publish-mcp.yml")).not.toBe(outageIssueTitle("publish-miner.yml"));
  });
});
