import { describe, expect, it } from "vitest";
import {
  SUPERSEDED_CLOSE_WINDOW_MS,
  resolveSupersession,
  supersededSearchWindow,
  type LinkedIssueClosure,
  type MergedRivalPullRequest,
} from "../../src/review/linked-issue-superseded";

// The real collision this exists for (#10168), timestamps as recorded on the Orb:
//   PR 8886 created 09:22:36 citing issue 8829 -- issue open at that moment
//   PR 8881 (same issue) merged 09:30:24
//   issue 8829 closed  09:30:25, one second later, as a side effect of that merge
const PR_CREATED = "2026-07-31T09:22:36Z";
const RIVAL_MERGED = "2026-07-31T09:30:24Z";
const ISSUE_CLOSED = "2026-07-31T09:30:25Z";

function closure(overrides: Partial<LinkedIssueClosure> = {}): LinkedIssueClosure {
  return { issueNumber: 8829, state: "closed", closedAt: ISSUE_CLOSED, ...overrides };
}

function rival(overrides: Partial<MergedRivalPullRequest> = {}): MergedRivalPullRequest {
  return { number: 8881, mergedAt: RIVAL_MERGED, linkedIssues: [8829], ...overrides };
}

function resolve(overrides: Partial<Parameters<typeof resolveSupersession>[0]> = {}) {
  return resolveSupersession({
    prNumber: 8886,
    prCreatedAt: PR_CREATED,
    closures: [closure()],
    mergedRivals: [rival()],
    ...overrides,
  });
}

