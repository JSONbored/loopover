// The published automation-rate definition (#9727). Every figure here is a claim an outsider is invited to
// recompute from the ledger, so these pin the DEFINITION -- especially the places where a plausible shortcut
// would let the rate be inflated.
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_RATE_PROVENANCE_HORIZON_ISO,
  buildAutomationRateSeries,
  loadAutomationRateSeries,
  verdictShowsHumanAction,
  weekStartIso,
  type AutomationVerdictRow,
} from "../../src/review/automation-rate";

function row(over: Partial<AutomationVerdictRow> = {}): AutomationVerdictRow {
  return {
    repoFullName: "o/r",
    pullNumber: 1,
    action: "merge",
    createdAt: "2026-07-29T12:00:00.000Z",
    reevaluationReason: null,
    reevaluationActor: null,
    ...over,
  };
}

describe("verdictShowsHumanAction", () => {
  it("counts a HOLD as human action — the gate declined to decide", () => {
    expect(verdictShowsHumanAction({ action: "hold", reevaluationReason: null, reevaluationActor: null })).toBe(true);
  });

  it("counts a named re-evaluation actor, and a maintainer_request", () => {
    expect(verdictShowsHumanAction({ action: "merge", reevaluationReason: null, reevaluationActor: "JSONbored" })).toBe(true);
    expect(verdictShowsHumanAction({ action: "merge", reevaluationReason: "maintainer_request", reevaluationActor: null })).toBe(true);
  });

  it("does NOT count machine-paced re-evaluation causes", () => {
    // A scheduled sweep or a repair is the automation working, not a human intervening.
    for (const reason of ["scheduled_recheck", "pipeline_error", "upstream_state_change", "config_change"]) {
      expect(verdictShowsHumanAction({ action: "merge", reevaluationReason: reason, reevaluationActor: null }), reason).toBe(false);
    }
  });

  it("treats a blank actor as no actor", () => {
    expect(verdictShowsHumanAction({ action: "merge", reevaluationReason: null, reevaluationActor: "   " })).toBe(false);
  });
});

describe("weekStartIso", () => {
  it("returns the UTC MONDAY of the containing week", () => {
    expect(weekStartIso("2026-07-29T12:00:00.000Z")).toBe("2026-07-27T00:00:00.000Z"); // Wed -> Mon
    expect(weekStartIso("2026-07-27T00:00:00.000Z")).toBe("2026-07-27T00:00:00.000Z"); // Mon -> itself
  });

  it("puts SUNDAY in the week that started six days earlier, not the next one", () => {
    // getUTCDay()===0 is the off-by-one every week-bucketing bug is made of.
    expect(weekStartIso("2026-08-02T23:59:59.000Z")).toBe("2026-07-27T00:00:00.000Z");
  });

  it("is null on an unparseable timestamp rather than bucketing it somewhere wrong", () => {
    expect(weekStartIso("not-a-date")).toBeNull();
  });
});

