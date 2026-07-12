import { describe, expect, it } from "vitest";
import {
  AMS_POLICY_SPEC_FILENAMES,
  DEFAULT_AMS_POLICY_SPEC,
  parseAmsPolicySpec,
  parseAmsPolicySpecContent,
} from "../../packages/gittensory-engine/src/index";

describe("AmsPolicySpec parser (#5132)", () => {
  it("re-exports the parser API from the engine barrel", () => {
    expect(typeof parseAmsPolicySpec).toBe("function");
    expect(typeof parseAmsPolicySpecContent).toBe("function");
    expect(AMS_POLICY_SPEC_FILENAMES).toEqual([
      ".gittensory-ams.yml",
      ".github/gittensory-ams.yml",
      ".gittensory-ams.json",
      ".github/gittensory-ams.json",
    ]);
  });

  it("treats missing raw input as an absent safe-default spec", () => {
    for (const raw of [undefined, null]) {
      expect(parseAmsPolicySpec(raw)).toEqual({ present: false, spec: DEFAULT_AMS_POLICY_SPEC, warnings: [] });
    }
  });

  it.each(["not a mapping", ["still", "not", "a", "mapping"]])(
    "degrades malformed top-level raw values to safe defaults: %j",
    (raw) => {
      const parsed = parseAmsPolicySpec(raw);
      expect(parsed.present).toBe(false);
      expect(parsed.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
      expect(parsed.warnings.join(" ")).toMatch(/must be a mapping/i);
    },
  );

  it("normalizes every valid field and keeps non-default input present", () => {
    const parsed = parseAmsPolicySpec({
      submissionMode: "enforce",
      slopThreshold: "clean",
      capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
      convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
      maxIterations: 5,
      maxTurnsPerIteration: 10,
    });
    expect(parsed.present).toBe(true);
    expect(parsed.spec).toEqual({
      submissionMode: "enforce",
      slopThreshold: "clean",
      capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
      convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
      maxIterations: 5,
      maxTurnsPerIteration: 10,
    });
    expect(parsed.warnings).toEqual([]);
  });

  it("maxIterations/maxTurnsPerIteration floor to whole counts, allow zero, and reject negative/non-numeric values", () => {
    const floored = parseAmsPolicySpec({ maxIterations: 4.9, maxTurnsPerIteration: 8.2 });
    expect(floored.spec.maxIterations).toBe(4);
    expect(floored.spec.maxTurnsPerIteration).toBe(8);
    expect(floored.warnings).toEqual([]);

    expect(parseAmsPolicySpec({ maxIterations: 0, submissionMode: "enforce" }).spec.maxIterations).toBe(0);

    const negative = parseAmsPolicySpec({ maxIterations: -1 });
    expect(negative.spec.maxIterations).toBe(DEFAULT_AMS_POLICY_SPEC.maxIterations);
    expect(negative.warnings.join(" ")).toMatch(/maxIterations/i);

    const nonNumeric = parseAmsPolicySpec({ maxTurnsPerIteration: "many" });
    expect(nonNumeric.spec.maxTurnsPerIteration).toBe(DEFAULT_AMS_POLICY_SPEC.maxTurnsPerIteration);
    expect(nonNumeric.warnings.join(" ")).toMatch(/maxTurnsPerIteration/i);

    expect(parseAmsPolicySpec({ maxIterations: undefined, submissionMode: "enforce" }).spec.maxIterations).toBe(DEFAULT_AMS_POLICY_SPEC.maxIterations);
  });

  it("reports absent-with-a-warning when every field matches the default (no recognized non-default fields)", () => {
    const parsed = parseAmsPolicySpec({ submissionMode: "observe", slopThreshold: "low" });
    expect(parsed.present).toBe(false);
    expect(parsed.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    expect(parsed.warnings.join(" ")).toMatch(/no recognized non-default policy fields/i);
  });

  it("submissionMode: accepts observe/enforce, rejects other values, and null/undefined fall back silently", () => {
    expect(parseAmsPolicySpec({ submissionMode: "observe", slopThreshold: "clean" }).spec.submissionMode).toBe("observe");
    expect(parseAmsPolicySpec({ submissionMode: "enforce" }).spec.submissionMode).toBe("enforce");
    expect(parseAmsPolicySpec({ submissionMode: null, slopThreshold: "clean" }).spec.submissionMode).toBe(DEFAULT_AMS_POLICY_SPEC.submissionMode);

    const rejected = parseAmsPolicySpec({ submissionMode: "yolo" });
    expect(rejected.spec.submissionMode).toBe(DEFAULT_AMS_POLICY_SPEC.submissionMode);
    expect(rejected.warnings.join(" ")).toMatch(/submissionMode.*observe, enforce/i);
  });

  it("slopThreshold: accepts every band, rejects other values, and null/undefined fall back silently", () => {
    for (const band of ["clean", "low", "elevated", "high"] as const) {
      expect(parseAmsPolicySpec({ slopThreshold: band, submissionMode: "enforce" }).spec.slopThreshold).toBe(band);
    }
    expect(parseAmsPolicySpec({ slopThreshold: undefined, submissionMode: "enforce" }).spec.slopThreshold).toBe(DEFAULT_AMS_POLICY_SPEC.slopThreshold);

    const rejected = parseAmsPolicySpec({ slopThreshold: "spicy" });
    expect(rejected.spec.slopThreshold).toBe(DEFAULT_AMS_POLICY_SPEC.slopThreshold);
    expect(rejected.warnings.join(" ")).toMatch(/slopThreshold.*clean, low, elevated, high/i);
  });

  it("capLimits: normalizes each field independently, rejects negative/non-numeric/non-finite, and rejects a non-mapping value", () => {
    const valid = parseAmsPolicySpec({ capLimits: { budget: 1, turns: 2, elapsedMs: 3 } });
    expect(valid.spec.capLimits).toEqual({ budget: 1, turns: 2, elapsedMs: 3 });
    expect(valid.warnings).toEqual([]);

    expect(parseAmsPolicySpec({ capLimits: { budget: 0 } }).spec.capLimits.budget).toBe(0);

    const negative = parseAmsPolicySpec({ capLimits: { budget: -1 } });
    expect(negative.spec.capLimits.budget).toBe(DEFAULT_AMS_POLICY_SPEC.capLimits.budget);
    expect(negative.warnings.join(" ")).toMatch(/capLimits\.budget/i);

    const nonFinite = parseAmsPolicySpec({ capLimits: { turns: Number.POSITIVE_INFINITY } });
    expect(nonFinite.spec.capLimits.turns).toBe(DEFAULT_AMS_POLICY_SPEC.capLimits.turns);

    const nonNumeric = parseAmsPolicySpec({ capLimits: { elapsedMs: "long time" } });
    expect(nonNumeric.spec.capLimits.elapsedMs).toBe(DEFAULT_AMS_POLICY_SPEC.capLimits.elapsedMs);
    expect(nonNumeric.warnings.join(" ")).toMatch(/capLimits\.elapsedMs/i);

    const missingField = parseAmsPolicySpec({ capLimits: { budget: 1 } });
    expect(missingField.spec.capLimits).toEqual({ budget: 1, turns: DEFAULT_AMS_POLICY_SPEC.capLimits.turns, elapsedMs: DEFAULT_AMS_POLICY_SPEC.capLimits.elapsedMs });

    const arrayValue = parseAmsPolicySpec({ capLimits: ["not", "a", "mapping"] });
    expect(arrayValue.spec.capLimits).toEqual(DEFAULT_AMS_POLICY_SPEC.capLimits);
    expect(arrayValue.warnings.join(" ")).toMatch(/capLimits.*must be a mapping/i);

    expect(parseAmsPolicySpec({ capLimits: null, submissionMode: "enforce" }).spec.capLimits).toEqual(DEFAULT_AMS_POLICY_SPEC.capLimits);
  });

  it("convergenceThresholds: normalizes each field independently and rejects a non-mapping value", () => {
    const valid = parseAmsPolicySpec({ convergenceThresholds: { maxConsecutiveFailures: 1, maxReenqueues: 1 } });
    expect(valid.spec.convergenceThresholds).toEqual({ maxConsecutiveFailures: 1, maxReenqueues: 1 });

    const negative = parseAmsPolicySpec({ convergenceThresholds: { maxConsecutiveFailures: -1 } });
    expect(negative.spec.convergenceThresholds.maxConsecutiveFailures).toBe(DEFAULT_AMS_POLICY_SPEC.convergenceThresholds.maxConsecutiveFailures);
    expect(negative.warnings.join(" ")).toMatch(/convergenceThresholds\.maxConsecutiveFailures/i);

    const arrayValue = parseAmsPolicySpec({ convergenceThresholds: ["nope"] });
    expect(arrayValue.spec.convergenceThresholds).toEqual(DEFAULT_AMS_POLICY_SPEC.convergenceThresholds);
    expect(arrayValue.warnings.join(" ")).toMatch(/convergenceThresholds.*must be a mapping/i);

    expect(parseAmsPolicySpec({ convergenceThresholds: undefined, submissionMode: "enforce" }).spec.convergenceThresholds).toEqual(
      DEFAULT_AMS_POLICY_SPEC.convergenceThresholds,
    );
  });

  it("parseAmsPolicySpecContent: JSON and YAML both parse, malformed/oversized/empty content degrades to safe defaults", () => {
    expect(parseAmsPolicySpecContent(undefined)).toEqual({ present: false, spec: DEFAULT_AMS_POLICY_SPEC, warnings: [] });
    expect(parseAmsPolicySpecContent(null)).toEqual({ present: false, spec: DEFAULT_AMS_POLICY_SPEC, warnings: [] });
    expect(parseAmsPolicySpecContent("")).toEqual({ present: false, spec: DEFAULT_AMS_POLICY_SPEC, warnings: [] });
    expect(parseAmsPolicySpecContent("   ")).toEqual({ present: false, spec: DEFAULT_AMS_POLICY_SPEC, warnings: [] });

    const fromJson = parseAmsPolicySpecContent(JSON.stringify({ submissionMode: "enforce" }));
    expect(fromJson.present).toBe(true);
    expect(fromJson.spec.submissionMode).toBe("enforce");

    const fromYaml = parseAmsPolicySpecContent("submissionMode: enforce\nslopThreshold: clean\n");
    expect(fromYaml.present).toBe(true);
    expect(fromYaml.spec.submissionMode).toBe("enforce");
    expect(fromYaml.spec.slopThreshold).toBe("clean");

    const malformedJson = parseAmsPolicySpecContent("{ not valid json");
    expect(malformedJson.present).toBe(false);
    expect(malformedJson.warnings.join(" ")).toMatch(/not valid JSON/i);

    const malformedYaml = parseAmsPolicySpecContent("submissionMode: [unterminated");
    expect(malformedYaml.present).toBe(false);
    expect(malformedYaml.warnings.join(" ")).toMatch(/not valid YAML/i);

    const oversized = parseAmsPolicySpecContent("submissionMode: enforce\n# padding\n" + "x".repeat(9_000));
    expect(oversized.present).toBe(false);
    expect(oversized.warnings.join(" ")).toMatch(/exceeded/i);

    // Exercises utf8ByteLength's 2/3/4-byte code-point branches (é, €, 😀) -- well under the byte limit, so
    // this is a normal successful parse, not another oversized-content case.
    const withMultiByteChars = parseAmsPolicySpecContent("# café €5 😀\nsubmissionMode: enforce\n");
    expect(withMultiByteChars.present).toBe(true);
    expect(withMultiByteChars.spec.submissionMode).toBe("enforce");
  });
});
