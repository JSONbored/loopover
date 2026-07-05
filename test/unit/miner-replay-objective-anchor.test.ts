import { describe, expect, it } from "vitest";
import {
  CHANGE_KINDS,
  CHANGE_KIND_WEIGHT,
  MODULE_OVERLAP_WEIGHT,
  classifyChangeKind,
  computeObjectiveAnchor,
  extractReplayTargetFeatures,
  extractRevealedFeatures,
  scoreObjectiveAnchor,
} from "../../packages/gittensory-miner/lib/replay-objective-anchor.js";

describe("gittensory-miner replay objective-anchor scoring (#3012)", () => {
  it("exposes a frozen change-kind vocabulary and weights that sum to 1", () => {
    expect(Object.isFrozen(CHANGE_KINDS)).toBe(true);
    expect(CHANGE_KINDS).toContain("feature");
    expect(CHANGE_KINDS).toContain("other");
    expect(MODULE_OVERLAP_WEIGHT + CHANGE_KIND_WEIGHT).toBe(1);
  });

  describe("classifyChangeKind", () => {
    it("maps Conventional-Commit types (with scope/bang) onto the vocabulary", () => {
      expect(classifyChangeKind("feat(miner): add anchor")).toBe("feature");
      expect(classifyChangeKind("fix: correct overlap")).toBe("fix");
      expect(classifyChangeKind("refactor(engine)!: reshape")).toBe("refactor");
      expect(classifyChangeKind("docs: update readme")).toBe("docs");
      expect(classifyChangeKind("test(unit): more cases")).toBe("test");
      expect(classifyChangeKind("chore!: bump")).toBe("chore");
      expect(classifyChangeKind("perf: speed up")).toBe("perf");
    });

    it("resolves an unknown prefix, a prefix-less subject, and non-strings to 'other'", () => {
      expect(classifyChangeKind("wip: scratch")).toBe("other");
      expect(classifyChangeKind("just a plain title")).toBe("other");
      expect(classifyChangeKind(undefined)).toBe("other");
      expect(classifyChangeKind(42)).toBe("other");
    });
  });

  describe("extractReplayTargetFeatures", () => {
    it("groups paths into sorted, de-duplicated modules and classifies from title", () => {
      const features = extractReplayTargetFeatures({
        pathsTouched: ["src/a/y.ts", "src/a/x.ts", "./src/b/z.ts", "src/a/y.ts"],
        title: "feat(x): thing",
      });
      expect(features.modules).toEqual(["src/a", "src/b"]);
      expect(features.changeKind).toBe("feature");
    });

    it("treats a bare filename as its own module and honors an explicit changeKind over the title", () => {
      const features = extractReplayTargetFeatures({
        pathsTouched: ["README.md"],
        changeKind: "Docs",
        title: "feat: mislabeled",
      });
      expect(features.modules).toEqual(["README.md"]);
      expect(features.changeKind).toBe("docs"); // explicit (case-insensitive) wins over the title
    });

    it("ignores an out-of-vocabulary explicit changeKind and falls back to the title", () => {
      const features = extractReplayTargetFeatures({
        pathsTouched: ["src/a/x.ts"],
        changeKind: "banana",
        title: "fix: real kind",
      });
      expect(features.changeKind).toBe("fix");
    });

    it("degrades junk and missing input to empty modules and 'other'", () => {
      expect(extractReplayTargetFeatures(null)).toEqual({ modules: [], changeKind: "other" });
      expect(
        extractReplayTargetFeatures({ pathsTouched: ["  ", 7, null, "src/a/x.ts"] }),
      ).toEqual({ modules: ["src/a"], changeKind: "other" });
      expect(extractReplayTargetFeatures({ pathsTouched: "src/a/x.ts" }).modules).toEqual([]);
    });
  });

  describe("extractRevealedFeatures", () => {
    it("unions modules and collects the set of change kinds across many entries", () => {
      const features = extractRevealedFeatures([
        { pathsTouched: ["src/a/x.ts"], title: "feat: one" },
        { pathsTouched: ["src/b/y.ts", "src/a/z.ts"], title: "fix: two" },
      ]);
      expect(features.modules).toEqual(["src/a", "src/b"]);
      expect(features.changeKinds).toEqual(["feature", "fix"]);
    });

    it("tolerates a single object, and skips null/non-object entries", () => {
      expect(extractRevealedFeatures({ pathsTouched: ["src/a/x.ts"], title: "docs: y" })).toEqual({
        modules: ["src/a"],
        changeKinds: ["docs"],
      });
      const features = extractRevealedFeatures([null, 3, { pathsTouched: ["src/a/x.ts"] }]);
      expect(features.modules).toEqual(["src/a"]);
      expect(features.changeKinds).toEqual(["other"]);
    });

    it("returns empty feature sets for empty or nullish history", () => {
      expect(extractRevealedFeatures([])).toEqual({ modules: [], changeKinds: [] });
      expect(extractRevealedFeatures(null)).toEqual({ modules: [], changeKinds: [] });
    });
  });

  describe("scoreObjectiveAnchor", () => {
    it("scores full module + change-kind overlap as 1 with an empty divergence set", () => {
      const result = scoreObjectiveAnchor(
        { modules: ["src/a"], changeKind: "feature" },
        { modules: ["src/a"], changeKinds: ["feature"] },
      );
      expect(result.score).toBe(1);
      expect(result.moduleOverlap).toBe(1);
      expect(result.changeKindMatch).toBe(1);
      expect(result.sharedModules).toEqual(["src/a"]);
      expect(result.replayOnlyModules).toEqual([]);
      expect(result.revealedOnlyModules).toEqual([]);
    });

    it("floors zero overlap (disjoint modules + unmatched kind) at 0 without throwing", () => {
      const result = scoreObjectiveAnchor(
        { modules: ["src/a"], changeKind: "feature" },
        { modules: ["src/b"], changeKinds: ["fix"] },
      );
      expect(result.score).toBe(0);
      expect(result.moduleOverlap).toBe(0);
      expect(result.changeKindMatch).toBe(0);
      expect(result.sharedModules).toEqual([]);
      expect(result.replayOnlyModules).toEqual(["src/a"]);
      expect(result.revealedOnlyModules).toEqual(["src/b"]);
    });

    it("computes partial module overlap as a Jaccard ratio, weighted with a matched kind", () => {
      const result = scoreObjectiveAnchor(
        { modules: ["src/a", "src/b"], changeKind: "feature" },
        { modules: ["src/a", "src/c"], changeKinds: ["feature"] },
      );
      // shared {src/a}, union {src/a, src/b, src/c} → overlap 1/3; kind matches → 0.7*(1/3) + 0.3
      expect(result.moduleOverlap).toBe(0.3333);
      expect(result.score).toBe(0.5333);
      expect(result.sharedModules).toEqual(["src/a"]);
      expect(result.replayOnlyModules).toEqual(["src/b"]);
      expect(result.revealedOnlyModules).toEqual(["src/c"]);
    });

    it("separates the module and change-kind contributions (overlap with a mismatched kind)", () => {
      const result = scoreObjectiveAnchor(
        { modules: ["src/a"], changeKind: "feature" },
        { modules: ["src/a"], changeKinds: ["fix"] },
      );
      expect(result.moduleOverlap).toBe(1);
      expect(result.changeKindMatch).toBe(0);
      expect(result.score).toBe(MODULE_OVERLAP_WEIGHT); // 0.7 from modules only
    });

    it("floors both-empty feature sets at 0 rather than dividing by zero", () => {
      const result = scoreObjectiveAnchor({ modules: [] }, { modules: [], changeKinds: [] });
      expect(result.moduleOverlap).toBe(0);
      expect(result.score).toBe(0);
      expect(result.replayChangeKind).toBe("other");
    });

    it("normalizes malformed feature inputs (non-array modules, out-of-vocab kinds) defensively", () => {
      const result = scoreObjectiveAnchor(
        { modules: "src/a", changeKind: "banana" },
        { modules: [7, "src/a"], changeKinds: ["banana", "feature"] },
      );
      expect(result.replayChangeKind).toBe("other");
      expect(result.revealedChangeKinds).toEqual(["feature"]); // "banana" dropped as out-of-vocab
      expect(result.replayOnlyModules).toEqual([]); // replay modules coerced to []
      expect(result.revealedOnlyModules).toEqual(["src/a"]);
    });
  });

  describe("computeObjectiveAnchor", () => {
    it("extracts both sides, scores them, and logs the extracted features for audit", () => {
      const result = computeObjectiveAnchor({
        replayPlan: { pathsTouched: ["src/a/x.ts"], title: "feat: build the thing" },
        revealedHistory: [
          { pathsTouched: ["src/a/y.ts"], title: "feat: shipped the thing" },
          { pathsTouched: ["src/b/z.ts"], title: "docs: mention it" },
        ],
      });
      expect(result.replayFeatures).toEqual({ modules: ["src/a"], changeKind: "feature" });
      expect(result.revealedFeatures).toEqual({
        modules: ["src/a", "src/b"],
        changeKinds: ["docs", "feature"],
      });
      // shared {src/a}, union {src/a, src/b} → 1/2; kind "feature" present → 0.7*0.5 + 0.3
      expect(result.score).toBe(0.65);
    });

    it("floors a replay that targets modules the revealed history never touches", () => {
      const result = computeObjectiveAnchor({
        replayPlan: { pathsTouched: ["src/ghost/x.ts"], title: "feat: guess" },
        revealedHistory: [{ pathsTouched: ["src/real/y.ts"], title: "fix: actual" }],
      });
      expect(result.score).toBe(0);
      expect(result.sharedModules).toEqual([]);
    });

    it("is byte-for-byte reproducible across repeated runs on the same inputs", () => {
      const input = {
        replayPlan: { pathsTouched: ["src/a/x.ts", "src/b/y.ts"], changeKind: "refactor" },
        revealedHistory: [{ pathsTouched: ["src/a/z.ts"], changeKind: "refactor" }],
      };
      expect(computeObjectiveAnchor(input)).toEqual(computeObjectiveAnchor(input));
    });

    it("floors a fully empty run at 0 without error", () => {
      expect(computeObjectiveAnchor(null).score).toBe(0);
      expect(computeObjectiveAnchor({}).score).toBe(0);
    });
  });
});
