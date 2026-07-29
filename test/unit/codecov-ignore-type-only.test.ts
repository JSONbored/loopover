import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #9810: codecov.yml ignores three engine `types/*.ts` modules because they are pure type declarations —
// zero runtime statements, so v8 instruments nothing and the file reports 0%, exactly the artifact
// `src/env.d.ts` is already ignored for. Adding one field to such a file otherwise fails codecov/patch on
// lines that can never execute.
//
// That reasoning holds ONLY while the files stay declaration-only. An ignore entry that quietly starts
// covering real runtime code is precisely the silent-rot failure this repo keeps finding (the
// validate-no-hand-written-js stale-path lesson), so the claim is enforced rather than trusted.

const TYPE_ONLY_IGNORED_PATHS = [
  "packages/loopover-engine/src/types/manifest-deps-types.ts",
  "packages/loopover-engine/src/types/predicted-gate-types.ts",
  "packages/loopover-engine/src/types/reward-risk-types.ts",
];

/** A top-level runtime declaration — anything v8 could actually execute. Type/interface declarations and
 *  `export type { … }` re-exports compile away entirely and are deliberately not matched. */
const RUNTIME_DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:const|let|var|function|class|enum)\s/m;

describe("codecov ignore list stays honest (#9810)", () => {
  it.each(TYPE_ONLY_IGNORED_PATHS)("%s is still declaration-only", (path) => {
    const source = readFileSync(path, "utf8");
    const offending = source
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => RUNTIME_DECLARATION.test(entry.line));
    // Named in the failure so the fix is obvious: either drop the codecov ignore and cover the new code, or
    // move that code to a module that is measured.
    expect({ path, runtimeDeclarations: offending.map((entry) => `${entry.number}: ${entry.line.trim().slice(0, 60)}`) }).toEqual({
      path,
      runtimeDeclarations: [],
    });
  });

  it("INVARIANT: every path this test claims to guard is actually listed in codecov.yml", () => {
    // Without this, renaming a file in codecov.yml but not here would leave the guard watching nothing —
    // green, and guarding air.
    const codecov = readFileSync("codecov.yml", "utf8");
    for (const path of TYPE_ONLY_IGNORED_PATHS) expect({ path, listed: codecov.includes(`"${path}"`) }).toEqual({ path, listed: true });
  });
});
