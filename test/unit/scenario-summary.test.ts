import { describe, expect, it } from "vitest";
import { renderScenarioSummary, type ScenarioSummarySource, type ScenarioSummaryScenario } from "../../src/services/scenario-summary";
import type { ScoreGateBlocker } from "../../src/scoring/preview";

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward estimate|raw trust|trust score|scoreability|private reviewability|estimated score|score estimate|farming/i;

function blocker(code: ScoreGateBlocker["code"], severity: ScoreGateBlocker["severity"], detail: string): ScoreGateBlocker {
  return { code, severity, detail };
}

function scenario(overrides: Partial<ScenarioSummaryScenario> & Pick<ScenarioSummaryScenario, "name">): ScenarioSummaryScenario {
  return {
    source: "gittensory_projection",
    assumptions: [],
    blockedBy: [],
    effectiveEstimatedScore: 0,
    deltaExplanation: "",
    ...overrides,
  };
}

function source(overrides: Partial<ScenarioSummarySource> = {}): ScenarioSummarySource {
  return {
    repoFullName: "octo/demo",
    generatedAt: "2026-06-03T00:00:00.000Z",
    scoreabilityStatus: "conditionally_scoreable",
    recommendation: { level: "needs_work", actions: ["Land or close existing open PRs before opening more concurrent work."] },
    scenarioPreviews: [
      scenario({ name: "current", source: "current_data", effectiveEstimatedScore: 100, deltaExplanation: "Baseline estimated score 100.", blockedBy: [blocker("open_pr_threshold", "blocker", "Open PR count 3 exceeds threshold 2.")] }),
      scenario({ name: "afterPendingMerges", source: "github_observed", effectiveEstimatedScore: 200, assumptions: ["Assumes 2 pending PRs reach a terminal state."], deltaExplanation: "Open PR pressure changes estimated score 100 -> 200." }),
      scenario({ name: "bestReasonableCase", source: "gittensory_projection", effectiveEstimatedScore: 320, assumptions: ["Combines plausible near-term gate cleanup."], deltaExplanation: "Best case lifts estimated score 100 -> 320." }),
    ],
    ...overrides,
  };
}

describe("renderScenarioSummary public_safe", () => {
  it("renders a ranked, public-safe summary snapshot", () => {
    const summary = renderScenarioSummary(source(), { visibility: "public_safe" });
    expect(summary).toMatchInlineSnapshot(`
      {
        "generatedAt": "2026-06-03T00:00:00.000Z",
        "nextSafeAction": "Land or close existing open PRs before opening more concurrent work.",
        "rankedScenarios": [
          {
            "assumptions": [
              "Combines plausible near-term gate cleanup.",
            ],
            "blockers": [],
            "label": "Best reasonable near-term case",
            "name": "bestReasonableCase",
            "reasons": [
              "Combines plausible near-term cleanup of the noted conditions.",
            ],
            "source": "gittensory_projection",
          },
          {
            "assumptions": [
              "Assumes 2 pending PRs reach a terminal state.",
            ],
            "blockers": [],
            "label": "After pending PRs merge or close",
            "name": "afterPendingMerges",
            "reasons": [
              "Assumes pending PRs reach a terminal state, easing open-PR pressure.",
            ],
            "source": "github_observed",
          },
          {
            "assumptions": [],
            "blockers": [
              "Too many open PRs; land or close some before opening more.",
            ],
            "label": "Current state",
            "name": "current",
            "reasons": [
              "Baseline from current cached repo and contributor state.",
            ],
            "source": "current_data",
          },
        ],
        "repoFullName": "octo/demo",
        "summary": "This work can move forward once the noted conditions are met.",
        "visibility": "public_safe",
      }
    `);
  });

  it("ranks scenarios by effective estimated score descending without exposing the score", () => {
    const summary = renderScenarioSummary(source(), { visibility: "public_safe" });
    expect(summary.rankedScenarios.map((s) => s.name)).toEqual(["bestReasonableCase", "afterPendingMerges", "current"]);
    expect(JSON.stringify(summary)).not.toMatch(/\b(100|200|320)\b/);
  });

  it("uses generic code-keyed blocker phrasing, never raw counts or thresholds", () => {
    const summary = renderScenarioSummary(
      source({
        scenarioPreviews: [
          scenario({
            name: "current",
            source: "current_data",
            blockedBy: [
              blocker("open_pr_threshold", "blocker", "Open PR count 9 exceeds threshold 2."),
              blocker("credibility_floor", "reducer", "Credibility 0.3 is below floor 0.5."),
              blocker("metadata_only", "context", "Preview used metadata-only inputs, so token and density estimates are rough."),
            ],
          }),
        ],
      }),
      { visibility: "public_safe" },
    );
    const blockers = summary.rankedScenarios[0]!.blockers;
    // context-severity blockers are dropped publicly; counts/thresholds never appear.
    expect(blockers).toEqual(["Too many open PRs; land or close some before opening more.", "Contributor track-record evidence is still building."]);
    expect(JSON.stringify(blockers)).not.toMatch(/\b(9|0\.3|0\.5|threshold|floor)\b/);
  });

  it("never emits forbidden public language across all status and scenario combinations", () => {
    const statuses = ["blocked", "hold", "conditionally_scoreable", "scoreable"] as const;
    for (const status of statuses) {
      const summary = renderScenarioSummary(
        source({
          scoreabilityStatus: status,
          recommendation: { level: "hold", actions: ["Build or wait for contributor credibility evidence before relying on this preview."] },
        }),
        { visibility: "public_safe" },
      );
      expect(JSON.stringify(summary), `status "${status}" public summary must be clean`).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    }
  });

  it("sanitizes forbidden language injected through recommendation actions and assumptions", () => {
    const summary = renderScenarioSummary(
      source({
        recommendation: { level: "needs_work", actions: ["Boost your reward estimate and raw trust score"] },
        scenarioPreviews: [scenario({ name: "current", source: "current_data", assumptions: ["Maximize payout via wallet hotkey"] })],
      }),
      { visibility: "public_safe" },
    );
    expect(summary.nextSafeAction).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
    expect(JSON.stringify(summary.rankedScenarios)).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
  });

  it("falls back to a safe default next action when no actions are present", () => {
    const summary = renderScenarioSummary(source({ recommendation: { level: "strong_fit", actions: [] } }), { visibility: "public_safe" });
    expect(summary.nextSafeAction).toBe("No blocking action required; keep validating locally before opening a PR.");
  });
});

