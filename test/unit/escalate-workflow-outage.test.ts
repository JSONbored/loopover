import { describe, expect, it } from "vitest";

import { leadingNonSuccessCount, outageIssueTitle } from "../../scripts/escalate-workflow-outage";

// #10146: a post-merge workflow going red blocks nothing and pages no one.
//
// #9951 built this counting for the publish workflows after they failed on every main commit for as far back
// as the run history went, unnoticed. The same thing then happened to selfhost.yml: it caught migration
// 0209's SQLite-only AUTOINCREMENT (#10138) correctly on the FIRST push and stayed red for five consecutive
// runs while PRs kept merging. Two instances of one class is when the mechanism belongs in one place, so the
// bash moved into a script both workflows call -- and the arithmetic that decides "flake or outage" is the
// part worth pinning, because getting it wrong in either direction destroys the alert's usefulness.

describe("leadingNonSuccessCount (#10146)", () => {
  it("counts the unbroken run of non-successes at the HEAD of the history", () => {
    // Newest-first, as the GitHub API returns it.
    expect(leadingNonSuccessCount(["failure", "failure", "success", "failure"])).toBe(2);
  });

  it("is zero when the most recent run succeeded, however bad the history behind it", () => {
    // A fixed workflow must stop alerting immediately -- an alert that persists after the fix gets muted,
    // and then the NEXT real outage is invisible.
    expect(leadingNonSuccessCount(["success", "failure", "failure", "failure", "failure"])).toBe(0);
  });

  it("REGRESSION: a window with NO success anywhere reports the whole window, not zero", () => {
    // The case the whole mechanism exists for, and the easiest to get backwards. `indexOf("success")`
    // returns -1 here; treating that as a count reports "no failures" for the single worst possible state --
    // a workflow that has never once succeeded in its recorded history. That is precisely the shape #9951
    // found (publish red on every commit as far back as the history went) and the shape selfhost.yml was in
    // for five runs.
    expect(leadingNonSuccessCount(["failure", "failure", "failure"])).toBe(3);
    expect(leadingNonSuccessCount(Array(10).fill("failure"))).toBe(10);
  });

  it("treats cancelled, timed_out and null as non-successes — only an actual success breaks the streak", () => {
    // A cancelled or still-unrecorded run is not evidence the workflow works. Counting it as a success would
    // silently reset the streak and suppress the alert.
    expect(leadingNonSuccessCount(["cancelled", "timed_out", null, undefined, "failure", "success"])).toBe(5);
  });

  it("is zero for an empty history, so a brand-new workflow never alerts", () => {
    expect(leadingNonSuccessCount([])).toBe(0);
  });

  it("does not treat a non-'success' string as success on a prefix match", () => {
    expect(leadingNonSuccessCount(["successful", "success"])).toBe(1);
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
