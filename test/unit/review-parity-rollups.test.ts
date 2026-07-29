// The published fairness definitions (#9743).
//
// Every figure here is a claim an outsider is invited to recompute from the ledger export, so these tests
// pin the DEFINITIONS -- especially the places where a plausible-looking shortcut would quietly bias the
// comparison the rollups exist to make.
import { describe, expect, it } from "vitest";
import {
  AUTHOR_CLASSES,
  buildReviewParityRollups,
  loadReviewParityRollups,
  ratePct,
  rollUpByAuthorClass,
  rollUpVerdicts,
  type ParityVerdictRow,
  type RawParityRow,
} from "../../src/review/review-parity-rollups";
import { classifyAuthorAssociation, isMaintainerAuthorAssociation, MAINTAINER_AUTHOR_ASSOCIATIONS } from "../../src/github/author-association";

function row(over: Partial<ParityVerdictRow> = {}): ParityVerdictRow {
  return {
    authorClass: "contributor",
    repoFullName: "o/r",
    pullNumber: 1,
    action: "merge",
    findingsCount: 0,
    reevaluationReason: null,
    ...over,
  };
}

describe("author class derivation (#9743)", () => {
  it("maps GitHub's own association, case-insensitively", () => {
    for (const association of MAINTAINER_AUTHOR_ASSOCIATIONS) {
      expect(classifyAuthorAssociation(association), association).toBe("maintainer");
      expect(classifyAuthorAssociation(association.toLowerCase()), association).toBe("maintainer");
    }
    expect(classifyAuthorAssociation("CONTRIBUTOR")).toBe("contributor");
    expect(classifyAuthorAssociation("FIRST_TIME_CONTRIBUTOR")).toBe("contributor");
    expect(classifyAuthorAssociation("NONE")).toBe("contributor");
  });

  it("treats CONTRIBUTOR as a contributor — a merged PR in the past is not authority over the repo", () => {
    expect(isMaintainerAuthorAssociation("CONTRIBUTOR")).toBe(false);
  });

  it("reports an unrecorded association as UNKNOWN rather than folding it into either side", () => {
    // Folding unknowns into `contributor` would bias exactly the comparison being published.
    for (const value of [null, undefined, "", "   "]) {
      expect(classifyAuthorAssociation(value), JSON.stringify(value)).toBe("unknown");
    }
    expect(AUTHOR_CLASSES).toEqual(["maintainer", "contributor", "unknown"]);
  });
});

describe("ratePct", () => {
  it("is null on a zero denominator — unknown is not 0%", () => {
    // "nothing was held" and "nothing was measured" are different claims; a 0 here would assert the first.
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(1, 2)).toBe(50);
    expect(ratePct(1, 3)).toBe(33.3);
  });
});

describe("rollUpVerdicts", () => {
  it("counts EVALUATIONS but divides by distinct pull requests", () => {
    const rollup = rollUpVerdicts("contributor", [
      row({ pullNumber: 1 }),
      row({ pullNumber: 1 }),
      row({ pullNumber: 2 }),
    ]);
    expect(rollup.verdicts).toBe(3);
    expect(rollup.pullRequests).toBe(2);
    expect(rollup.reviewsPerPr).toBe(1.5);
  });

  it("separates pull numbers by REPO, so two repos' #1 are not one PR", () => {
    const rollup = rollUpVerdicts("contributor", [row({ repoFullName: "a/b", pullNumber: 1 }), row({ repoFullName: "c/d", pullNumber: 1 })]);
    expect(rollup.pullRequests).toBe(2);
  });

  it("EXCLUDES null finding counts from the mean instead of counting them as zero", () => {
    // A policy close records no findings. Averaging it in as 0 would understate how many findings a real
    // review raised, which is the number being compared across author classes.
    const rollup = rollUpVerdicts("contributor", [row({ findingsCount: 4 }), row({ findingsCount: null }), row({ findingsCount: 2 })]);
    expect(rollup.findingsPerPr).toBe(3);
    expect(rollup.findingsBasis, "the coverage the mean was earned at is published beside it").toBe(2);
  });

  it("reports a mean of null, not 0, when no verdict recorded a count", () => {
    const rollup = rollUpVerdicts("maintainer", [row({ findingsCount: null })]);
    expect(rollup.findingsPerPr).toBeNull();
    expect(rollup.findingsBasis).toBe(0);
  });

  it("computes close and hold rates over ALL verdicts, including merges", () => {
    const rollup = rollUpVerdicts("contributor", [row({ action: "close" }), row({ action: "hold" }), row({ action: "merge" }), row({ action: "merge" })]);
    expect(rollup.closeRate).toBe(25);
    expect(rollup.holdRate).toBe(25);
  });

  it("reports every rate as null for an empty class rather than a reassuring zero", () => {
    const rollup = rollUpVerdicts("maintainer", []);
    expect(rollup).toMatchObject({ verdicts: 0, pullRequests: 0, reviewsPerPr: null, findingsPerPr: null, closeRate: null, holdRate: null });
  });
});