describe("renderScenarioSummary private", () => {
  it("renders a private summary snapshot with delta reasons and exact blocker detail", () => {
    const summary = renderScenarioSummary(source(), { visibility: "private" });
    expect(summary).toMatchInlineSnapshot(`
      {
        "generatedAt": "2026-06-03T00:00:00.000Z",
        "nextSafeAction": "Land or close existing open PRs before opening more concurrent work.",
        "rankedScenarios": [
          {
            "assumptions": [
              "Combines plausible near-term gate cleanup.",
            ],
            "blockers": [],
            "label": "Best reasonable near-term case",
            "name": "bestReasonableCase",
            "reasons": [
              "Best case lifts estimated score 100 -> 320.",
            ],
            "source": "gittensory_projection",
          },
          {
            "assumptions": [
              "Assumes 2 pending PRs reach a terminal state.",
            ],
            "blockers": [],
            "label": "After pending PRs merge or close",
            "name": "afterPendingMerges",
            "reasons": [
              "Open PR pressure changes estimated score 100 -> 200.",
            ],
            "source": "github_observed",
          },
          {
            "assumptions": [],
            "blockers": [
              "Open PR count 3 exceeds threshold 2.",
            ],
            "label": "Current state",
            "name": "current",
            "reasons": [
              "Baseline estimated score 100.",
            ],
            "source": "current_data",
          },
        ],
        "repoFullName": "octo/demo",
        "summary": "Conditionally scoreable once the noted conditions are met.",
        "visibility": "private",
      }
    `);
  });

  it("retains exact blocker detail and score deltas private surfaces can plan against", () => {
    const summary = renderScenarioSummary(source(), { visibility: "private" });
    const current = summary.rankedScenarios.find((s) => s.name === "current")!;
    expect(current.blockers).toEqual(["Open PR count 3 exceeds threshold 2."]);
    expect(summary.rankedScenarios.find((s) => s.name === "bestReasonableCase")!.reasons[0]).toMatch(/100 -> 320/);
  });

  it("still scrubs wallet/hotkey/raw-trust language from private blocker and reason text", () => {
    const summary = renderScenarioSummary(
      source({
        scenarioPreviews: [
          scenario({
            name: "current",
            source: "current_data",
            deltaExplanation: "Estimated score with wallet hotkey raw trust score context.",
            blockedBy: [blocker("review_penalty", "reducer", "Reduces estimate; mentions hotkey and wallet.")],
          }),
        ],
      }),
      { visibility: "private" },
    );
    expect(JSON.stringify(summary)).not.toMatch(/wallet|hotkey|raw trust|trust score/i);
  });
});

describe("renderScenarioSummary tie-breaking", () => {
  it("breaks score ties deterministically using the canonical scenario order", () => {
    // Equal scores force the comparator past the score delta into the order tie-breaker:
    // afterPendingMerges precedes afterStalePrsClose in the canonical ranking order.
    const summary = renderScenarioSummary(
      source({
        scenarioPreviews: [
          scenario({ name: "afterStalePrsClose", source: "gittensory_projection", effectiveEstimatedScore: 150 }),
          scenario({ name: "afterPendingMerges", source: "github_observed", effectiveEstimatedScore: 150 }),
        ],
      }),
      { visibility: "public_safe" },
    );
    expect(summary.rankedScenarios.map((s) => s.name)).toEqual(["afterPendingMerges", "afterStalePrsClose"]);
  });

  it("falls back to a stable name comparison when score and order are both equal", () => {
    // Same name and equal score collapse both leading tie-breakers, exercising the final
    // localeCompare fallback so ranking stays deterministic for duplicated previews.
    const summary = renderScenarioSummary(
      source({
        scenarioPreviews: [
          scenario({ name: "current", source: "current_data", effectiveEstimatedScore: 100 }),
          scenario({ name: "current", source: "current_data", effectiveEstimatedScore: 100 }),
        ],
      }),
      { visibility: "public_safe" },
    );
    expect(summary.rankedScenarios.map((s) => s.name)).toEqual(["current", "current"]);
  });
});
