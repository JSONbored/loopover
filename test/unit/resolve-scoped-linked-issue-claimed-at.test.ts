import { describe, expect, it } from "vitest";
import { resolveScopedLinkedIssueClaimedAt } from "../../src/queue/duplicate-detection";
import { recordLinkedIssueClaims } from "../../src/db/repositories";
import type { PullRequestRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

// #9160: resolveScopedLinkedIssueClaimedAt scopes a PR's claim time to only the issue(s) actually contested
// with an open sibling, reading the durable per-(PR, issue) ledger (db/repositories.ts's linked_issue_claims)
// instead of the PR's blended linkedIssueClaimedAt column -- see that function's own doc comment for the
// backdating attack this closes (an attacker's unrelated, already-linked issue "vouching" a stale claim time
// for a newly-added, contested one).
function makePr(number: number, linkedIssues: number[], linkedIssueClaimedAt: string | null): Pick<PullRequestRecord, "number" | "linkedIssues" | "linkedIssueClaimedAt"> {
  return { number, linkedIssues, linkedIssueClaimedAt };
}

describe("resolveScopedLinkedIssueClaimedAt (#9160)", () => {
  it("returns pr.linkedIssueClaimedAt unchanged when no sibling actually overlaps (no contested issue)", async () => {
    const env = createTestEnv();
    const pr = makePr(21, [7], "2026-06-29T10:00:00.000Z");
    const siblings = [makePr(22, [99], "2026-07-01T00:00:00.000Z")];
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, siblings)).resolves.toBe("2026-06-29T10:00:00.000Z");
  });

  it("returns pr.linkedIssueClaimedAt unchanged when openSiblings is empty", async () => {
    const env = createTestEnv();
    const pr = makePr(21, [7], "2026-06-29T10:00:00.000Z");
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, [])).resolves.toBe("2026-06-29T10:00:00.000Z");
  });

  it("REGRESSION (#9160): reads the per-issue ledger's own claim time for a CONTESTED issue, ignoring the blended column's backdated value", async () => {
    const env = createTestEnv();
    // Ledger: issue #1 claimed day-1 (long-lived placeholder), issue #7 claimed later (the backdating target).
    await recordLinkedIssueClaims(env, "owner/repo", 21, [1], "2026-06-29T10:00:00.000Z");
    await recordLinkedIssueClaims(env, "owner/repo", 21, [7], "2026-07-20T09:00:00.000Z");
    // pr's blended column still reads day-1 (the #linked-issue-claim-overlap-preserve behavior) even though
    // #7 was only just added -- resolveScopedLinkedIssueClaimedAt must NOT trust this for the contested issue.
    const pr = makePr(21, [1, 7], "2026-06-29T10:00:00.000Z");
    const victimSibling = [makePr(22, [7], "2026-07-01T00:00:00.000Z")];
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, victimSibling)).resolves.toBe("2026-07-20T09:00:00.000Z");
  });

  it("fails closed to null when the contested issue has no ledger row yet (never falls back to the blended value)", async () => {
    const env = createTestEnv();
    const pr = makePr(21, [7], "2026-06-29T10:00:00.000Z"); // blended column set, but no ledger row for #7
    const siblings = [makePr(22, [7], "2026-07-01T00:00:00.000Z")];
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, siblings)).resolves.toBeNull();
  });

  it("scopes to only the CONTESTED issue among several linked issues, ignoring an uncontested one entirely", async () => {
    const env = createTestEnv();
    await recordLinkedIssueClaims(env, "owner/repo", 21, [1], "2026-01-01T00:00:00.000Z");
    await recordLinkedIssueClaims(env, "owner/repo", 21, [7], "2026-07-20T09:00:00.000Z");
    const pr = makePr(21, [1, 7], "2026-01-01T00:00:00.000Z");
    // Sibling only overlaps on #7, not #1 -- the (much earlier) #1 ledger row must not leak into the result.
    const siblings = [makePr(22, [7], "2026-07-01T00:00:00.000Z")];
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, siblings)).resolves.toBe("2026-07-20T09:00:00.000Z");
  });

  it("takes the EARLIEST ledger row when multiple linked issues are each contested by (possibly different) siblings", async () => {
    const env = createTestEnv();
    await recordLinkedIssueClaims(env, "owner/repo", 21, [1], "2026-05-01T00:00:00.000Z");
    await recordLinkedIssueClaims(env, "owner/repo", 21, [7], "2026-07-20T09:00:00.000Z");
    const pr = makePr(21, [1, 7], "2026-05-01T00:00:00.000Z");
    const siblings = [makePr(22, [1], "2026-06-01T00:00:00.000Z"), makePr(23, [7], "2026-07-01T00:00:00.000Z")];
    await expect(resolveScopedLinkedIssueClaimedAt(env, "owner/repo", pr, siblings)).resolves.toBe("2026-05-01T00:00:00.000Z");
  });
});