describe("buildAutomationRateSeries", () => {
  it("counts PULL REQUESTS once, not verdicts", () => {
    const series = buildAutomationRateSeries([row({ pullNumber: 1 }), row({ pullNumber: 1 }), row({ pullNumber: 2 })]);
    expect(series.decided).toBe(2);
    expect(series.automated).toBe(2);
    expect(series.automationRatePct).toBe(100);
  });

  it("a PR that was HELD and later merged is MANUAL — the end state is not the question", () => {
    // Counting the final disposition would let the rate be inflated by holding everything and merging by hand.
    const series = buildAutomationRateSeries([
      row({ pullNumber: 1, action: "hold", createdAt: "2026-07-29T10:00:00.000Z" }),
      row({ pullNumber: 1, action: "merge", createdAt: "2026-07-29T11:00:00.000Z" }),
    ]);
    expect(series.decided).toBe(1);
    expect(series.weeks[0]?.manual).toBe(1);
    expect(series.automated).toBe(0);
    expect(series.automationRatePct).toBe(0);
  });

  it("EXCLUDES a PR that was never actually decided, rather than counting it automated", () => {
    // The regression (#9938 review): `action` also carries non-deciding classes -- `label`, `update_branch`,
    // `approve`, and the error/no-op classes. None of them is `hold`, so a PR that only ever drew those
    // carried no human signal and was folded in as an AUTOMATED decision, inflating the published rate with
    // pull requests the gate never decided at all.
    const series = buildAutomationRateSeries([
      row({ pullNumber: 1, action: "label" }),
      row({ pullNumber: 2, action: "update_branch" }),
      row({ pullNumber: 3, action: "approve" }),
    ]);
    expect(series.decided).toBe(0);
    expect(series.automated).toBe(0);
    expect(series.automationRatePct).toBeNull();
  });

  it("still counts a PR that drew a non-deciding verdict AND then a real one", () => {
    // The bot labelling a PR before merging it is the bot acting, not a person -- it must not flip the PR
    // to manual, which would under-count automation just as wrongly as the bug over-counted it.
    const series = buildAutomationRateSeries([
      row({ pullNumber: 1, action: "label", createdAt: "2026-07-29T10:00:00.000Z" }),
      row({ pullNumber: 1, action: "merge", createdAt: "2026-07-29T11:00:00.000Z" }),
    ]);
    expect(series.decided).toBe(1);
    expect(series.automated).toBe(1);
  });

  it("counts a PR MANUAL when a human signal rides a NON-deciding verdict, not just a deciding one (#10013)", () => {
    // The bug: `queryAutomationRows` restricted rows by `action`, so a human signal carried on a non-deciding
    // verdict (a re-labelled PR, a maintainer-triggered re-run recorded as `label`/`update_branch`) never
    // reached the fold. The PR's only surviving row was the clean `merge`, so a PR a person actually touched
    // read as AUTOMATED. With the filter gone the fold sees the human-signal row and ORs it in.
    const humanOnLabel = buildAutomationRateSeries([
      row({ pullNumber: 1, action: "label", reevaluationActor: "JSONbored", createdAt: "2026-07-29T10:00:00.000Z" }),
      row({ pullNumber: 1, action: "merge", createdAt: "2026-07-29T11:00:00.000Z" }),
    ]);
    expect(humanOnLabel.decided).toBe(1);
    expect(humanOnLabel.automated).toBe(0);
    expect(humanOnLabel.weeks[0]?.manual).toBe(1);

    // Same for a maintainer_request reason riding a non-deciding verdict.
    const requestOnUpdate = buildAutomationRateSeries([
      row({ pullNumber: 2, action: "update_branch", reevaluationReason: "maintainer_request", createdAt: "2026-07-29T10:00:00.000Z" }),
      row({ pullNumber: 2, action: "merge", createdAt: "2026-07-29T11:00:00.000Z" }),
    ]);
    expect(requestOnUpdate.automated).toBe(0);
    expect(requestOnUpdate.weeks[0]?.manual).toBe(1);
  });

  it("counts a hold-only PR as decided-and-manual, never as undecided", () => {
    const series = buildAutomationRateSeries([row({ pullNumber: 1, action: "hold" })]);
    expect(series.decided).toBe(1);
    expect(series.automated).toBe(0);
    expect(series.weeks[0]?.manual).toBe(1);
  });

  it("buckets a PR by its FIRST verdict, so re-evaluations do not migrate it between weeks", () => {
    const series = buildAutomationRateSeries([
      row({ pullNumber: 1, createdAt: "2026-08-03T09:00:00.000Z" }), // a later Monday
      row({ pullNumber: 1, createdAt: "2026-07-29T09:00:00.000Z" }), // the earlier week
    ]);
    expect(series.weeks.map((w) => w.weekStart)).toEqual(["2026-07-27T00:00:00.000Z"]);
  });

  it("separates pull numbers by REPO", () => {
    const series = buildAutomationRateSeries([row({ repoFullName: "a/b", pullNumber: 1 }), row({ repoFullName: "c/d", pullNumber: 1 })]);
    expect(series.decided).toBe(2);
  });

  it("orders weeks chronologically and reports a null rate for a week that decided nothing", () => {
    const series = buildAutomationRateSeries([
      row({ pullNumber: 2, createdAt: "2026-08-03T09:00:00.000Z" }),
      row({ pullNumber: 1, createdAt: "2026-07-29T09:00:00.000Z" }),
    ]);
    expect(series.weeks.map((w) => w.weekStart)).toEqual(["2026-07-27T00:00:00.000Z", "2026-08-03T00:00:00.000Z"]);
    expect(buildAutomationRateSeries([]).automationRatePct).toBeNull();
  });

  it("marks weeks before the provenance horizon as holds_only, not silently mixed in", () => {
    // Before migration 0204 only `hold` was observable, so those weeks can only UNDER-count manual work.
    const before = new Date(Date.parse(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO) - 21 * 86_400_000).toISOString();
    const after = new Date(Date.parse(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO) + 14 * 86_400_000).toISOString();
    const series = buildAutomationRateSeries([row({ createdAt: before }), row({ pullNumber: 2, createdAt: after })]);
    expect(series.weeks[0]?.basis).toBe("holds_only");
    expect(series.weeks.at(-1)?.basis).toBe("full");
    expect(series.provenanceHorizon).toBe(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO);
  });

  it("labels a week STRADDLING the horizon holds_only — understating confidence, not overstating it", () => {
    // The horizon falls mid-week, so part of that week predates the provenance fields. Calling it `full`
    // would claim completeness the data does not have; for a fairness figure the error must run the safe way.
    const straddling = new Date(Date.parse(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO) + 6 * 3_600_000).toISOString();
    const series = buildAutomationRateSeries([row({ createdAt: straddling })]);
    expect(Date.parse(series.weeks[0]!.weekStart)).toBeLessThan(Date.parse(AUTOMATION_RATE_PROVENANCE_HORIZON_ISO));
    expect(series.weeks[0]?.basis).toBe("holds_only");
  });

  it("drops a row with an unparseable timestamp rather than bucketing it wrong", () => {
    expect(buildAutomationRateSeries([row({ createdAt: "nope" })]).decided).toBe(0);
  });
});

