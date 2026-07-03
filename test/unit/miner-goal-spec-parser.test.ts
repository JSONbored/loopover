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

  it("falls back per field for invalid values without throwing", () => {
    const parsed = parseMinerGoalSpec({
      minerEnabled: "yes",
      wantedPaths: "src/**",
      blockedPaths: [123, " dist/** "],
      preferredLabels: [false, "bugfix"],
      blockedLabels: [123, " wontfix "],
      maxConcurrentClaims: "3",
      issueDiscoveryPolicy: "always",
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
      },
      warnings: expect.arrayContaining([
        expect.stringMatching(/minerEnabled/i),
        expect.stringMatching(/wantedPaths/i),
        expect.stringMatching(/blockedPaths/i),
        expect.stringMatching(/preferredLabels/i),
        expect.stringMatching(/blockedLabels/i),
        expect.stringMatching(/maxConcurrentClaims/i),
        expect.stringMatching(/issueDiscoveryPolicy/i),
      ]),
    });
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
