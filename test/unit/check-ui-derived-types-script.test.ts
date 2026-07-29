import { describe, expect, it } from "vitest";
import { findDerivedTypeViolations, sharedTypeNames } from "../../scripts/check-ui-derived-types";

// #9282/#9521: the drift check that stops a hand-authored API interface from reappearing in the UI once
// the pilot migrated PublicStats/PublicRulePrecision to z.infer. The original duplicate drifted for months
// with nothing failing, so the check itself gets the same scrutiny as the migration.

const SHARED_MODULE = "packages/loopover-contract/src/public-api.ts";
const PILOT = "apps/loopover-ui/src/components/site/proof-of-power-stats-model.ts";

const SHARED_SOURCE = `
import { z } from "zod";
export const PublicRulePrecisionSchema = z.object({ windowDays: z.number() });
export type PublicRulePrecision = z.infer<typeof PublicRulePrecisionSchema>;
export const PublicStatsSchema = z.object({ updatedAt: z.string() });
export type PublicStats = z.infer<typeof PublicStatsSchema>;
`;

const DERIVED_PILOT = `
import type { PublicStatsSchema } from "@loopover/contract/public-api";
export type PublicStats = z.infer<typeof PublicStatsSchema>;
`;

function check(files: Record<string, string>, sharedSource = SHARED_SOURCE) {
  const all: Record<string, string> = { [SHARED_MODULE]: sharedSource, [PILOT]: DERIVED_PILOT, ...files };
  return findDerivedTypeViolations({
    readFile: (path) => all[path] ?? "",
    listUiFiles: () => Object.keys(all).filter((path) => path !== SHARED_MODULE),
  });
}

describe("sharedTypeNames", () => {
  it("collects both the exported type aliases and the names behind each *Schema const", () => {
    expect(sharedTypeNames(SHARED_SOURCE)).toEqual(["PublicRulePrecision", "PublicStats"]);
  });

  it("ignores a non-exported declaration and a const that is not a schema", () => {
    expect(sharedTypeNames("type Internal = { a: 1 };\nexport const LIMIT = 5;\n")).toEqual([]);
  });
});

describe("findDerivedTypeViolations", () => {
  it("passes when the UI derives every shared shape", () => {
    expect(check({})).toEqual([]);
  });

  it("flags a hand-authored `type X = {` that shadows a shared name", () => {
    const violations = check({ "apps/loopover-ui/src/components/site/rogue.ts": "type PublicStats = { updatedAt: string };\n" });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "apps/loopover-ui/src/components/site/rogue.ts", typeName: "PublicStats" });
    expect(violations[0]!.reason).toContain("z.infer");
  });

  it("flags a hand-authored `interface X` too, which is the other spelling of the same duplicate", () => {
    const violations = check({ "apps/loopover-ui/src/components/site/rogue.ts": "export interface PublicRulePrecision { windowDays: number }\n" });
    expect(violations.map((violation) => violation.typeName)).toEqual(["PublicRulePrecision"]);
  });

  it("does NOT flag the derived forms — z.infer, or a type re-export", () => {
    expect(
      check({
        "apps/loopover-ui/src/components/site/a.ts": "export type PublicStats = z.infer<typeof PublicStatsSchema>;\n",
        "apps/loopover-ui/src/components/site/b.ts": 'export type { PublicRulePrecision } from "@loopover/contract/public-api";\n',
      }),
    ).toEqual([]);
  });

  it("does NOT flag an unrelated local type that merely mentions a shared name", () => {
    expect(check({ "apps/loopover-ui/src/components/site/c.ts": "type PublicStatsProps = { stats: PublicStats };\n" })).toEqual([]);
  });

  it("reports every offending file, sorted, rather than stopping at the first", () => {
    const violations = check({
      "apps/loopover-ui/src/components/site/z.ts": "type PublicStats = { updatedAt: string };\n",
      "apps/loopover-ui/src/components/site/a.ts": "interface PublicRulePrecision { windowDays: number }\n",
    });
    expect(violations.map((violation) => violation.file)).toEqual([
      "apps/loopover-ui/src/components/site/a.ts",
      "apps/loopover-ui/src/components/site/z.ts",
    ]);
  });

  it("flags the pilot dropping the shared import, which no name-shadowing rule would catch", () => {
    // Regressing the pilot to a hand-authored shape leaves the shared names UNUSED, not duplicated.
    const violations = findDerivedTypeViolations({
      readFile: (path) => (path === SHARED_MODULE ? SHARED_SOURCE : "export type Something = { a: string };\n"),
      listUiFiles: () => [],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toContain("no longer imports the shared schema module");
  });

  it("passes trivially when the shared module exports nothing yet", () => {
    expect(check({ "apps/loopover-ui/src/components/site/rogue.ts": "type PublicStats = { updatedAt: string };\n" }, "import { z } from 'zod';\n")).toEqual([]);
  });
});

describe("the real tree", () => {
  it("is clean — the pilot is derived and no duplicate has reappeared", () => {
    expect(findDerivedTypeViolations()).toEqual([]);
  });
});
