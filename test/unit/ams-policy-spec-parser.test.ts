import { describe, expect, it } from "vitest";
import {
  AMS_POLICY_SPEC_FILENAMES,
  DEFAULT_AMS_POLICY_SPEC,
  parseAmsPolicySpec,
  parseAmsPolicySpecContent,
} from "../../packages/loopover-engine/src/index";

describe("AmsPolicySpec parser (#5132)", () => {
  it("re-exports the parser API from the engine barrel", () => {
    expect(typeof parseAmsPolicySpec).toBe("function");
    expect(typeof parseAmsPolicySpecContent).toBe("function");
    expect(AMS_POLICY_SPEC_FILENAMES).toEqual([
      ".loopover-ams.yml",
      ".github/loopover-ams.yml",
      ".loopover-ams.json",
      ".github/loopover-ams.json",
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
      selfLoopAutonomy: "observe",
      networkAllowlist: { ecosystems: ["npm", "pypi"], extraHosts: ["api.example.com"] },
    });
    expect(parsed.present).toBe(true);
    expect(parsed.spec).toEqual({
      submissionMode: "enforce",
      slopThreshold: "clean",
      capLimits: { budget: 10, turns: 40, elapsedMs: 3_600_000 },
      convergenceThresholds: { maxConsecutiveFailures: 5, maxReenqueues: 2 },
      maxIterations: 5,
      maxTurnsPerIteration: 10,
      selfLoopAutonomy: "observe",
      networkAllowlist: { ecosystems: ["npm", "pypi"], extraHosts: ["api.example.com"] },
      minRankAutotuneEnabled: false,
    });
    expect(parsed.warnings).toEqual([]);
  });

  describe("selfLoopAutonomy (#6559)", () => {
    it("defaults to auto when omitted -- NOT observe, which would change today's behavior", () => {
      // The loop already hands off unconditionally on a clean pass, so an "observe" default would silently
      // stop that for every operator who never set the field. This assertion is the guard on that decision.
      expect(DEFAULT_AMS_POLICY_SPEC.selfLoopAutonomy).toBe("auto");
      expect(parseAmsPolicySpec({}).spec.selfLoopAutonomy).toBe("auto");
      expect(parseAmsPolicySpec({ maxIterations: 5 }).spec.selfLoopAutonomy).toBe("auto");
    });

    // A non-default sibling field rides along on purpose: with ONLY selfLoopAutonomy: "auto" the spec has no
    // non-default field at all, so the parser's own "nothing recognized" warning fires and would drown out
    // whether the level itself parsed cleanly. maxIterations keeps the spec present so this asserts one thing.
    it.each(["observe", "auto_with_approval", "auto"])("accepts the valid level %s", (level) => {
      const parsed = parseAmsPolicySpec({ selfLoopAutonomy: level, maxIterations: 5 });
      expect(parsed.spec.selfLoopAutonomy).toBe(level);
      expect(parsed.warnings).toEqual([]);
    });

    it("marks a non-default level as configured, so the file isn't dismissed as empty", () => {
      // selfLoopAutonomy alone must be enough to make the spec present -- if hasConfiguredPolicyFields missed
      // it, an operator whose only setting is this one would be told their file had nothing recognized in it.
      const parsed = parseAmsPolicySpec({ selfLoopAutonomy: "observe" });
      expect(parsed.present).toBe(true);
      expect(parsed.warnings).toEqual([]);
    });

    it("REGRESSION: the default level does NOT count as configured", () => {
      // The mirror of the case above: hasConfiguredPolicyFields' new clause must not false-positive on the
      // default, or an empty file would suddenly report itself as present.
      const parsed = parseAmsPolicySpec({ selfLoopAutonomy: "auto" });
      expect(parsed.present).toBe(false);
      expect(parsed.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    });

    it("REGRESSION: a zero-field input still returns the full, unmodified default spec", () => {
      const parsed = parseAmsPolicySpec({});
      expect(parsed.present).toBe(false);
      expect(parsed.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    });

    it.each([
      ["an unknown string", "yolo"],
      ["a near-miss level", "auto-with-approval"],
      ["a number", 3],
      ["a boolean", true],
      ["an object", { level: "auto" }],
    ])("falls back to auto with a warning for %s", (_label, value) => {
      const parsed = parseAmsPolicySpec({ selfLoopAutonomy: value, maxIterations: 5 });
      expect(parsed.spec.selfLoopAutonomy).toBe("auto");
      const warning = parsed.warnings.join(" ");
      expect(warning).toMatch(/selfLoopAutonomy/);
      // The warning must name the allowed values, or an operator can't tell what to type instead.
      expect(warning).toMatch(/observe.*auto_with_approval.*auto/);
    });

    it("treats an explicit null as unset rather than invalid", () => {
      // Same reason as above for the sibling field: null must produce NO warning of its own, which is only
      // observable once the spec has something else configured.
      const parsed = parseAmsPolicySpec({ selfLoopAutonomy: null, maxIterations: 5 });
      expect(parsed.spec.selfLoopAutonomy).toBe("auto");
      expect(parsed.warnings).toEqual([]);
    });
  });

  describe("networkAllowlist (#7857)", () => {
    it("defaults to no additions when omitted", () => {
      expect(DEFAULT_AMS_POLICY_SPEC.networkAllowlist).toEqual({ ecosystems: [], extraHosts: [] });
      expect(parseAmsPolicySpec({}).spec.networkAllowlist).toEqual({ ecosystems: [], extraHosts: [] });
    });

    it("accepts every known ecosystem and a valid extra host, marking the spec present", () => {
      const parsed = parseAmsPolicySpec({
        networkAllowlist: {
          ecosystems: ["npm", "pypi", "crates", "go", "rubygems", "packagist", "maven", "nuget"],
          extraHosts: ["api.example.com", "sub.deep.example.co.uk"],
        },
      });
      expect(parsed.present).toBe(true);
      expect(parsed.spec.networkAllowlist).toEqual({
        ecosystems: ["npm", "pypi", "crates", "go", "rubygems", "packagist", "maven", "nuget"],
        extraHosts: ["api.example.com", "sub.deep.example.co.uk"],
      });
      expect(parsed.warnings).toEqual([]);
    });

    it("drops unknown ecosystem entries with a warning but keeps the valid ones", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm", "yolo-registry", "pypi"] } });
      expect(parsed.spec.networkAllowlist.ecosystems).toEqual(["npm", "pypi"]);
      expect(parsed.warnings.join(" ")).toMatch(/networkAllowlist\.ecosystems.*yolo-registry.*npm, pypi, crates/i);
    });

    it("drops duplicate ecosystem entries with a warning, keeping the first occurrence", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm", "npm"] } });
      expect(parsed.spec.networkAllowlist.ecosystems).toEqual(["npm"]);
      expect(parsed.warnings.join(" ")).toMatch(/networkAllowlist\.ecosystems/i);
    });

    it("drops non-string ecosystem entries with a warning", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm", 42, null] } });
      expect(parsed.spec.networkAllowlist.ecosystems).toEqual(["npm"]);
      expect(parsed.warnings.length).toBeGreaterThanOrEqual(2);
    });

    it("caps the raw ecosystems array at the known-ecosystem count instead of processing an unbounded list", () => {
      const raw = Array.from({ length: 100 }, () => "yolo-registry");
      // maxIterations rides along so hasConfiguredPolicyFields is true for a reason unrelated to this list --
      // otherwise every entry dropping leaves the spec fully default, adding an extra "no recognized fields"
      // warning that would confound the exact per-entry-drop count this test is isolating.
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: raw }, maxIterations: 5 });
      expect(parsed.spec.networkAllowlist.ecosystems).toEqual([]);
      // 8 warnings (one per processed, capped entry), not 100 -- proves the slice happened before the loop.
      expect(parsed.warnings.length).toBe(8);
    });

    it("ecosystems: rejects a non-array value with a warning, falling back to defaults", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: "npm" } });
      expect(parsed.spec.networkAllowlist.ecosystems).toEqual([]);
      expect(parsed.warnings.join(" ")).toMatch(/networkAllowlist\.ecosystems.*must be an array/i);
    });

    it("drops malformed extraHosts entries (invalid hostname shape, non-string, duplicate) with a warning each", () => {
      const parsed = parseAmsPolicySpec({
        networkAllowlist: { extraHosts: ["good.example.com", "not a hostname", "-leading-hyphen.com", 7, "good.example.com"] },
      });
      expect(parsed.spec.networkAllowlist.extraHosts).toEqual(["good.example.com"]);
      expect(parsed.warnings.length).toBeGreaterThanOrEqual(3);
    });

    it("caps extraHosts at 50 raw entries instead of processing an unbounded list", () => {
      const raw = Array.from({ length: 200 }, (_, i) => `not valid host ${i}`);
      // Same reasoning as the ecosystems cap test above -- isolates the per-entry-drop count.
      const parsed = parseAmsPolicySpec({ networkAllowlist: { extraHosts: raw }, maxIterations: 5 });
      expect(parsed.spec.networkAllowlist.extraHosts).toEqual([]);
      expect(parsed.warnings.length).toBe(50);
    });

    it("extraHosts: rejects a non-array value with a warning, falling back to defaults", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { extraHosts: { host: "example.com" } } });
      expect(parsed.spec.networkAllowlist.extraHosts).toEqual([]);
      expect(parsed.warnings.join(" ")).toMatch(/networkAllowlist\.extraHosts.*must be an array/i);
    });

    it("resolves each field independently when only one is present", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm"] } });
      expect(parsed.spec.networkAllowlist).toEqual({ ecosystems: ["npm"], extraHosts: [] });
    });

    it("rejects a non-mapping networkAllowlist value and falls back to defaults", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: ["npm"] });
      expect(parsed.spec.networkAllowlist).toEqual(DEFAULT_AMS_POLICY_SPEC.networkAllowlist);
      expect(parsed.warnings.join(" ")).toMatch(/networkAllowlist.*must be a mapping/i);
    });

    it("null/undefined fall back silently, with no warning of their own", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: null, maxIterations: 5 });
      expect(parsed.spec.networkAllowlist).toEqual({ ecosystems: [], extraHosts: [] });
      expect(parsed.warnings).toEqual([]);
    });

    it("marks a non-default allowlist as configured even with no other field set", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm"] } });
      expect(parsed.present).toBe(true);
    });

    it("REGRESSION: an explicitly-empty allowlist does NOT count as configured", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: [], extraHosts: [] } });
      expect(parsed.present).toBe(false);
      expect(parsed.spec).toEqual(DEFAULT_AMS_POLICY_SPEC);
    });

    it("mutating the returned spec's arrays never affects the shared DEFAULT_AMS_POLICY_SPEC singleton (empty input)", () => {
      const parsed = parseAmsPolicySpec({});
      parsed.spec.networkAllowlist.ecosystems.push("npm");
      parsed.spec.networkAllowlist.extraHosts.push("evil.example.com");
      expect(DEFAULT_AMS_POLICY_SPEC.networkAllowlist).toEqual({ ecosystems: [], extraHosts: [] });
    });

    it("REGRESSION: mutating the resolved arrays never affects the shared singleton even when networkAllowlist itself is untouched but a sibling field IS configured", () => {
      // Distinct from the empty-input case above: hasConfiguredPolicyFields is true here (maxIterations
      // differs from default), so this spec is built via the `present: true` return path, NOT
      // cloneDefaultAmsPolicySpec() -- networkAllowlist's own normalizer has to defensively copy on its own,
      // since nothing upstream of it does so on this path.
      const parsed = parseAmsPolicySpec({ maxIterations: 5 });
      parsed.spec.networkAllowlist.ecosystems.push("npm");
      parsed.spec.networkAllowlist.extraHosts.push("evil.example.com");
      expect(DEFAULT_AMS_POLICY_SPEC.networkAllowlist).toEqual({ ecosystems: [], extraHosts: [] });
    });

    it("REGRESSION: same protection when networkAllowlist is a partial object (one field specified, the other's default array must still be copied, not shared)", () => {
      const parsed = parseAmsPolicySpec({ networkAllowlist: { ecosystems: ["npm"] } });
      parsed.spec.networkAllowlist.extraHosts.push("evil.example.com");
      expect(DEFAULT_AMS_POLICY_SPEC.networkAllowlist.extraHosts).toEqual([]);
    });
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

describe("minRankAutotuneEnabled (#8187 gate one)", () => {
  it("defaults OFF, accepts booleans, and warns + falls back on non-boolean values", () => {
    expect(DEFAULT_AMS_POLICY_SPEC.minRankAutotuneEnabled).toBe(false);
    expect(parseAmsPolicySpec({}).spec.minRankAutotuneEnabled).toBe(false);
    const on = parseAmsPolicySpec({ minRankAutotuneEnabled: true });
    expect(on.spec.minRankAutotuneEnabled).toBe(true);
    expect(on.present).toBe(true); // a non-default flag counts as configured
    const bad = parseAmsPolicySpec({ minRankAutotuneEnabled: "yes" });
    expect(bad.spec.minRankAutotuneEnabled).toBe(false);
    expect(bad.warnings.some((w) => w.includes("minRankAutotuneEnabled"))).toBe(true);
  });
});
