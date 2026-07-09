import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REJECTION_REASONS } from "../../packages/gittensory-miner/lib/rejection-templates.js";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import { MINER_PR_OUTCOME_EVENT } from "../../packages/gittensory-miner/lib/pr-outcome.js";
import type { PullRequestSnapshot } from "../../packages/gittensory-miner/lib/ci-poller.d.ts";
import {
  MANAGE_POLL_OUTCOMES,
  buildDisengagedRejectionSnapshot,
  classifyRejectionReason,
  isClosedWithoutMerge,
  recordDisengagedPrOutcome,
} from "../../packages/gittensory-miner/lib/rejection-state-machine.js";

function closedPullRequest(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    headSha: "abc123",
    state: "closed",
    merged: false,
    mergedAt: null,
    closedAt: "2026-07-08T12:00:00.000Z",
    ...overrides,
  };
}

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-rejection-state-machine-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultEventLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner rejection state machine (#4278)", () => {
  it("exposes disengaged as a manage-poll outcome, not a run-state value", () => {
    expect(MANAGE_POLL_OUTCOMES).toEqual(["ready", "needs-work", "open", "disengaged"]);
    expect(Object.isFrozen(MANAGE_POLL_OUTCOMES)).toBe(true);
  });

  it("detects closed-without-merge pull requests", () => {
    expect(isClosedWithoutMerge({ ...closedPullRequest(), state: "open" })).toBe(false);
    expect(isClosedWithoutMerge({ ...closedPullRequest(), merged: true })).toBe(false);
    expect(isClosedWithoutMerge(closedPullRequest())).toBe(true);
    expect(isClosedWithoutMerge(null)).toBe(false);
  });

  it("classifies each rejection reason bucket and defaults to maintainer_close_no_reason", () => {
    expect(classifyRejectionReason({ supersededByDuplicate: true })).toBe("superseded_by_duplicate");
    expect(classifyRejectionReason({ gateVerdict: "block" })).toBe("gate_close");
    expect(classifyRejectionReason({ ciState: "failure" })).toBe("gate_close");
    expect(classifyRejectionReason({ gateVerdict: "advisory", ciState: "neutral" })).toBe(
      "maintainer_close_no_reason",
    );
    expect(classifyRejectionReason({})).toBe("maintainer_close_no_reason");
    for (const reason of REJECTION_REASONS) {
      expect(REJECTION_REASONS).toContain(reason);
    }
  });

  it("buildDisengagedRejectionSnapshot renders a courtesy note via renderRejectionMessage", () => {
    const snapshot = buildDisengagedRejectionSnapshot({
      repoFullName: "acme/widgets",
      prNumber: 12,
      pullRequest: closedPullRequest(),
      gateVerdict: "block",
      ciState: "failure",
    });
    expect(snapshot).toEqual({
      outcome: "disengaged",
      rejectionReason: "gate_close",
      courtesyNote: expect.stringContaining("#12"),
      closedAt: "2026-07-08T12:00:00.000Z",
    });
    expect(snapshot.courtesyNote).toContain("acme/widgets");
  });

  it("recordDisengagedPrOutcome persists classification and note to the local pr_outcome ledger", () => {
    const eventLedger = tempLedger();
    const result = recordDisengagedPrOutcome(
      {
        repoFullName: "acme/widgets",
        prNumber: 9,
        pullRequest: closedPullRequest(),
        supersededByDuplicate: true,
      },
      { eventLedger },
    );

    expect(result.outcome).toBe("disengaged");
    expect(result.rejectionReason).toBe("superseded_by_duplicate");
    expect(result.event.type).toBe(MINER_PR_OUTCOME_EVENT);
    expect(eventLedger.readEvents()).toEqual([
      expect.objectContaining({
        type: MINER_PR_OUTCOME_EVENT,
        repoFullName: "acme/widgets",
        payload: expect.objectContaining({
          prNumber: 9,
          decision: "closed",
          outcome: "disengaged",
          rejectionReason: "superseded_by_duplicate",
          courtesyNote: expect.stringContaining("#9"),
        }),
      }),
    ]);
  });

  it("rejects malformed disengagement input", () => {
    expect(() =>
      buildDisengagedRejectionSnapshot({
        repoFullName: "bad",
        prNumber: 1,
        pullRequest: closedPullRequest(),
      }),
    ).toThrow("invalid_repo_full_name");
    expect(() =>
      buildDisengagedRejectionSnapshot({
        repoFullName: "acme/widgets",
        prNumber: 0,
        pullRequest: closedPullRequest(),
      }),
    ).toThrow("invalid_pr_number");
  });
});
