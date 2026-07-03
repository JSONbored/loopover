import { describe, expect, it } from "vitest";
import {
  DEFAULT_FOREGROUND_LANE_RATIO,
  backlogRepoCandidatesFromJobKeys,
  foregroundLaneForJob,
  nextForegroundLane,
  pickBacklogRepo,
} from "../../src/selfhost/queue-fairness";

function webhookPayload(eventName: string, action?: string): string {
  return JSON.stringify({ type: "github-webhook", eventName, payload: action === undefined ? {} : { action } });
}

function regatePrPayload(deliveryId?: string): string {
  return JSON.stringify({ type: "agent-regate-pr", ...(deliveryId === undefined ? {} : { deliveryId }) });
}

describe("foregroundLaneForJob (#selfhost-backlog-convergence)", () => {
  it("classifies a fresh PR intake event for each recognized action", () => {
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      expect(foregroundLaneForJob("github-webhook", webhookPayload("pull_request", action))).toBe("fresh");
    }
  });

  it("does not classify a pull_request action outside the fresh-intake set", () => {
    expect(foregroundLaneForJob("github-webhook", webhookPayload("pull_request", "closed"))).toBeNull();
    expect(foregroundLaneForJob("github-webhook", webhookPayload("pull_request", "edited"))).toBeNull();
  });

  it("does not classify a non-pull_request webhook event", () => {
    expect(foregroundLaneForJob("github-webhook", webhookPayload("check_suite", "completed"))).toBeNull();
  });

  it("treats a missing/non-string action as unclassified rather than throwing", () => {
    expect(foregroundLaneForJob("github-webhook", JSON.stringify({ type: "github-webhook", eventName: "pull_request", payload: null }))).toBeNull();
    expect(foregroundLaneForJob("github-webhook", JSON.stringify({ type: "github-webhook", eventName: "pull_request" }))).toBeNull();
  });

  it("fails closed (null) on a malformed webhook payload", () => {
    expect(foregroundLaneForJob("github-webhook", "not-json")).toBeNull();
  });

  it("treats a missing/non-string eventName as unclassified rather than throwing", () => {
    expect(foregroundLaneForJob("github-webhook", JSON.stringify({ type: "github-webhook", payload: { action: "opened" } }))).toBeNull();
  });

  it("classifies a backlog-convergence-sourced agent-regate-pr job", () => {
    expect(foregroundLaneForJob("agent-regate-pr", regatePrPayload("backlog-convergence:owner/repo#7"))).toBe("backlog");
  });

  it("does not classify a sweep- or manually-originated agent-regate-pr job", () => {
    expect(foregroundLaneForJob("agent-regate-pr", regatePrPayload("regate-sweep:owner/repo#7"))).toBeNull();
    expect(foregroundLaneForJob("agent-regate-pr", regatePrPayload("manual-regate:owner/repo#7:1"))).toBeNull();
  });

  it("treats a missing deliveryId as unclassified rather than throwing", () => {
    expect(foregroundLaneForJob("agent-regate-pr", regatePrPayload())).toBeNull();
  });

  it("fails closed (null) on a malformed agent-regate-pr payload", () => {
    expect(foregroundLaneForJob("agent-regate-pr", "not-json")).toBeNull();
  });

  it("does not classify any other job type", () => {
    expect(foregroundLaneForJob("recapture-preview", JSON.stringify({ type: "recapture-preview" }))).toBeNull();
    expect(foregroundLaneForJob("agent-regate-sweep", JSON.stringify({ type: "agent-regate-sweep" }))).toBeNull();
  });
});

describe("nextForegroundLane (#selfhost-backlog-convergence)", () => {
  it("prefers backlog for backlogPer of every windowSize cycle under the default 3:1 ratio", () => {
    expect(nextForegroundLane(0)).toBe("backlog");
    expect(nextForegroundLane(1)).toBe("backlog");
    expect(nextForegroundLane(2)).toBe("backlog");
    expect(nextForegroundLane(3)).toBe("fresh");
  });

  it("wraps the cycle deterministically (same sequence mod windowSize -> same lane)", () => {
    expect(nextForegroundLane(4)).toBe("backlog"); // 4 % 4 === 0
    expect(nextForegroundLane(7)).toBe("fresh"); // 7 % 4 === 3
  });

  it("honors a custom ratio", () => {
    const ratio = { backlogPer: 1, freshPer: 1 };
    expect(nextForegroundLane(0, ratio)).toBe("backlog");
    expect(nextForegroundLane(1, ratio)).toBe("fresh");
  });

  it("the exported default ratio matches the documented 3:1 policy", () => {
    expect(DEFAULT_FOREGROUND_LANE_RATIO).toEqual({ backlogPer: 3, freshPer: 1 });
  });
});

