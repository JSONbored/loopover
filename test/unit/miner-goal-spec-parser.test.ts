import { describe, expect, it } from "vitest";
import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpec,
  parseMinerGoalSpecContent,
} from "../../packages/gittensory-engine/src/index";

describe("MinerGoalSpec parser (#2301)", () => {
  it("re-exports the parser API from the engine barrel", () => {
    expect(typeof parseMinerGoalSpec).toBe("function");
    expect(typeof parseMinerGoalSpecContent).toBe("function");
  });

  it("treats missing raw input as an absent safe-default spec", () => {
    for (const raw of [undefined, null]) {
      expect(parseMinerGoalSpec(raw)).toEqual({
        present: false,
        spec: DEFAULT_MINER_GOAL_SPEC,
        warnings: [],
      });
    }
  });

  it.each([
    "not a mapping",
    ["still", "not", "a", "mapping"],
  ])("degrades malformed top-level raw values to safe defaults: %j", (raw) => {
    const parsed = parseMinerGoalSpec(raw);
    expect(parsed.present).toBe(false);
    expect(parsed.spec).toEqual(DEFAULT_MINER_GOAL_SPEC);
    expect(parsed.warnings.join(" ")).toMatch(/must be a mapping/i);
  });

  it("normalizes valid goal fields, dedupes strings, truncates long entries, and floors claims", () => {
    const longEntry = "x".repeat(300);
    const parsed = parseMinerGoalSpec({
      minerEnabled: false,
      wantedPaths: ["src/**", " src/** ", "", "docs/**"],
      blockedPaths: ["dist/**", longEntry],
      preferredLabels: ["help wanted", "help wanted", "gittensor:feature"],
      blockedLabels: ["duplicate", " duplicate "],
      maxConcurrentClaims: 2.9,
      issueDiscoveryPolicy: "encouraged",
      feasibilityGate: { enabled: false, suppressedReasons: ["duplicate_cluster_high", "duplicate_cluster_high"] },
    });

    expect(parsed).toEqual({
      present: true,
      spec: {
        minerEnabled: false,
        wantedPaths: ["src/**", "docs/**"],
        blockedPaths: ["dist/**", longEntry.slice(0, 256)],
        preferredLabels: ["help wanted", "gittensor:feature"],
        blockedLabels: ["duplicate"],
        maxConcurrentClaims: 2,
        issueDiscoveryPolicy: "encouraged",
        feasibilityGate: { enabled: false, suppressedReasons: ["duplicate_cluster_high"] },
        selfPlagiarism: { similarityThreshold: 0.85 },
      },
      warnings: ['MinerGoalSpec field "blockedPaths" truncated an over-long entry.'],
    });
  });

  it("caps oversized string lists and ignores extra entries", () => {
    const wantedPaths = Array.from({ length: 101 }, (_, index) => `src/${index}.ts`);
    const parsed = parseMinerGoalSpec({ wantedPaths });

    expect(parsed.present).toBe(true);
    expect(parsed.spec.wantedPaths).toHaveLength(100);
    expect(parsed.spec.wantedPaths.at(0)).toBe("src/0.ts");
    expect(parsed.spec.wantedPaths.at(-1)).toBe("src/99.ts");
    expect(parsed.warnings.join(" ")).toMatch(/exceeded 100 entries/i);
  });

  it("accepts exactly 100 unique entries without a cap warning", () => {
    const wantedPaths = Array.from({ length: 100 }, (_, index) => `src/${index}.ts`);
    const parsed = parseMinerGoalSpec({ wantedPaths });

    expect(parsed.present).toBe(true);
    expect(parsed.spec.wantedPaths).toEqual(wantedPaths);
    expect(parsed.warnings.join(" ")).not.toMatch(/exceeded 100 entries/i);
  });

  it("bounds inspection of a hostile all-non-string list instead of scanning it in full", () => {
    // Regression: the cap used to be checked only after a candidate was accepted (duplicate-check-adjacent),
    // so an array of entries that ALWAYS take the `continue` path (non-string, duplicate, or empty-after-trim)
    // never hit the cap and got fully scanned -- unbounded CPU/memory work and unbounded warnings for a hostile
    // input. The cap must now be checked against the raw index, before any per-entry work. `minerEnabled: false`
    // keeps the spec "present" regardless of what wantedPaths ends up as, so these assertions stay focused on
    // the list cap rather than incidentally exercising the separate all-fields-default fallback.
    const wantedPaths = Array.from({ length: 1_000 }, () => null);
    const parsed = parseMinerGoalSpec({ minerEnabled: false, wantedPaths });

    expect(parsed.spec.wantedPaths).toEqual([]);
    expect(parsed.warnings).toHaveLength(101);
    expect(parsed.warnings.at(-1)).toMatch(/exceeded 100 entries/);
  });

  it("bounds inspection of a hostile all-duplicate or all-empty list to a single cap warning", () => {
    const duplicates = parseMinerGoalSpec({
      minerEnabled: false,
      wantedPaths: Array.from({ length: 1_000 }, () => "src/**"),
    });
    expect(duplicates.spec.wantedPaths).toEqual(["src/**"]);
    expect(duplicates.warnings).toEqual(['MinerGoalSpec field "wantedPaths" exceeded 100 entries; extra entries ignored.']);

    const empty = parseMinerGoalSpec({
      minerEnabled: false,
      wantedPaths: Array.from({ length: 1_000 }, () => "   "),
    });
    expect(empty.spec.wantedPaths).toEqual([]);
    expect(empty.warnings).toEqual(['MinerGoalSpec field "wantedPaths" exceeded 100 entries; extra entries ignored.']);
  });

  it("bounds inspection of a hostile all-overlong list, even though each inspected entry still warns once", () => {
    // Different from the duplicate/empty case: an overlong entry is TRUNCATED (with its own warning), not
    // silently dropped, so every one of the 100 inspected entries produces a truncation warning before the
    // post-truncation duplicate check collapses them into one result entry. Still bounded to exactly
    // 100 truncate warnings + 1 cap warning, never proportional to the input's true length.
    const wantedPaths = Array.from({ length: 1_000 }, () => "x".repeat(300));
    const parsed = parseMinerGoalSpec({ minerEnabled: false, wantedPaths });

    expect(parsed.spec.wantedPaths).toEqual(["x".repeat(256)]);
    expect(parsed.warnings).toHaveLength(101);
    expect(parsed.warnings.at(-1)).toMatch(/exceeded 100 entries/);
  });

  it("falls back per field for invalid values without throwing", () => {
    const parsed = parseMinerGoalSpec({
      minerEnabled: "yes",
      wantedPaths: "src/**",
      blockedPaths: [123, " dist/** "],
      preferredLabels: [false, "bugfix"],
      blockedLabels: [123, " wontfix "],
      maxConcurrentClaims: "3",
      issueDiscoveryPolicy: "always",
      feasibilityGate: "not a mapping",
    });

    expect(parsed).toEqual({
      present: true,
      spec: {
        minerEnabled: true,
        wantedPaths: [],
        blockedPaths: ["dist/**"],
        preferredLabels: ["bugfix"],
        blockedLabels: ["wontfix"],
        maxConcurrentClaims: 1,
        issueDiscoveryPolicy: "neutral",
        feasibilityGate: { enabled: true, suppressedReasons: [] },
        selfPlagiarism: { similarityThreshold: 0.85 },
      },
      warnings: expect.arrayContaining([
        expect.stringMatching(/minerEnabled/i),
        expect.stringMatching(/wantedPaths/i),
        expect.stringMatching(/blockedPaths/i),
        expect.stringMatching(/preferredLabels/i),
        expect.stringMatching(/blockedLabels/i),
        expect.stringMatching(/maxConcurrentClaims/i),
        expect.stringMatching(/issueDiscoveryPolicy/i),
        expect.stringMatching(/feasibilityGate/i),
      ]),
    });
  });

  it("normalizes nested feasibilityGate sub-fields independently and rejects a non-mapping value", () => {
    const validSubFields = parseMinerGoalSpec({
      wantedPaths: ["src/**"],
      feasibilityGate: { enabled: false, suppressedReasons: ["duplicate_cluster_high"] },
    });
    expect(validSubFields.spec.feasibilityGate).toEqual({
      enabled: false,
      suppressedReasons: ["duplicate_cluster_high"],
    });
    expect(validSubFields.warnings).toEqual([]);

    const malformedSubFields = parseMinerGoalSpec({
      wantedPaths: ["src/**"],
      feasibilityGate: { enabled: "nope", suppressedReasons: "not a list" },
    });
    expect(malformedSubFields.spec.feasibilityGate).toEqual({ enabled: true, suppressedReasons: [] });
    expect(malformedSubFields.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/feasibilityGate\.enabled/i),
        expect.stringMatching(/feasibilityGate\.suppressedReasons/i),
      ]),
    );

    const arrayValue = parseMinerGoalSpec({ wantedPaths: ["src/**"], feasibilityGate: ["not", "a", "mapping"] });
    expect(arrayValue.spec.feasibilityGate).toEqual({ enabled: true, suppressedReasons: [] });
    expect(arrayValue.warnings.join(" ")).toMatch(/feasibilityGate.*must be a mapping/i);
  });

  it("a feasibilityGate policy alone (all other fields default) marks the spec present", () => {
    const parsed = parseMinerGoalSpec({ feasibilityGate: { enabled: false, suppressedReasons: [] } });
    expect(parsed.present).toBe(true);
    expect(parsed.spec.feasibilityGate).toEqual({ enabled: false, suppressedReasons: [] });

    const suppressedOnly = parseMinerGoalSpec({ feasibilityGate: { suppressedReasons: ["issue_missing"] } });
    expect(suppressedOnly.present).toBe(true);
    expect(suppressedOnly.spec.feasibilityGate).toEqual({ enabled: true, suppressedReasons: ["issue_missing"] });
  });

  it("a selfPlagiarism policy alone (all other fields default) marks the spec present", () => {
    const parsed = parseMinerGoalSpec({ selfPlagiarism: { similarityThreshold: 0.9 } });
    expect(parsed.present).toBe(true);
    expect(parsed.spec.selfPlagiarism).toEqual({ similarityThreshold: 0.9 });
  });

  it("normalizes nested selfPlagiarism sub-fields and rejects a non-mapping value", () => {
    const malformed = parseMinerGoalSpec({
      wantedPaths: ["src/**"],
      selfPlagiarism: { similarityThreshold: "not-a-number" },
    });
    expect(malformed.spec.selfPlagiarism).toEqual({ similarityThreshold: 0.85 });
    expect(malformed.warnings.join(" ")).toMatch(/selfPlagiarism\.similarityThreshold/i);

    const arrayValue = parseMinerGoalSpec({ wantedPaths: ["src/**"], selfPlagiarism: ["not", "a", "mapping"] });
    expect(arrayValue.spec.selfPlagiarism).toEqual({ similarityThreshold: 0.85 });
    expect(arrayValue.warnings.join(" ")).toMatch(/selfPlagiarism.*must be a mapping/i);
  });

  it("rejects claim counts below one after flooring", () => {
    const parsed = parseMinerGoalSpec({
      wantedPaths: ["src/**"],
      maxConcurrentClaims: 0.9,
    });

    expect(parsed.present).toBe(true);
    expect(parsed.spec.maxConcurrentClaims).toBe(1);
    expect(parsed.warnings.join(" ")).toMatch(/must be >= 1 after flooring/i);
  });

  it("marks unknown-only and explicit-default configs as absent", () => {
    expect(parseMinerGoalSpec({ mystery: true })).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ['MinerGoalSpec contained no recognized non-default goal fields; falling back to safe defaults.'],
    });

    expect(
      parseMinerGoalSpec({
        minerEnabled: true,
        wantedPaths: [],
        blockedPaths: [],
        preferredLabels: [],
        blockedLabels: [],
        maxConcurrentClaims: 1,
        issueDiscoveryPolicy: "neutral",
        feasibilityGate: { enabled: true, suppressedReasons: [] },
        selfPlagiarism: { similarityThreshold: 0.85 },
      }),
    ).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ['MinerGoalSpec contained no recognized non-default goal fields; falling back to safe defaults.'],
    });
  });

  it("parses valid JSON and YAML content", () => {
    expect(
      parseMinerGoalSpecContent(
        JSON.stringify({
          wantedPaths: ["src/**"],
          preferredLabels: ["gittensor:feature"],
          maxConcurrentClaims: 3,
        }),
      ),
    ).toEqual({
      present: true,
      spec: {
        ...DEFAULT_MINER_GOAL_SPEC,
        wantedPaths: ["src/**"],
        preferredLabels: ["gittensor:feature"],
        maxConcurrentClaims: 3,
      },
      warnings: [],
    });

    expect(
      parseMinerGoalSpecContent(
        "minerEnabled: false\nblockedPaths:\n  - dist/**\nissueDiscoveryPolicy: discouraged\n",
      ),
    ).toEqual({
      present: true,
      spec: {
        ...DEFAULT_MINER_GOAL_SPEC,
        minerEnabled: false,
        blockedPaths: ["dist/**"],
        issueDiscoveryPolicy: "discouraged",
      },
      warnings: [],
    });

    expect(
      parseMinerGoalSpecContent(
        "feasibilityGate:\n  enabled: false\n  suppressedReasons:\n    - duplicate_cluster_high\n",
      ),
    ).toEqual({
      present: true,
      spec: {
        ...DEFAULT_MINER_GOAL_SPEC,
        feasibilityGate: { enabled: false, suppressedReasons: ["duplicate_cluster_high"] },
      },
      warnings: [],
    });
  });

  it("treats empty, malformed, non-mapping, and oversized content as absent", () => {
    for (const value of ["", "   ", null, undefined]) {
      expect(parseMinerGoalSpecContent(value)).toEqual({
        present: false,
        spec: DEFAULT_MINER_GOAL_SPEC,
        warnings: [],
      });
    }

    expect(parseMinerGoalSpecContent("{ invalid json")).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content was not valid JSON; ignoring it and falling back to safe defaults."],
    });

    expect(parseMinerGoalSpecContent("wantedPaths: [unterminated")).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content was not valid YAML; ignoring it and falling back to safe defaults."],
    });

    expect(parseMinerGoalSpecContent('["src/**"]')).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: [
        "MinerGoalSpec must be a mapping of fields; ignoring malformed config and falling back to safe defaults.",
      ],
    });

    expect(parseMinerGoalSpecContent(`wantedPaths:\n  - ${"x".repeat(40_000)}\n`)).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content exceeded 32768 bytes; ignoring it and falling back to safe defaults."],
    });

    expect(parseMinerGoalSpecContent(`wantedPaths:\n  - ${"好".repeat(12_000)}\n`)).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content exceeded 32768 bytes; ignoring it and falling back to safe defaults."],
    });

    expect(parseMinerGoalSpecContent(`wantedPaths:\n  - ${"é".repeat(17_000)}\n`)).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content exceeded 32768 bytes; ignoring it and falling back to safe defaults."],
    });

    expect(parseMinerGoalSpecContent(`wantedPaths:\n  - ${"🙂".repeat(9_000)}\n`)).toEqual({
      present: false,
      spec: DEFAULT_MINER_GOAL_SPEC,
      warnings: ["MinerGoalSpec content exceeded 32768 bytes; ignoring it and falling back to safe defaults."],
    });
  });
});