describe("loadAutomationRateSeries", () => {
  it("windows on the supplied clock and defaults to 12 weeks", async () => {
    let asked = "";
    await loadAutomationRateSeries({}, {
      nowMs: Date.parse("2026-07-29T00:00:00.000Z"),
      fetchRows: async (since) => {
        asked = since;
        return [];
      },
    });
    expect(asked).toBe("2026-05-06T00:00:00.000Z"); // 12 weeks back
  });

  it("rejects a non-positive or fractional window rather than trusting it", async () => {
    for (const weeks of [0, -3, Number.NaN, undefined]) {
      let asked = "";
      await loadAutomationRateSeries({}, { nowMs: Date.parse("2026-07-29T00:00:00.000Z"), weeks, fetchRows: async (s) => { asked = s; return []; } });
      expect(asked, String(weeks)).toBe("2026-05-06T00:00:00.000Z");
    }
  });

  it("truncates a fractional window rather than rounding it up", async () => {
    let asked = "";
    await loadAutomationRateSeries({}, { nowMs: Date.parse("2026-07-29T00:00:00.000Z"), weeks: 2.9, fetchRows: async (s) => { asked = s; return []; } });
    expect(asked, "2.9 weeks is a 2-week window -- never longer than the number asked for").toBe("2026-07-15T00:00:00.000Z");
  });

  it("degrades when an INJECTED fetcher rejects, not just when the real query does", async () => {
    // safeAll swallows the real query's own failures, so this outer guard is what protects a caller that
    // supplies its own reader -- untested, it would look fine while being the only unprotected path.
    await expect(
      loadAutomationRateSeries({}, { fetchRows: async () => { throw new Error("upstream gone"); } }),
    ).resolves.toMatchObject({ weeks: [], decided: 0, automationRatePct: null });
  });

  it("reads through the real query when no fetcher is injected", async () => {
    // The production caller passes only `env`; without a default the endpoint would publish an empty series
    // forever while every injected-fetcher test above still passed.
    let sql = "";
    let binds: unknown[] = [];
    const env = {
      DB: {
        prepare(q: string) {
          sql = q;
          return {
            bind: (...values: unknown[]) => {
              binds = values;
              return { all: async () => ({ results: [] }) };
            },
          };
        },
      },
    };
    await loadAutomationRateSeries(env);
    expect(sql).toContain("FROM decision_records");
    expect(sql).toContain("reevaluation_actor");
    // #10013: the read must NOT restrict rows by action -- a human signal (reevaluation_actor /
    // reevaluation_reason='maintainer_request') can ride a non-deciding verdict, and the old `action IN (...)`
    // filter dropped exactly those rows, undercounting manual work. The only bind is the `created_at >= ?`
    // window bound: one placeholder, one bind, and no action list.
    expect(sql).not.toContain("action IN (");
    expect((sql.match(/\?/g) ?? []).length).toBe(1);
    expect(binds).toEqual([expect.any(String)]);
  });

  it("degrades to an empty series when the read throws, never failing the stats endpoint", async () => {
    const env = { DB: { prepare() { throw new Error("no such column"); } } };
    await expect(loadAutomationRateSeries(env)).resolves.toMatchObject({ weeks: [], decided: 0, automationRatePct: null });
  });
});
