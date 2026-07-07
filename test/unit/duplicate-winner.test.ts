import { describe, expect, it } from "vitest";
import { isDuplicateClusterWinner, isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "../../src/signals/duplicate-winner";
import { dupWinnerLinkedDuplicateCount, dupWinnerLinkedDuplicateWinnerNumber, linkedIssueDuplicatePullRequestsForGate } from "../../src/queue/processors";
import type { PullRequestRecord } from "../../src/types";
import { listOtherOpenPullRequests, listOtherOpenPullRequestsForAuthor, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("isDuplicateClusterWinner (#dup-winner)", () => {
  it("the lowest open sibling number wins", () => {
    expect(isDuplicateClusterWinner(12, [13, 14])).toBe(true);
  });

  it("a lower open sibling beats this PR (loser)", () => {
    expect(isDuplicateClusterWinner(14, [12, 13])).toBe(false);
  });

  it("an empty sibling list ⇒ winner (alone in/out of the cluster)", () => {
    expect(isDuplicateClusterWinner(7, [])).toBe(true);
  });

  it("a sibling list that contains self is still min-based (winner when self is lowest)", () => {
    expect(isDuplicateClusterWinner(12, [12, 13])).toBe(true);
  });

  it("a sibling list that contains self plus a lower sibling ⇒ loser", () => {
    expect(isDuplicateClusterWinner(13, [12, 13])).toBe(false);
  });

  it("cascade: once the lowest sibling closes (drops out of the open set), the next-lowest becomes the winner", () => {
    // Cluster {12, 13, 14}. PR 13 is a loser while 12 is still open.
    expect(isDuplicateClusterWinner(13, [12, 14])).toBe(false);
    // PR 12 closes (red CI) → it leaves the OPEN sibling set the caller passes. Re-eval of PR 13 now sees only
    // {14} as the open sibling → 13 is the new winner. No permanently-orphaned cluster.
    expect(isDuplicateClusterWinner(13, [14])).toBe(true);
  });
});

describe("isDuplicateClusterWinnerByClaim (#dup-winner claim election)", () => {
  const claim = (number: number, linkedIssueClaimedAt: string | null) => ({ number, linkedIssueClaimedAt });

  it("elects the earliest observed linked-issue claimant, not the lowest PR number", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(13, "2026-06-29T10:00:00.000Z"), [claim(12, "2026-06-29T10:05:00.000Z")])).toBe(true);
  });

  it("blocks an older PR that edits in the same issue after a newer PR already claimed it", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(12, "2026-06-29T10:05:00.000Z"), [claim(13, "2026-06-29T10:00:00.000Z")])).toBe(false);
  });

  it("falls back to PR number only for equal known claim timestamps", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(12, "2026-06-29T10:00:00.000Z"), [claim(13, "2026-06-29T10:00:00.000Z")])).toBe(true);
    expect(isDuplicateClusterWinnerByClaim(claim(13, "2026-06-29T10:00:00.000Z"), [claim(12, "2026-06-29T10:00:00.000Z")])).toBe(false);
  });

  it("fails closed when sparse legacy rows lack claim timestamps", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(12, null), [claim(13, "2026-06-29T10:00:00.000Z")])).toBe(false);
    expect(isDuplicateClusterWinnerByClaim(claim(13, "2026-06-29T10:00:00.000Z"), [claim(12, null)])).toBe(false);
  });

  it("fails closed when sparse legacy rows have invalid claim timestamps", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(12, "not-a-date"), [claim(13, "2026-06-29T10:00:00.000Z")])).toBe(false);
    expect(isDuplicateClusterWinnerByClaim(claim(13, "2026-06-29T10:00:00.000Z"), [claim(12, "not-a-date")])).toBe(false);
  });

  it("an empty sibling list ⇒ winner (alone in the cluster)", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(12, "2026-06-29T10:00:00.000Z"), [])).toBe(true);
  });

  it("fails closed when the PR itself has a missing claim timestamp", () => {
    expect(isDuplicateClusterWinnerByClaim({ number: 12, linkedIssueClaimedAt: undefined }, [claim(13, "2026-06-29T10:00:00.000Z")])).toBe(false);
  });

  it("wins when every open sibling claimed later", () => {
    expect(
      isDuplicateClusterWinnerByClaim(claim(12, "2026-06-29T10:00:00.000Z"), [
        claim(13, "2026-06-29T10:05:00.000Z"),
        claim(14, "2026-06-29T10:10:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("wins an equal-claim tie when siblings have higher PR numbers", () => {
    expect(
      isDuplicateClusterWinnerByClaim(claim(12, "2026-06-29T10:00:00.000Z"), [
        claim(13, "2026-06-29T10:00:00.000Z"),
        claim(14, "2026-06-29T10:00:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("loses an equal-claim tie when any sibling has a lower PR number", () => {
    expect(isDuplicateClusterWinnerByClaim(claim(14, "2026-06-29T10:00:00.000Z"), [claim(12, "2026-06-29T10:00:00.000Z")])).toBe(false);
  });
});

describe("isDuplicateClusterWinnerByClaim createdAt precedence (#dup-winner true-creation-time)", () => {
  const member = (number: number, createdAt: string | null, linkedIssueClaimedAt: string | null) => ({ number, createdAt, linkedIssueClaimedAt });

  it("REGRESSION: elects the PR that GitHub says opened first, even when gittensory OBSERVED (claimed) the later-opened sibling first", () => {
    // PR 13 truly opened first (10:00) but gittensory's stalled sweep only got around to syncing/claiming it at
    // 11:00. PR 14 opened later (10:05) but was claimed immediately (10:06) because the sweep happened to reach
    // it first. Under the old claim-time-only rule, 14 would wrongly win and 13 (the real first mover) would be
    // closed as the "duplicate." createdAt must override that.
    expect(
      isDuplicateClusterWinnerByClaim(
        member(13, "2026-06-29T10:00:00.000Z", "2026-06-29T11:00:00.000Z"),
        [member(14, "2026-06-29T10:05:00.000Z", "2026-06-29T10:06:00.000Z")],
      ),
    ).toBe(true);
    // And symmetrically, the later-created PR no longer wins just because it was claimed first.
    expect(
      isDuplicateClusterWinnerByClaim(
        member(14, "2026-06-29T10:05:00.000Z", "2026-06-29T10:06:00.000Z"),
        [member(13, "2026-06-29T10:00:00.000Z", "2026-06-29T11:00:00.000Z")],
      ),
    ).toBe(false);
  });

  it("falls back to claim-time comparison when only ONE side has a valid createdAt (mixed legacy/modern cluster)", () => {
    // pr has createdAt; sibling (a legacy row) does not — never mix clocks across the two sides of one
    // comparison. pr's claim (10:00) is earlier than sibling's claim (10:05) ⇒ pr still wins via the fallback.
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 12, createdAt: "2026-06-29T09:00:00.000Z", linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z" },
        [{ number: 13, createdAt: null, linkedIssueClaimedAt: "2026-06-29T10:05:00.000Z" }],
      ),
    ).toBe(true);
    // Same mixed case, but pr's own claim is later than the sibling's ⇒ pr loses via the fallback.
    expect(
      isDuplicateClusterWinnerByClaim(
        { number: 12, createdAt: "2026-06-29T09:00:00.000Z", linkedIssueClaimedAt: "2026-06-29T10:05:00.000Z" },
        [{ number: 13, createdAt: null, linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z" }],
      ),
    ).toBe(false);
  });

  it("falls back to claim-time comparison when a createdAt value is present but unparseable", () => {
    expect(
      isDuplicateClusterWinnerByClaim(
        member(12, "not-a-date", "2026-06-29T10:00:00.000Z"),
        [member(13, "2026-06-29T09:00:00.000Z", "2026-06-29T10:05:00.000Z")],
      ),
    ).toBe(true);
  });

  it("tie-breaks equal createdAt values by PR number, mirroring the claim-time tie-break", () => {
    expect(isDuplicateClusterWinnerByClaim(member(12, "2026-06-29T10:00:00.000Z", null), [member(13, "2026-06-29T10:00:00.000Z", null)])).toBe(true);
    expect(isDuplicateClusterWinnerByClaim(member(13, "2026-06-29T10:00:00.000Z", null), [member(12, "2026-06-29T10:00:00.000Z", null)])).toBe(false);
  });

  it("createdAt-based cases are unaffected by (and do not require) a claim timestamp at all", () => {
    expect(isDuplicateClusterWinnerByClaim(member(12, "2026-06-29T10:00:00.000Z", null), [member(13, "2026-06-29T10:05:00.000Z", null)])).toBe(true);
  });
});

describe("resolveDuplicateClusterWinnerNumber (#dup-winner-credit)", () => {
  it("returns this PR's own number when it is the winner", () => {
    expect(resolveDuplicateClusterWinnerNumber({ number: 12, createdAt: "2026-06-29T10:00:00.000Z" }, [{ number: 13, createdAt: "2026-06-29T10:05:00.000Z" }])).toBe(12);
  });

  it("returns the actual winning sibling's number when this PR is a loser, even with multiple siblings", () => {
    expect(
      resolveDuplicateClusterWinnerNumber({ number: 14, createdAt: "2026-06-29T10:10:00.000Z" }, [
        { number: 13, createdAt: "2026-06-29T10:00:00.000Z" },
        { number: 15, createdAt: "2026-06-29T10:05:00.000Z" },
      ]),
    ).toBe(13);
  });

  it("an empty sibling list ⇒ this PR wins by default", () => {
    expect(resolveDuplicateClusterWinnerNumber({ number: 12 }, [])).toBe(12);
  });

  it("returns null when the election is too ambiguous to name a specific winner (fully sparse legacy cluster)", () => {
    expect(resolveDuplicateClusterWinnerNumber({ number: 12, createdAt: null, linkedIssueClaimedAt: null }, [{ number: 13, createdAt: null, linkedIssueClaimedAt: null }])).toBeNull();
  });
});

describe("dupWinnerLinkedDuplicateCount (#dup-winner close-reason seam)", () => {
  it("winner + flag ON ⇒ 0 (close reason omits the duplicate cause)", () => {
    expect(
      dupWinnerLinkedDuplicateCount(
        [
          { number: 13, linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" },
          { number: 14, linkedIssueClaimedAt: "2026-06-29T10:02:00.000Z" },
        ],
        12,
        "2026-06-29T10:00:00.000Z",
        true,
      ),
    ).toBe(0);
  });

  it("loser + flag ON ⇒ real sibling count (close reason includes the duplicate cause)", () => {
    expect(
      dupWinnerLinkedDuplicateCount(
        [
          { number: 12, linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z" },
          { number: 13, linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" },
        ],
        14,
        "2026-06-29T10:02:00.000Z",
        true,
      ),
    ).toBe(2);
  });

  it("flag OFF ⇒ real sibling count even for a would-be winner (byte-identical)", () => {
    expect(
      dupWinnerLinkedDuplicateCount(
        [
          { number: 13, linkedIssueClaimedAt: "2026-06-29T10:01:00.000Z" },
          { number: 14, linkedIssueClaimedAt: "2026-06-29T10:02:00.000Z" },
        ],
        12,
        "2026-06-29T10:00:00.000Z",
        false,
      ),
    ).toBe(2);
  });

  it("no siblings ⇒ 0 regardless of the flag", () => {
    expect(dupWinnerLinkedDuplicateCount([], 12, "2026-06-29T10:00:00.000Z", true)).toBe(0);
    expect(dupWinnerLinkedDuplicateCount([], 12, "2026-06-29T10:00:00.000Z", false)).toBe(0);
  });

  it("REGRESSION (#dup-winner true-creation-time): createdAt overrides a claim-time-only verdict when passed through", () => {
    // By claim time alone this PR (12) would lose to sibling 13 (claimed earlier, 10:00 vs 10:05). But 12's true
    // createdAt (09:00) precedes 13's (09:30), so passing createdAt flips the verdict to a win (count 0).
    expect(
      dupWinnerLinkedDuplicateCount(
        [{ number: 13, linkedIssueClaimedAt: "2026-06-29T10:00:00.000Z", createdAt: "2026-06-29T09:30:00.000Z" }],
        12,
        "2026-06-29T10:05:00.000Z",
        true,
        "2026-06-29T09:00:00.000Z",
      ),
    ).toBe(0);
  });
});

describe("dupWinnerLinkedDuplicateWinnerNumber (#dup-winner-credit close-reason naming seam)", () => {
  it("flag OFF ⇒ null regardless of who would win (generic wording, byte-identical to before this existed)", () => {
    expect(dupWinnerLinkedDuplicateWinnerNumber([{ number: 13, createdAt: "2026-06-29T10:05:00.000Z" }], 12, undefined, false, "2026-06-29T10:00:00.000Z")).toBeNull();
  });

  it("winner + flag ON ⇒ null (nothing to name — its own close reason omits the duplicate cause entirely)", () => {
    expect(dupWinnerLinkedDuplicateWinnerNumber([{ number: 13, createdAt: "2026-06-29T10:05:00.000Z" }], 12, undefined, true, "2026-06-29T10:00:00.000Z")).toBeNull();
  });

  it("loser + flag ON ⇒ the actual winning sibling's number", () => {
    expect(dupWinnerLinkedDuplicateWinnerNumber([{ number: 12, createdAt: "2026-06-29T10:00:00.000Z" }], 14, undefined, true, "2026-06-29T10:10:00.000Z")).toBe(12);
  });

  it("loser + flag ON, but the election is too ambiguous ⇒ null (falls back to generic wording)", () => {
    expect(dupWinnerLinkedDuplicateWinnerNumber([{ number: 13, createdAt: null, linkedIssueClaimedAt: null }], 12, null, true, null)).toBeNull();
  });
});

describe("linkedIssueDuplicatePullRequestsForGate (#dup-winner open-sibling source)", () => {
  const pr = (number: number, state: string, linkedIssues: number[]): PullRequestRecord => ({
    repoFullName: "owner/repo",
    number,
    title: `PR ${number}`,
    state,
    labels: [],
    linkedIssues,
  });

  it("the PR links no issue ⇒ no cluster siblings", () => {
    expect(linkedIssueDuplicatePullRequestsForGate(pr(9, "open", []), [pr(5, "open", [1])])).toEqual([]);
  });

  it("includes an OPEN sibling that overlaps the linked-issue set, sorted + de-duplicated", () => {
    const subject = pr(9, "open", [1, 2]);
    const others = [pr(7, "open", [2]), pr(5, "open", [1]), pr(5, "open", [1])];
    expect(linkedIssueDuplicatePullRequestsForGate(subject, others)).toEqual([5, 7]);
  });

  it("excludes a sibling that does NOT overlap the linked-issue set (the false ternary arm)", () => {
    const subject = pr(9, "open", [1]);
    expect(linkedIssueDuplicatePullRequestsForGate(subject, [pr(5, "open", [2])])).toEqual([]);
  });

  it("excludes self and any non-open sibling", () => {
    const subject = pr(9, "open", [1]);
    const others = [pr(9, "open", [1]), pr(5, "closed", [1])];
    expect(linkedIssueDuplicatePullRequestsForGate(subject, others)).toEqual([]);
  });
});

describe("listOtherOpenPullRequests ordering (#audit-3.9)", () => {
  it("orders by ascending number so the lowest open sibling survives the 100-row cap", async () => {
    const env = createTestEnv();
    // Insert the LOWEST number (#1) LAST so an unordered insertion-order LIMIT(100) would drop it (and thus
    // mis-elect the duplicate-winner, which is the minimum open number).
    const numbers = [...Array.from({ length: 101 }, (_, i) => i + 2), 1]; // 2..102, then 1
    for (const n of numbers) {
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: n, title: `PR ${n}`, state: "open", user: { login: "c" }, head: { sha: `s${n}` }, labels: [], body: "x" });
    }
    const siblings = await listOtherOpenPullRequests(env, "owner/repo", 200); // siblings of a non-existent #200
    const siblingNumbers = siblings.map((p) => p.number);
    expect(siblings).toHaveLength(100); // capped
    expect(Math.min(...siblingNumbers)).toBe(1); // the true winner #1 is retained despite being inserted last
    expect(siblingNumbers).not.toContain(102); // the lowest 100 (1..100) are returned, not the first-inserted 100
  });

  it("caps author-scoped contributor-cap siblings at the lowest 100 PRs (resource budget regression)", async () => {
    const env = createTestEnv();
    // Insert #1 last so the LIMIT must be applied after numeric ordering, not insertion order. Rows from other
    // authors and the subject PR are excluded before the cap, so the fixed live-check budget is all same-author
    // siblings and cannot be inflated by unrelated open PRs.
    const sameAuthorNumbers = [...Array.from({ length: 101 }, (_, i) => i + 2), 1]; // 2..102, then 1
    for (const n of sameAuthorNumbers) {
      await upsertPullRequestFromGitHub(env, "owner/repo", { number: n, title: `Author PR ${n}`, state: "open", user: { login: "Prolific" }, head: { sha: `s${n}` }, labels: [], body: "x" });
    }
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 200, title: "Subject PR", state: "open", user: { login: "prolific" }, head: { sha: "subject" }, labels: [], body: "x" });
    await upsertPullRequestFromGitHub(env, "owner/repo", { number: 201, title: "Other author PR", state: "open", user: { login: "someone-else" }, head: { sha: "other" }, labels: [], body: "x" });

    const siblings = await listOtherOpenPullRequestsForAuthor(env, "owner/repo", 200, "prolific");
    const siblingNumbers = siblings.map((p) => p.number);
    expect(siblings).toHaveLength(100);
    expect(siblingNumbers[0]).toBe(1);
    expect(siblingNumbers).not.toContain(102);
    expect(siblingNumbers).not.toContain(200);
    expect(siblingNumbers).not.toContain(201);
  });
});

describe("upsertPullRequestFromGitHub createdAt threading (#dup-winner true-creation-time)", () => {
  it("populates createdAt from GitHub's true pull_request.created_at on the IMMEDIATE upsert return, not just on a later DB round-trip", async () => {
    const env = createTestEnv();
    const record = await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 42,
      title: "PR 42",
      state: "open",
      user: { login: "c" },
      head: { sha: "s42" },
      labels: [],
      body: "x",
      created_at: "2026-06-29T09:00:00.000Z",
    });
    expect(record.createdAt).toBe("2026-06-29T09:00:00.000Z");

    const rehydrated = await listOtherOpenPullRequests(env, "owner/repo", 999);
    expect(rehydrated).toHaveLength(1);
    expect(rehydrated[0]?.createdAt).toBe("2026-06-29T09:00:00.000Z");
  });

  it("createdAt is absent (undefined) when the GitHub payload doesn't carry one (the false ternary/nullish arm)", async () => {
    const env = createTestEnv();
    const record = await upsertPullRequestFromGitHub(env, "owner/repo", {
      number: 43,
      title: "PR 43",
      state: "open",
      user: { login: "c" },
      head: { sha: "s43" },
      labels: [],
      body: "x",
    });
    expect(record.createdAt).toBeUndefined();
  });
});
