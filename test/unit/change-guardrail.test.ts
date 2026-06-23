import { describe, expect, it } from "vitest";
import { changedPathsHittingGuardrail, matchesAny } from "../../src/signals/change-guardrail";

describe("change-guardrail glob matching", () => {
  it("`**` matches across path separators (a guarded dir guards its whole subtree)", () => {
    expect(matchesAny("scripts/foo/bar.sh", ["scripts/**"])).toBe(true);
    expect(matchesAny("scripts/build.mjs", ["scripts/**"])).toBe(true);
    expect(matchesAny(".github/workflows/ci.yml", [".github/workflows/**"])).toBe(true);
    expect(matchesAny("src/scoring/deep/nested/model.ts", ["src/scoring/**"])).toBe(true);
  });

  it("`**/` also matches zero segments (the dir root itself)", () => {
    expect(matchesAny("packages/index.ts", ["packages/**"])).toBe(true);
  });

  it("`*` matches only within a single segment", () => {
    expect(matchesAny("src/auth.ts", ["src/*.ts"])).toBe(true);
    expect(matchesAny("src/auth/session.ts", ["src/*.ts"])).toBe(false);
  });

  it("does not match unrelated paths", () => {
    expect(matchesAny("docs/readme.md", ["scripts/**", "src/scoring/**"])).toBe(false);
    expect(matchesAny("src/ui/button.tsx", ["src/scoring/**", "src/auth/**"])).toBe(false);
  });

  it("changedPathsHittingGuardrail returns the offending paths (empty globs ⇒ no hits)", () => {
    const globs = ["src/scoring/**", "scripts/**"];
    expect(changedPathsHittingGuardrail(["docs/a.md", "src/scoring/x.ts", "scripts/y.mjs"], globs)).toEqual(["src/scoring/x.ts", "scripts/y.mjs"]);
    expect(changedPathsHittingGuardrail(["docs/a.md", "src/ui/b.tsx"], globs)).toEqual([]);
    expect(changedPathsHittingGuardrail(["src/scoring/x.ts"], [])).toEqual([]);
  });
});
