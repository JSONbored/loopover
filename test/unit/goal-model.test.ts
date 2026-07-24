// Root-level vitest coverage twin for `packages/loopover-engine/src/goal-model.ts` (#8344).
//
// `computeLaneFit` (and its hand-rolled `compileGlobMatcher`) is live, load-bearing logic consumed by
// `miner-goal-lane-fit.ts` and `opportunity-metadata.ts`, fully exercised by the engine package's own
// `node --test` suite at `packages/loopover-engine/test/goal-model.test.ts`. But that runner is not part of
// the root vitest run Codecov reads `codecov/patch` from, so the module reports as ~0% covered despite being
// genuinely tested (same blind spot as #6250). This twin imports `computeLaneFit` via the engine barrel and
// re-exercises every precedence rule and glob-matcher branch so vitest — and therefore Codecov — sees it too,
// matching the sibling pattern in `test/unit/calibration-dashboard.test.ts`.
import { describe, expect, it } from "vitest";
import { computeLaneFit, DEFAULT_MINER_GOAL_SPEC } from "../../packages/loopover-engine/src/index";
import type { GoalModelInput, MinerGoalSpec } from "../../packages/loopover-engine/src/index";

function baseSpec(overrides: Partial<MinerGoalSpec> = {}): MinerGoalSpec {
  return { ...DEFAULT_MINER_GOAL_SPEC, ...overrides };
}

function input(overrides: Partial<GoalModelInput> = {}): GoalModelInput {
  return {
    candidatePaths: ["src/app.ts"],
    candidateLabels: ["bug"],
    goalSpec: baseSpec(),
    ...overrides,
  };
}

describe("barrel: computeLaneFit is re-exported from the engine entrypoint", () => {
  it("exposes computeLaneFit as a function", () => {
    expect(typeof computeLaneFit).toBe("function");
  });
});

describe("computeLaneFit precedence rules", () => {
  it("rule 1: hard veto on a blocked path returns 0 even when a wanted/preferred match is also present", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["secrets/api-keys.ts"],
        candidateLabels: ["bug"],
        goalSpec: baseSpec({ blockedPaths: ["secrets/**"], wantedPaths: ["secrets/**"], preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(0);
  });

  it("rule 1: hard veto on a blocked label returns 0 even when a wanted/preferred match is also present", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["src/app.ts"],
        candidateLabels: ["do-not-pick"],
        goalSpec: baseSpec({ blockedLabels: ["do-not-pick"], wantedPaths: ["src/**"], preferredLabels: ["do-not-pick"] }),
      }),
    );
    expect(result).toBe(0);
  });

  it("rule 2: neutral 0.5 when neither wantedPaths nor preferredLabels is configured", () => {
    const result = computeLaneFit(input());
    expect(result).toBe(0.5);
  });

  it("rule 3: 0 when at least one preference dimension is configured but none match", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["docs/readme.md"],
        candidateLabels: [],
        goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(0);
  });

  it("rule 4: one active dimension (paths only) that matches scores 1", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["src/app.ts"],
        candidateLabels: [],
        goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
      }),
    );
    expect(result).toBe(1);
  });

  it("rule 4: one active dimension (labels only) that matches scores 1", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: [],
        candidateLabels: ["bug"],
        goalSpec: baseSpec({ preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(1);
  });

  it("rule 4: two active dimensions with only the path matching scores 0.5", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["src/app.ts"],
        candidateLabels: ["unrelated"],
        goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(0.5);
  });

  it("rule 4: two active dimensions with only the label matching scores 0.5", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["docs/readme.md"],
        candidateLabels: ["bug"],
        goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(0.5);
  });

  it("rule 4: two active dimensions both matching scores 1", () => {
    const result = computeLaneFit(
      input({
        candidatePaths: ["src/app.ts"],
        candidateLabels: ["bug"],
        goalSpec: baseSpec({ wantedPaths: ["src/**"], preferredLabels: ["bug"] }),
      }),
    );
    expect(result).toBe(1);
  });
});

