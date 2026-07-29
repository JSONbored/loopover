// Author-based eligibility for the priority label (#9737): every branch, both sides of every fallback.
import { describe, expect, it } from "vitest";
import {
  MAINTAINER_OF_RECORD_PERMISSIONS,
  PRIORITY_LABEL_AUTHOR_RULE_ID,
  evaluatePriorityLabelEligibility,
  isMaintainerOfRecord,
  PRIORITY_LABEL_COMMENT_MARKER,
  resolvePriorityLabelEnforcement,
} from "../../src/review/priority-label-eligibility";

const BASE = {
  priorityLabel: "gittensor:priority",
  labels: ["gittensor:priority"],
  authorLogin: "contributor",
  authorPermission: "read",
  isPullRequest: false,
  policyUrl: "https://loopover.ai/docs/label-policy",
};

describe("priority label author eligibility (#9737)", () => {
  it("strips the label from a contributor-authored issue, and says why", () => {
    const verdict = evaluatePriorityLabelEligibility(BASE);
    // The union narrows on `strip`, so a caller cannot read `comment` off a keep verdict by accident.
    if (!verdict.strip) throw new Error("expected the label to be stripped");
    expect(verdict.reason).toContain(PRIORITY_LABEL_AUTHOR_RULE_ID);
    expect(verdict.reason).toContain("@contributor");
    // The comment must read as policy, not as a verdict on the person or the issue.
    expect(verdict.comment).toContain(BASE.policyUrl);
    expect(verdict.comment).toContain("still welcome");
    expect(verdict.comment).not.toMatch(/violation|rejected|invalid|spam/i);
  });

  it("leaves a maintainer-authored issue alone, for every maintainer permission", () => {
    for (const permission of MAINTAINER_OF_RECORD_PERMISSIONS) {
      expect(evaluatePriorityLabelEligibility({ ...BASE, authorPermission: permission }).strip, permission).toBe(false);
    }
  });

  it("treats WRITE as not-a-maintainer, so handing out push access does not widen the rule", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorPermission: "write" }).strip).toBe(true);
    expect(isMaintainerOfRecord("write")).toBe(false);
    expect(isMaintainerOfRecord("triage")).toBe(false);
  });

  it("matches permissions case-insensitively", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorPermission: "ADMIN" }).strip).toBe(false);
    expect(isMaintainerOfRecord("Maintain")).toBe(true);
  });

  it("never touches a PULL REQUEST — the same label is the PR type label ORB applies itself", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, isPullRequest: true }).strip).toBe(false);
  });

  it("does nothing when the label is not actually on the issue", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, labels: ["gittensor:bug"] }).strip).toBe(false);
    expect(evaluatePriorityLabelEligibility({ ...BASE, labels: [] }).strip).toBe(false);
  });

  it("matches the label case-insensitively and ignores surrounding whitespace", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, labels: [" Gittensor:Priority "] }).strip).toBe(true);
  });

  it("FAILS OPEN when the permission could not be read", () => {
    // Stripping the highest-value label off a maintainer's own issue because WE could not read a permission
    // is worse than leaving one wrongly applied; the sweep re-judges it once the read succeeds.
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorPermission: null }).strip).toBe(false);
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorPermission: undefined }).strip).toBe(false);
  });

  it("FAILS OPEN when the author is unknown", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorLogin: null }).strip).toBe(false);
    expect(evaluatePriorityLabelEligibility({ ...BASE, authorLogin: "   " }).strip).toBe(false);
  });

  it("FAILS OPEN when the repo configures no priority label", () => {
    expect(evaluatePriorityLabelEligibility({ ...BASE, priorityLabel: "" }).strip).toBe(false);
  });

  it("exposes a stable rule id, because the ledger records it", () => {
    expect(PRIORITY_LABEL_AUTHOR_RULE_ID).toBe("priority-label-author-eligibility");
  });
});

describe("resolvePriorityLabelEnforcement (#9737)", () => {
  it("marks the comment so a re-label updates it instead of posting a second one", () => {
    const { verdict, commentBody } = resolvePriorityLabelEnforcement(BASE);
    expect(verdict.strip).toBe(true);
    expect(commentBody).toContain(PRIORITY_LABEL_COMMENT_MARKER);
    expect(commentBody).toContain(BASE.policyUrl);
  });

  it("says nothing at all when the label is legitimate", () => {
    const { verdict, commentBody } = resolvePriorityLabelEnforcement({ ...BASE, authorPermission: "admin" });
    expect(verdict.strip).toBe(false);
    expect(commentBody).toBeNull();
  });
});