describe("rollUpByAuthorClass", () => {
  it("keeps report order and omits classes with no verdicts", () => {
    const rollups = rollUpByAuthorClass([row({ authorClass: "unknown" }), row({ authorClass: "maintainer" })]);
    expect(rollups.map((r) => r.authorClass)).toEqual(["maintainer", "unknown"]);
  });
});

describe("buildReviewParityRollups", () => {
  const window = { windowStart: "2026-07-22T00:00:00.000Z", windowEnd: "2026-07-29T00:00:00.000Z" };

  it("counts re-evaluations by declared reason, as a share of ALL verdicts", () => {
    // Share-of-verdicts, not share-of-re-evaluations: the latter always sums to 100% and says nothing
    // about how often re-evaluation happens at all.
    const result = buildReviewParityRollups({
      ...window,
      rows: [
        row({ reevaluationReason: "scheduled_recheck" }),
        row({ reevaluationReason: "scheduled_recheck" }),
        row({ reevaluationReason: "pipeline_error" }),
        row(),
      ],
    });
    expect(result.verdicts).toBe(4);
    expect(result.reevaluations).toBe(3);
    expect(result.reevaluationRatePct).toBe(75);
    expect(result.byReason).toEqual([
      { reason: "scheduled_recheck", count: 2, shareOfVerdictsPct: 50 },
      { reason: "pipeline_error", count: 1, shareOfVerdictsPct: 25 },
    ]);
  });

  it("orders equal reason counts by name, so the series is stable between runs", () => {
    const result = buildReviewParityRollups({
      ...window,
      rows: [row({ reevaluationReason: "pipeline_error" }), row({ reevaluationReason: "config_change" })],
    });
    expect(result.byReason.map((entry) => entry.reason)).toEqual(["config_change", "pipeline_error"]);
  });

  it("reports an EMPTY window as measured-zero with its bounds, never as a missing series", () => {
    const result = buildReviewParityRollups({ ...window, rows: [] });
    expect(result).toMatchObject({ verdicts: 0, reevaluations: 0, reevaluationRatePct: null, byReason: [], byAuthorClass: [], byProject: [] });
    expect(result.windowStart).toBe(window.windowStart);
    expect(result.windowEnd).toBe(window.windowEnd);
  });

  it("splits per project, busiest first, each with its own class breakdown", () => {
    const result = buildReviewParityRollups({
      ...window,
      rows: [
        row({ repoFullName: "busy/repo", pullNumber: 1 }),
        row({ repoFullName: "busy/repo", pullNumber: 2 }),
        row({ repoFullName: "quiet/repo", pullNumber: 1, authorClass: "maintainer" }),
      ],
    });
    expect(result.byProject.map((entry) => entry.project)).toEqual(["busy/repo", "quiet/repo"]);
    expect(result.byProject[1]?.byAuthorClass.map((r) => r.authorClass)).toEqual(["maintainer"]);
  });

  it("breaks ties between equally busy projects by name", () => {
    const result = buildReviewParityRollups({ ...window, rows: [row({ repoFullName: "b/b" }), row({ repoFullName: "a/a" })] });
    expect(result.byProject.map((entry) => entry.project)).toEqual(["a/a", "b/b"]);
  });
});