describe("computeLaneFit glob matcher (compileGlobMatcher, reached through path matching)", () => {
  it("plain `*` is a single-segment wildcard that must NOT cross `/`", () => {
    // Matches within a segment...
    expect(
      computeLaneFit(
        input({ candidatePaths: ["src/app.ts"], candidateLabels: [], goalSpec: baseSpec({ wantedPaths: ["src/*.ts"] }) }),
      ),
    ).toBe(1);
    // ...but does not cross a slash.
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src/nested/app.ts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/*.ts"] }),
        }),
      ),
    ).toBe(0);
  });

  it("bare `**` crosses `/` (matches any run of chars including slashes)", () => {
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src/deeply/nested/app.ts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
        }),
      ),
    ).toBe(1);
  });

  it("`**/` is an optional directory prefix (zero leading segments)", () => {
    // Zero leading segments: `**/*.ts` still matches a top-level file.
    expect(
      computeLaneFit(
        input({ candidatePaths: ["app.ts"], candidateLabels: [], goalSpec: baseSpec({ wantedPaths: ["**/*.ts"] }) }),
      ),
    ).toBe(1);
    // One or more leading segments also match.
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src/nested/app.ts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["**/*.ts"] }),
        }),
      ),
    ).toBe(1);
  });

  it("`?` matches exactly one non-`/` character", () => {
    expect(
      computeLaneFit(
        input({ candidatePaths: ["src/a.ts"], candidateLabels: [], goalSpec: baseSpec({ wantedPaths: ["src/?.ts"] }) }),
      ),
    ).toBe(1);
    // `?` does not match a slash, so a two-char segment fails a single `?`.
    expect(
      computeLaneFit(
        input({ candidatePaths: ["src/ab.ts"], candidateLabels: [], goalSpec: baseSpec({ wantedPaths: ["src/?.ts"] }) }),
      ),
    ).toBe(0);
  });

  it("regex metacharacters in a pattern (e.g. `.`) are matched literally, not as regex", () => {
    // The literal `.` must match a literal dot...
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src/app.ts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/app.ts"] }),
        }),
      ),
    ).toBe(1);
    // ...and NOT act as regex "any char" (so `axts` must not match `a.ts`).
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src/appXts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/app.ts"] }),
        }),
      ),
    ).toBe(0);
  });

  it("Windows-style backslash paths are normalized to `/` before matching", () => {
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["src\\nested\\app.ts"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
        }),
      ),
    ).toBe(1);
  });

  it("path matching is case-insensitive", () => {
    expect(
      computeLaneFit(
        input({
          candidatePaths: ["SRC/App.TS"],
          candidateLabels: [],
          goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
        }),
      ),
    ).toBe(1);
  });

  it("label matching is case-insensitive", () => {
    expect(
      computeLaneFit(
        input({ candidateLabels: ["BUG"], goalSpec: baseSpec({ preferredLabels: ["bug"] }) }),
      ),
    ).toBe(1);
  });

  it("an empty-string pattern compiles to a matcher that never matches", () => {
    // `wantedPaths: [""]` is a configured (non-empty) preference whose single pattern normalizes to empty,
    // so compileGlobMatcher returns the always-false matcher and no path matches -> rule 3 -> 0.
    const result = computeLaneFit(
      input({
        candidatePaths: ["src/app.ts"],
        candidateLabels: [],
        goalSpec: baseSpec({ wantedPaths: [""] }),
      }),
    );
    expect(result).toBe(0);
  });

  it("an empty-string candidate path is skipped by the matcher (does not match a `**` pattern)", () => {
    // The empty candidate path is evaluated first and rejected by the matcher's own empty-path guard; the
    // real path that follows still matches, so the dimension scores.
    const result = computeLaneFit(
      input({
        candidatePaths: ["", "src/app.ts"],
        candidateLabels: [],
        goalSpec: baseSpec({ wantedPaths: ["src/**"] }),
      }),
    );
    expect(result).toBe(1);
  });
});
