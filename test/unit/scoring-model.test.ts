import { describe, expect, it } from "vitest";
import {
  detectActiveModel,
  findUnmodeledConstantKeys,
  findUnmodeledUpstreamConstants,
  isTimeDecayEnabled,
  parsePythonNumberConstants,
  SCORING_SNAPSHOT_STALE_MS,
  scoringSnapshotStalenessWarning,
} from "../../src/scoring/model";

describe("scoring/model pure exports", () => {
  it("parsePythonNumberConstants parses underscore separators, exponents, and skips non-matching lines", () => {
    const knownOnly = parsePythonNumberConstants(`
# comment line
ignored = "not a constant"
MERGED_PR_BASE_SCORE = 1e-9
CONTRIBUTION_SCORE_FOR_FULL_BONUS = 1_500_000
SRC_TOK_SATURATION_SCALE = 5.8e1
`);
    expect(knownOnly).toEqual({
      MERGED_PR_BASE_SCORE: 1e-9,
      CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1_500_000,
      SRC_TOK_SATURATION_SCALE: 58,
    });

    const allNames = parsePythonNumberConstants(
      `
RATE = 0.000_001
SCALE = 3.14_15
VAL = 1_000.000_5
BARE = .5_0
CUSTOM = 42
`,
      { knownOnly: false },
    );
    expect(allNames).toEqual({
      RATE: 0.000001,
      SCALE: 3.1415,
      VAL: 1000.0005,
      BARE: 0.5,
      CUSTOM: 42,
    });
  });

  it("findUnmodeledConstantKeys excludes modeled and operational constants and sorts results", () => {
    const allConstants = {
      MERGED_PR_BASE_SCORE: 25,
      EMISSION_SHARE_TOLERANCE: 1e-9,
      DEFAULT_PROGRAMMING_LANGUAGE_WEIGHT: 0.12,
      ZETA: 1,
      ALPHA: 2,
    };
    expect(findUnmodeledConstantKeys(allConstants)).toEqual(["ALPHA", "ZETA"]);
    expect(findUnmodeledConstantKeys(allConstants)).not.toContain("MERGED_PR_BASE_SCORE");
    expect(findUnmodeledConstantKeys(allConstants)).not.toContain("EMISSION_SHARE_TOLERANCE");
    expect(findUnmodeledConstantKeys(allConstants)).not.toContain("DEFAULT_PROGRAMMING_LANGUAGE_WEIGHT");
  });

  it("findUnmodeledUpstreamConstants delegates to the parser with knownOnly disabled", () => {
    expect(
      findUnmodeledUpstreamConstants(`
MERGED_PR_BASE_SCORE = 25
EMISSION_SHARE_TOLERANCE = 1e-9
DEFAULT_PROGRAMMING_LANGUAGE_WEIGHT = 0.12
NOVELTY_BONUS_SCALAR = 3
`),
    ).toEqual(["NOVELTY_BONUS_SCALAR"]);
  });

  it("detectActiveModel resolves saturation, density, and unknown branches", () => {
    expect(detectActiveModel({ SRC_TOK_SATURATION_SCALE: 58 })).toBe("pending_saturation_model");
    expect(
      detectActiveModel({
        MAX_CODE_DENSITY_MULTIPLIER: 1.15,
        MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
      }),
    ).toBe("current_density_model");
    expect(detectActiveModel({})).toBe("unknown");
    expect(
      detectActiveModel({
        SRC_TOK_SATURATION_SCALE: 58,
        MAX_CODE_DENSITY_MULTIPLIER: 1.15,
        MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
      }),
    ).toBe("pending_saturation_model");
  });

  it("scoringSnapshotStalenessWarning is null at the freshness boundary and warns past it", () => {
    const now = Date.parse("2026-06-21T12:00:00.000Z");
    const exactlyAtWindow = new Date(now - SCORING_SNAPSHOT_STALE_MS).toISOString();
    const pastWindow = new Date(now - SCORING_SNAPSHOT_STALE_MS - 1).toISOString();

    expect(scoringSnapshotStalenessWarning({ fetchedAt: exactlyAtWindow }, now)).toBeNull();
    expect(scoringSnapshotStalenessWarning({ fetchedAt: pastWindow }, now)).toMatch(/stale/i);
  });

  it("isTimeDecayEnabled accepts explicit truthy tokens and rejects falsey values", () => {
    const enabled = (value: string) => isTimeDecayEnabled({ SCORING_TIME_DECAY_ENABLED: value } as Env);

    expect(isTimeDecayEnabled({} as Env)).toBe(false);
    expect(enabled("")).toBe(false);
    expect(enabled("false")).toBe(false);
    expect(enabled("no")).toBe(false);
    expect(enabled("off")).toBe(false);

    expect(enabled("1")).toBe(true);
    expect(enabled("true")).toBe(true);
    expect(enabled("TRUE")).toBe(true);
    expect(enabled("yes")).toBe(true);
    expect(enabled("YES")).toBe(true);
    expect(enabled("on")).toBe(true);
    expect(enabled("ON")).toBe(true);
  });
});
