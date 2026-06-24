import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import type { QueueHealth, RoleContext } from "../../src/signals/engine";
import { simulateOpenPrPressure, type OpenPrPressureInput } from "../../src/services/open-pr-pressure-scenarios";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward estimate|raw trust|trust score|scoreability|private reviewability|estimated score|score estimate|farming/i;

function queueHealth(level: QueueHealth["level"], overrides: Partial<QueueHealth["signals"]> = {}): QueueHealth {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    burdenScore: level === "low" ? 10 : level === "medium" ? 40 : level === "high" ? 65 : 90,
    level,
    summary: `Queue is ${level}.`,
    signals: {
      openIssues: 5,
      openPullRequests: level === "low" ? 1 : 12,
      unlinkedPullRequests: 0,
      stalePullRequests: level === "high" || level === "critical" ? 4 : 0,
      draftPullRequests: 0,
      maintainerAuthoredPullRequests: 0,
      collisionClusters: 0,
      ageBuckets: { under7Days: 1, days7To30: 0, over30Days: 0 },
      likelyReviewablePullRequests: 1,
      ...overrides,
    },
    findings: [],
  };
}

function role(maintainerLane: boolean): RoleContext {
  return {
    login: "miner-a",
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    role: maintainerLane ? "owner" : "outside_contributor",
    maintainerLane,
    normalContributorEvidenceAllowed: !maintainerLane,
    source: maintainerLane ? "repo_owner_match" : "cache",
    association: maintainerLane ? "OWNER" : "NONE",
    reasons: [],
    guidance: maintainerLane ? "maintainer" : "contributor",
  };
}

function input(overrides: Partial<OpenPrPressureInput> = {}): OpenPrPressureInput {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    queueHealth: queueHealth("low"),
    roleContext: role(false),
    contributorOpenPrCount: 0,
    ...overrides,
  };
}

// ── Low-pressure repo ──────────────────────────────────────────────────────

describe("low-pressure contributor repo", () => {
  it("recommends opening another PR when pressure is low and the contributor has no open PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("low"), contributorOpenPrCount: 0 }));
    expect(sim.lane).toBe("contributor");
    expect(sim.queuePressure).toBe("low");
    expect(sim.recommendedOption).toBe("open_new_work");
    expect(sim.scenarios[0]).toMatchObject({ option: "open_new_work", rank: 1, recommended: true });
    expect(sim.scenarios.map((s) => s.option)).toEqual(["open_new_work", "wait", "cleanup_first"]);
  });

  it("flags that cleanup-first has nothing to clean when the contributor has no open PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("low"), contributorOpenPrCount: 0 }));
    const cleanup = sim.scenarios.find((s) => s.option === "cleanup_first")!;
    expect(cleanup.blockers.join(" ")).toMatch(/no open PR|nothing to clean/i);
  });

  it("ranks every option exactly once with sequential ranks", () => {
    const sim = simulateOpenPrPressure(input());
    expect(sim.scenarios.map((s) => s.rank)).toEqual([1, 2, 3]);
    expect(new Set(sim.scenarios.map((s) => s.option)).size).toBe(3);
  });
});

// ── High-pressure repo ─────────────────────────────────────────────────────

describe("high-pressure contributor repo", () => {
  it("recommends waiting when pressure is high and the contributor has no open PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("high"), contributorOpenPrCount: 0 }));
    expect(sim.queuePressure).toBe("high");
    expect(sim.recommendedOption).toBe("wait");
    expect(sim.scenarios.map((s) => s.option)).toEqual(["wait", "open_new_work", "cleanup_first"]);
  });

  it("recommends cleanup-first when pressure is high and the contributor already has open PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("critical"), contributorOpenPrCount: 2 }));
    expect(sim.recommendedOption).toBe("cleanup_first");
    expect(sim.scenarios.map((s) => s.option)).toEqual(["cleanup_first", "wait", "open_new_work"]);
  });

  it("includes the stale PR fact in scenario facts under high pressure", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("high"), contributorOpenPrCount: 0 }));
    expect(sim.scenarios[0]!.facts.join(" ")).toMatch(/stale PR/i);
  });

  it("open-new-work scenario warns about adding to queue pressure", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("high"), contributorOpenPrCount: 0 }));
    const open = sim.scenarios.find((s) => s.option === "open_new_work")!;
    expect(open.assumptions.join(" ")).toMatch(/add to the current high/i);
  });
});