describe("pickBacklogRepo (#selfhost-backlog-convergence)", () => {
  it("returns null when there are no candidates", () => {
    expect(pickBacklogRepo([], null)).toBeNull();
  });

  it("picks the stalest repo on a first-ever pick (no last-claimed repo)", () => {
    const candidates = [
      { repo: "owner/a", oldestPendingAgeMs: 1000 },
      { repo: "owner/b", oldestPendingAgeMs: 5000 },
    ];
    expect(pickBacklogRepo(candidates, null)).toBe("owner/b");
  });

  it("rotates past the last-claimed repo to the next-stalest, not re-picking the same repo", () => {
    const candidates = [
      { repo: "owner/a", oldestPendingAgeMs: 1000 },
      { repo: "owner/b", oldestPendingAgeMs: 5000 },
      { repo: "owner/c", oldestPendingAgeMs: 3000 },
    ];
    // sorted stalest-first: b(5000), c(3000), a(1000) — last-claimed b -> rotate to c
    expect(pickBacklogRepo(candidates, "owner/b")).toBe("owner/c");
  });

  it("wraps around to the stalest repo when the last-claimed repo was the least-stale", () => {
    const candidates = [
      { repo: "owner/a", oldestPendingAgeMs: 1000 },
      { repo: "owner/b", oldestPendingAgeMs: 5000 },
    ];
    expect(pickBacklogRepo(candidates, "owner/a")).toBe("owner/b");
  });

  it("falls back to the stalest repo when the last-claimed repo has since drained (no longer a candidate)", () => {
    const candidates = [{ repo: "owner/b", oldestPendingAgeMs: 5000 }];
    expect(pickBacklogRepo(candidates, "owner/a")).toBe("owner/b");
  });

  it("breaks a tie in oldestPendingAgeMs by repo name for determinism", () => {
    const candidates = [
      { repo: "owner/z", oldestPendingAgeMs: 1000 },
      { repo: "owner/a", oldestPendingAgeMs: 1000 },
    ];
    expect(pickBacklogRepo(candidates, null)).toBe("owner/a");
  });
});

describe("backlogRepoCandidatesFromJobKeys (#selfhost-backlog-convergence)", () => {
  it("extracts the repo and oldest pending age from backlog-lane job keys", () => {
    const candidates = backlogRepoCandidatesFromJobKeys(
      [{ jobKey: "agent-regate-pr:owner/repo#7", createdAtMs: 1000 }],
      6000,
    );
    expect(candidates).toEqual([{ repo: "owner/repo", oldestPendingAgeMs: 5000 }]);
  });

  it("skips a row with a missing job_key", () => {
    expect(backlogRepoCandidatesFromJobKeys([{ jobKey: null, createdAtMs: 1000 }], 2000)).toEqual([]);
    expect(backlogRepoCandidatesFromJobKeys([{ jobKey: undefined, createdAtMs: 1000 }], 2000)).toEqual([]);
  });

  it("skips a row whose job_key is not an agent-regate-pr key", () => {
    expect(backlogRepoCandidatesFromJobKeys([{ jobKey: "agent-regate-sweep:owner/repo", createdAtMs: 1000 }], 2000)).toEqual([]);
  });

  it("treats a job_key with no '#' as the repo being everything after the prefix", () => {
    const candidates = backlogRepoCandidatesFromJobKeys([{ jobKey: "agent-regate-pr:owner/repo", createdAtMs: 1000 }], 2000);
    expect(candidates).toEqual([{ repo: "owner/repo", oldestPendingAgeMs: 1000 }]);
  });

  it("skips a row whose extracted repo is empty", () => {
    expect(backlogRepoCandidatesFromJobKeys([{ jobKey: "agent-regate-pr:#7", createdAtMs: 1000 }], 2000)).toEqual([]);
  });

  it("keeps the OLDEST (largest age) pending row per repo when multiple rows share a repo", () => {
    const candidates = backlogRepoCandidatesFromJobKeys(
      [
        { jobKey: "agent-regate-pr:owner/repo#1", createdAtMs: 5000 },
        { jobKey: "agent-regate-pr:owner/repo#2", createdAtMs: 1000 },
      ],
      6000,
    );
    expect(candidates).toEqual([{ repo: "owner/repo", oldestPendingAgeMs: 5000 }]);
  });

  it("does NOT overwrite an already-older pending row for the same repo with a newer (smaller-age) one", () => {
    const candidates = backlogRepoCandidatesFromJobKeys(
      [
        { jobKey: "agent-regate-pr:owner/repo#1", createdAtMs: 1000 }, // age 5000, seen first
        { jobKey: "agent-regate-pr:owner/repo#2", createdAtMs: 5000 }, // age 1000, seen second — must NOT win
      ],
      6000,
    );
    expect(candidates).toEqual([{ repo: "owner/repo", oldestPendingAgeMs: 5000 }]);
  });

  it("clamps a negative age (createdAt in the future) to zero", () => {
    const candidates = backlogRepoCandidatesFromJobKeys([{ jobKey: "agent-regate-pr:owner/repo#1", createdAtMs: 9000 }], 1000);
    expect(candidates).toEqual([{ repo: "owner/repo", oldestPendingAgeMs: 0 }]);
  });
});