describe("resolveSupersession", () => {
  it("names the merged rival for the metagraphed#8886 collision", () => {
    expect(resolve()).toEqual({
      issueNumber: 8829,
      rivalPullNumber: 8881,
      rivalMergedAt: RIVAL_MERGED,
      issueClosedAt: ISSUE_CLOSED,
    });
  });

  describe("fact 1 — the issue must have been open when the PR was created", () => {
    it("declines when the issue closed BEFORE the PR opened (the gaming case the guardrail exists for)", () => {
      // The contributor cited an already-dead issue: `missing_linked_issue` must keep its current meaning.
      expect(resolve({ closures: [closure({ closedAt: "2026-07-31T09:00:00Z" })] })).toBeNull();
    });

    it("declines on the exact tie — a close at the creation instant proves nothing was taken from this PR", () => {
      // The rival is placed so it WOULD qualify if the tie were admitted, so this pins `<=` and not `<`.
      expect(
        resolve({
          closures: [closure({ closedAt: PR_CREATED })],
          mergedRivals: [rival({ mergedAt: PR_CREATED })],
        }),
      ).toBeNull();
    });

    it("declines while the issue is still open", () => {
      expect(resolve({ closures: [closure({ state: "open", closedAt: null })] })).toBeNull();
    });

    it("declines on a still-open issue even if a stale closedAt is present", () => {
      // Without the explicit state check a reopened issue carrying an old closed_at would read as superseded,
      // and this PR would be closed over an issue that is once again open.
      expect(resolve({ closures: [closure({ state: "open" })] })).toBeNull();
    });

    it("declines when a non-open issue carries no closedAt", () => {
      expect(resolve({ closures: [closure({ closedAt: null })] })).toBeNull();
    });

    it("declines when closedAt is unparseable", () => {
      expect(resolve({ closures: [closure({ closedAt: "not-a-date" })] })).toBeNull();
    });

    it("declines when the PR has no synced createdAt", () => {
      expect(resolve({ prCreatedAt: null })).toBeNull();
      expect(resolve({ prCreatedAt: undefined })).toBeNull();
      expect(resolve({ prCreatedAt: "" })).toBeNull();
    });

    it("declines when the PR's createdAt is unparseable", () => {
      expect(resolve({ prCreatedAt: "whenever" })).toBeNull();
    });
  });

  describe("fact 2 — a merged rival must be the plausible cause", () => {
    it("declines when no rival cites the issue", () => {
      expect(resolve({ mergedRivals: [rival({ linkedIssues: [9999] })] })).toBeNull();
    });

    it("declines when there are no rivals at all", () => {
      expect(resolve({ mergedRivals: [] })).toBeNull();
    });

    it("declines when the rival closed without merging", () => {
      expect(resolve({ mergedRivals: [rival({ mergedAt: null })] })).toBeNull();
    });

    it("declines when the rival's mergedAt is unparseable", () => {
      expect(resolve({ mergedRivals: [rival({ mergedAt: "sometime" })] })).toBeNull();
    });

    it("never treats the PR as its own rival", () => {
      expect(resolve({ mergedRivals: [rival({ number: 8886 })] })).toBeNull();
    });

    it("declines when the rival merged before this PR was even opened", () => {
      expect(resolve({ mergedRivals: [rival({ mergedAt: "2026-07-31T09:00:00Z" })] })).toBeNull();
    });

    it("accepts a rival merged at the window's outer edge", () => {
      const edge = new Date(Date.parse(ISSUE_CLOSED) + SUPERSEDED_CLOSE_WINDOW_MS).toISOString();
      expect(resolve({ mergedRivals: [rival({ mergedAt: edge })] })?.rivalPullNumber).toBe(8881);
    });

    it("declines a rival merged past the window — some other actor is the likelier cause", () => {
      const past = new Date(Date.parse(ISSUE_CLOSED) + SUPERSEDED_CLOSE_WINDOW_MS + 1).toISOString();
      expect(resolve({ mergedRivals: [rival({ mergedAt: past })] })).toBeNull();
    });
  });

  describe("determinism — the result closes a PR, so it must not depend on row order", () => {
    it("picks the EARLIEST qualifying merge regardless of the order rivals arrive in", () => {
      const early = rival({ number: 8881, mergedAt: "2026-07-31T09:29:00Z" });
      const late = rival({ number: 8899, mergedAt: RIVAL_MERGED });
      expect(resolve({ mergedRivals: [early, late] })?.rivalPullNumber).toBe(8881);
      expect(resolve({ mergedRivals: [late, early] })?.rivalPullNumber).toBe(8881);
    });

    it("breaks a same-instant merge tie on the lower PR number, not on row order", () => {
      const first = rival({ number: 8881, mergedAt: RIVAL_MERGED });
      const second = rival({ number: 8899, mergedAt: RIVAL_MERGED });
      expect(resolve({ mergedRivals: [first, second] })?.rivalPullNumber).toBe(8881);
      expect(resolve({ mergedRivals: [second, first] })?.rivalPullNumber).toBe(8881);
    });

    it("resolves closures in ascending issue number regardless of input order", () => {
      const low = closure({ issueNumber: 100 });
      const high = closure({ issueNumber: 900 });
      const rivals = [rival({ number: 11, linkedIssues: [100] }), rival({ number: 22, linkedIssues: [900] })];
      expect(resolve({ closures: [high, low], mergedRivals: rivals })?.issueNumber).toBe(100);
      expect(resolve({ closures: [low, high], mergedRivals: rivals })?.issueNumber).toBe(100);
    });

    it("falls through a non-qualifying earlier issue to a qualifying later one", () => {
      // Issue 100 is still open, so it cannot supersede; 900 did close behind a merged rival.
      const stillOpen = closure({ issueNumber: 100, state: "open", closedAt: null });
      const superseded = closure({ issueNumber: 900 });
      expect(
        resolve({
          closures: [stillOpen, superseded],
          mergedRivals: [rival({ number: 22, linkedIssues: [900] })],
        })?.issueNumber,
      ).toBe(900);
    });
  });
});

describe("supersededSearchWindow", () => {
  it("spans this PR's creation to the latest close plus the tolerance", () => {
    expect(supersededSearchWindow(PR_CREATED, [closure()])).toEqual({
      sinceIso: PR_CREATED,
      untilIso: new Date(Date.parse(ISSUE_CLOSED) + SUPERSEDED_CLOSE_WINDOW_MS).toISOString(),
    });
  });

  it("anchors the end on the LATEST close when several issues are linked", () => {
    const later = "2026-07-31T10:00:00Z";
    const window = supersededSearchWindow(PR_CREATED, [closure(), closure({ issueNumber: 9000, closedAt: later })]);
    expect(window?.untilIso).toBe(new Date(Date.parse(later) + SUPERSEDED_CLOSE_WINDOW_MS).toISOString());
  });

  it("declines without a synced createdAt — the 'issue outlived this PR' half cannot be established", () => {
    for (const value of [null, undefined, "", "whenever"]) {
      expect(supersededSearchWindow(value, [closure()]), String(value)).toBeNull();
    }
  });

  it("declines when no linked issue was conclusively read as closed", () => {
    expect(supersededSearchWindow(PR_CREATED, [])).toBeNull();
    expect(supersededSearchWindow(PR_CREATED, [closure({ closedAt: null })])).toBeNull();
    expect(supersededSearchWindow(PR_CREATED, [closure({ closedAt: "not-a-date" })])).toBeNull();
  });
});