// ── Maintainer-lane repo ───────────────────────────────────────────────────

describe("maintainer-lane repo", () => {
  it("handles maintainer lane separately and recommends opening work under non-critical pressure", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("medium"), roleContext: role(true), contributorOpenPrCount: 3 }));
    expect(sim.lane).toBe("maintainer");
    expect(sim.recommendedOption).toBe("open_new_work");
    const open = sim.scenarios.find((s) => s.option === "open_new_work")!;
    expect(open.assumptions.join(" ")).toMatch(/maintainer-lane|repo-health/i);
  });

  it("recommends triaging the queue first under critical pressure in the maintainer lane", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("critical"), roleContext: role(true), contributorOpenPrCount: 1 }));
    expect(sim.lane).toBe("maintainer");
    expect(sim.recommendedOption).toBe("cleanup_first");
  });

  it("never penalizes a maintainer for their own concurrent PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("medium"), roleContext: role(true), contributorOpenPrCount: 5 }));
    const open = sim.scenarios.find((s) => s.option === "open_new_work")!;
    expect(open.blockers).toHaveLength(0);
  });
});

// ── Missing-signal repo ────────────────────────────────────────────────────

describe("missing-signal repo", () => {
  it("treats pressure as unknown and recommends a conservative wait for contributors", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: null, contributorOpenPrCount: 0 }));
    expect(sim.queuePressure).toBe("unknown");
    expect(sim.recommendedOption).toBe("wait");
    expect(sim.summary).toMatch(/signals are unavailable|conservative default/i);
  });

  it("marks open-new-work as an estimate when signals are missing", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: null, contributorOpenPrCount: 0 }));
    const open = sim.scenarios.find((s) => s.option === "open_new_work")!;
    expect(open.assumptions.join(" ")).toMatch(/unavailable|estimate/i);
  });

  it("still recommends cleanup-first when signals are missing but the contributor has open PRs", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: null, contributorOpenPrCount: 3 }));
    expect(sim.recommendedOption).toBe("cleanup_first");
  });
});

// ── Facts vs assumptions separation ────────────────────────────────────────

describe("facts vs assumptions separation", () => {
  it("keeps known facts and assumptions in distinct fields", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("medium"), contributorOpenPrCount: 1 }));
    for (const scenario of sim.scenarios) {
      // facts describe observed queue state; assumptions describe projections
      expect(scenario.facts.length).toBeGreaterThan(0);
      expect(scenario.facts.join(" ")).toMatch(/open PR|open issue|queue pressure/i);
    }
  });
});

// ── Public sanitizer tests ─────────────────────────────────────────────────

describe("public sanitizer tests for open-pr pressure summaries", () => {
  it("every scenario field across all fixtures is free of forbidden public language", () => {
    const fixtures: OpenPrPressureInput[] = [
      input({ queueHealth: queueHealth("low"), contributorOpenPrCount: 0 }),
      input({ queueHealth: queueHealth("high"), contributorOpenPrCount: 2 }),
      input({ queueHealth: queueHealth("critical"), roleContext: role(true), contributorOpenPrCount: 1 }),
      input({ queueHealth: null, contributorOpenPrCount: 0 }),
    ];
    for (const fixture of fixtures) {
      const sim = simulateOpenPrPressure(fixture);
      const text = [
        sim.summary,
        ...sim.scenarios.flatMap((s) => [s.label, ...s.facts, ...s.assumptions, ...s.tradeoffs, ...s.blockers]),
      ].join(" ");
      expect(text).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
      expect(text).toBe(sanitizePublicComment(text));
    }
  });

  it("makes no payout, reward, or score claims in any scenario", () => {
    const sim = simulateOpenPrPressure(input({ queueHealth: queueHealth("medium"), contributorOpenPrCount: 1 }));
    const text = JSON.stringify(sim);
    expect(text).not.toMatch(/payout|reward|earn|\bscore\b/i);
  });
});
