import { describe, expect, it } from "vitest";
import { changedPathsHittingGuardrail, isGuardrailHit, matchesAny } from "../../src/signals/change-guardrail";

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

  it("matches case-insensitively and canonicalizes `./`, leading `/`, and `\\` separators (evasion-proof)", () => {
    expect(matchesAny(".github/Workflows/ci.yml", [".github/workflows/**"])).toBe(true); // capital W
    expect(matchesAny("Scripts/Deploy.SH", ["scripts/**"])).toBe(true); // mixed case path
    expect(matchesAny("scripts/build.mjs", ["Scripts/**"])).toBe(true); // mixed case glob
    expect(matchesAny("./scripts/build.mjs", ["scripts/**"])).toBe(true); // leading ./
    expect(matchesAny("/scripts/build.mjs", ["scripts/**"])).toBe(true); // leading /
    expect(matchesAny("scripts\\win\\build.ps1", ["scripts/**"])).toBe(true); // backslash separators
    expect(matchesAny("src/a/deep/model.ts", ["src/**/model.ts"])).toBe(true); // mid-path `**/` consumes the separator
    expect(changedPathsHittingGuardrail([".github/Workflows/deploy.yml"], [".github/workflows/**"])).toEqual([".github/Workflows/deploy.yml"]);
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

  it("isGuardrailHit: boolean form shared by the disposition + the comment (#guarded-hold-comment)", () => {
    const globs = ["src/scoring/**", "scripts/**"];
    // No guardrails configured ⇒ never a hit (permissive).
    expect(isGuardrailHit(["src/scoring/x.ts"], [])).toBe(false);
    expect(isGuardrailHit([], [])).toBe(false);
    // A changed path that hits a guarded glob ⇒ hit.
    expect(isGuardrailHit(["docs/a.md", "scripts/y.mjs"], globs)).toBe(true);
    // No changed path hits ⇒ not a hit.
    expect(isGuardrailHit(["docs/a.md", "src/ui/b.tsx"], globs)).toBe(false);
    // FAIL-SAFE (#1062): guardrails configured but the changed-file set is empty (unknown) ⇒ treat as a hit.
    expect(isGuardrailHit([], globs)).toBe(true);
  });
});

// #flood-readiness: the LIVE gittensory KV globs must guard crucial files that live OUTSIDE the dir-prefix
// guards (the awesome-claude #4196 class — a weakened sensitive file slipping through because its folder
// wasn't covered), while leaving clean non-crucial PRs auto-mergeable. Mirrors REVIEW_CONFIG["gittensory"].
describe("hard-guardrail covers content-crucial files outside the dir-prefix guards", () => {
  const GITTENSORY_GLOBS = [
    ".github/**", "scripts/**", "packages/**", "apps/gittensory-ui/**",
    "src/scoring/**", "src/signals/**", "src/rules/**", "src/gittensor/**", "src/auth/**",
    "src/upstream/**", "src/settings/**", "src/review/**", "src/services/**", "src/github/**", "src/config/**",
  ];

  it("guards crucial files in non-obvious folders (scoring/auth/rules/gate/reviewer)", () => {
    for (const p of [
      "src/services/score-breakdown.ts", // scoring logic under services/
      "src/services/ai-review.ts", // the reviewer engine (#4196 class)
      "src/settings/command-authorization.ts", // authorization under settings/
      "src/settings/agent-actions.ts", // the merge/close decision planner
      "src/upstream/ruleset.ts", // rules under upstream/
      "src/upstream/unmodeled-scoring-drift.ts", // scoring drift under upstream/
      "src/review/guardrail-config.ts", // the guardrail loader itself
      "src/github/backfill.ts", // CI aggregation that gates merges
      "src/config/gittensory-repo-focus-manifest.ts", // scoring focus config
    ]) {
      expect(changedPathsHittingGuardrail([p], GITTENSORY_GLOBS)).toEqual([p]);
    }
  });

  it("still lets clean non-crucial PRs auto-merge (infra/data/registry/docs/tests)", () => {
    const nonCrucial = ["src/utils/json.ts", "src/db/repositories.ts", "src/registry/normalize.ts", "src/mcp/server.ts", "README.md", "docs/x.md", "test/unit/foo.test.ts"];
    expect(changedPathsHittingGuardrail(nonCrucial, GITTENSORY_GLOBS)).toEqual([]);
  });

  it("the fail-closed sentinel ['**'] guards every path (KV-outage hold-all)", () => {
    for (const p of ["src/utils/json.ts", "README.md", "anything/at/all.txt"]) {
      expect(matchesAny(p, ["**"])).toBe(true);
    }
  });
});