describe("loadReviewParityRollups", () => {
  const raw = (over: Partial<RawParityRow> = {}): RawParityRow => ({
    repoFullName: "o/r",
    pullNumber: 1,
    action: "merge",
    findingsCount: 1,
    reevaluationReason: null,
    authorAssociation: "CONTRIBUTOR",
    ...over,
  });

  it("windows on the supplied clock and classifies each row's association", async () => {
    let asked: [string, string] | null = null;
    const result = await loadReviewParityRollups(
      {},
      {
        nowMs: Date.parse("2026-07-29T00:00:00.000Z"),
        windowDays: 7,
        fetchRows: async (since, until) => {
          asked = [since, until];
          return [raw(), raw({ authorAssociation: "OWNER" })];
        },
      },
    );
    expect(asked).toEqual(["2026-07-22T00:00:00.000Z", "2026-07-29T00:00:00.000Z"]);
    expect(result.byAuthorClass.map((r) => r.authorClass)).toEqual(["maintainer", "contributor"]);
  });

  it("defaults to a 7-day window and rejects a non-positive or fractional one", async () => {
    for (const windowDays of [undefined, 0, -3, Number.NaN]) {
      const result = await loadReviewParityRollups({}, { nowMs: Date.parse("2026-07-29T00:00:00.000Z"), windowDays, fetchRows: async () => [] });
      expect(result.windowStart, String(windowDays)).toBe("2026-07-22T00:00:00.000Z");
    }
    const truncated = await loadReviewParityRollups({}, { nowMs: Date.parse("2026-07-29T00:00:00.000Z"), windowDays: 2.9, fetchRows: async () => [] });
    expect(truncated.windowStart).toBe("2026-07-27T00:00:00.000Z");
  });

  it("normalizes a blank re-evaluation reason to null, so it is not counted as a cause", async () => {
    const result = await loadReviewParityRollups({}, { fetchRows: async () => [raw({ reevaluationReason: "" })] });
    expect(result.reevaluations).toBe(0);
  });

  it("normalizes a non-numeric finding count to null rather than trusting it", async () => {
    const result = await loadReviewParityRollups({}, { fetchRows: async () => [raw({ findingsCount: null })] });
    expect(result.byAuthorClass[0]?.findingsPerPr).toBeNull();
  });

  it("degrades to a measured-zero window when the read throws, never failing the stats endpoint", async () => {
    // /v1/public/stats composes several series; one unavailable table must not take the whole payload down.
    const result = await loadReviewParityRollups({}, {
      fetchRows: async () => {
        throw new Error("no such table: decision_records");
      },
    });
    expect(result).toMatchObject({ verdicts: 0, reevaluations: 0, byAuthorClass: [] });
  });
});

describe("loadReviewParityRollups default paths", () => {
  it("reads through the real query when no fetcher is injected", async () => {
    // The production caller passes only `env`. If the default were missing, every injected-fetcher test
    // above would still pass while the endpoint published an empty series forever.
    let asked = "";
    const env = {
      DB: {
        prepare(sql: string) {
          asked = sql;
          return {
            bind: () => ({ all: async () => ({ results: [{ repoFullName: "o/r", pullNumber: 1, action: "hold", findingsCount: 2, reevaluationReason: "scheduled_recheck", authorAssociation: "OWNER" }] }) }),
          };
        },
      },
    };

    const result = await loadReviewParityRollups(env, { nowMs: Date.parse("2026-07-29T00:00:00.000Z") });

    expect(asked, "it really queries the anchored ledger").toContain("FROM decision_records");
    expect(asked, "LEFT JOIN so a pruned PR row still counts rather than vanishing").toContain("LEFT JOIN pull_requests");
    expect(result.byAuthorClass).toEqual([
      expect.objectContaining({ authorClass: "maintainer", verdicts: 1, holdRate: 100, findingsPerPr: 2, findingsBasis: 1 }),
    ]);
  });

  it("degrades to an empty window when the real query throws", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("no such column: findings_count");
        },
      },
    };
    await expect(loadReviewParityRollups(env)).resolves.toMatchObject({ verdicts: 0, byAuthorClass: [] });
  });

  it("defaults the clock to now when no nowMs is supplied", async () => {
    const before = Date.now();
    const result = await loadReviewParityRollups({}, { fetchRows: async () => [] });
    expect(Date.parse(result.windowEnd)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.windowEnd)).toBeLessThanOrEqual(Date.now());
  });
});
