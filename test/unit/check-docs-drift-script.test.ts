import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  checkDocsDrift,
  extractCatalogIds,
  extractFocusManifestFields,
  extractGateModeFields,
  extractGittensoryReviewFlags,
  extractRepositorySettingsFields,
  FOCUS_MANIFEST_ALIAS_MANIFEST,
  GATE_MODE_MANIFEST,
  SETTINGS_ALIAS_MANIFEST,
} from "../../scripts/check-docs-drift.mjs";

describe("check-docs-drift script", () => {
  describe("extractGittensoryReviewFlags", () => {
    it("extracts only real field declarations, not a comment mentioning a flag name", () => {
      const fixture = `
        interface Env {
          /** See LOOPOVER_REVIEW_SAFETY for context on why this one is separate. */
          LOOPOVER_REVIEW_FOO?: string;
          LOOPOVER_REVIEW_BAR: string;
          LOOPOVER_REVIEW_BAZ?: string;
        }
      `;

      const flags = extractGittensoryReviewFlags(fixture);

      expect(flags.sort()).toEqual(["LOOPOVER_REVIEW_BAR", "LOOPOVER_REVIEW_BAZ", "LOOPOVER_REVIEW_FOO"]);
      expect(flags).not.toContain("LOOPOVER_REVIEW_SAFETY");
    });

    it("returns unique values only", () => {
      const fixture = `
        LOOPOVER_REVIEW_FOO?: string;
        LOOPOVER_REVIEW_FOO?: string;
      `;

      expect(extractGittensoryReviewFlags(fixture)).toEqual(["LOOPOVER_REVIEW_FOO"]);
    });
  });

  describe("extractCatalogIds", () => {
    const fixture = `
      const FIRST_CATALOG = [
        { id: "alpha", title: "Alpha" },
        { id: "beta", title: "Beta" },
      ] as const;

      const SECOND_CATALOG = [
        { id: "gamma", title: "Gamma" },
      ] as const;
    `;

    it("extracts only the ids from the named catalog, not the other one", () => {
      expect(extractCatalogIds(fixture, "FIRST_CATALOG").sort()).toEqual(["alpha", "beta"]);
      expect(extractCatalogIds(fixture, "SECOND_CATALOG")).toEqual(["gamma"]);
    });

    it("returns an empty array when the named catalog does not exist", () => {
      expect(extractCatalogIds(fixture, "MISSING_CATALOG")).toEqual([]);
    });
  });

  describe("extractGateModeFields", () => {
    it("extracts only real field declarations, not a comment mentioning a GateMode name without a colon", () => {
      const fixture = `
        type RepositorySettings = {
          // mirrors sizeGateMode in spirit, but this comment has no colon after it
          fooGateMode: GateRuleMode;
          barGateMode?: GateRuleMode | undefined;
          bazGateMode: GateRuleMode;
        };
      `;

      const fields = extractGateModeFields(fixture);

      expect(fields.sort()).toEqual(["barGateMode", "bazGateMode", "fooGateMode"]);
      expect(fields).not.toContain("sizeGateMode");
    });

    it("returns unique values only", () => {
      const fixture = `fooGateMode: GateRuleMode; fooGateMode: GateRuleMode;`;

      expect(extractGateModeFields(fixture)).toEqual(["fooGateMode"]);
    });
  });

  describe("extractRepositorySettingsFields (#4617)", () => {
    it("extracts a plain field extractGateModeFields would never find (#4617's own gap: a field not shaped like *GateMode)", () => {
      const fixture = `
        export type RepositorySettings = {
          repoFullName: string;
          agentGlobalFreezeOverride?: boolean | undefined;
          linkedIssueGateMode: GateRuleMode;
        };
      `;

      // The OLD, narrow check: invisible to a plain boolean field with no "GateMode" in its name -- this is
      // exactly the shape of gap #4617 was filed over (agentGlobalFreezeOverride was live in source code but
      // had zero automated documentation guarantee, because it isn't a *GateMode field).
      expect(extractGateModeFields(fixture)).toEqual(["linkedIssueGateMode"]);
      expect(extractGateModeFields(fixture)).not.toContain("agentGlobalFreezeOverride");

      // The WIDENED check: sees every field on the type, regardless of shape.
      const fields = extractRepositorySettingsFields(fixture);
      expect(fields).toEqual(["repoFullName", "agentGlobalFreezeOverride", "linkedIssueGateMode"]);
    });

    it("is anchored on the RepositorySettings type's own brace boundary, not a bare name match elsewhere in the file", () => {
      const fixture = `
        export type SomeUnrelatedType = {
          decoyField: string;
        };
        export type RepositorySettings = {
          realField: string;
        };
      `;

      expect(extractRepositorySettingsFields(fixture)).toEqual(["realField"]);
    });

    it("returns [] when RepositorySettings has no declaration in the text", () => {
      expect(extractRepositorySettingsFields("export type SomethingElse = { x: string };")).toEqual([]);
    });
  });

  describe("extractFocusManifestFields (#4617)", () => {
    it("recurses into a nested named config type, producing the dotted path a flat top-level-only check would miss", () => {
      const fixture = `
        export type FocusManifest = {
          present: boolean;
          review: FocusManifestReviewConfig;
        };
        export type FocusManifestReviewConfig = {
          present: boolean;
          visual: VisualConfig;
        };
        export type VisualConfig = {
          productionUrl: string | null;
        };
      `;

      // This is exactly #4617's own concrete gap, reproduced structurally: `review.visual.production_url` is
      // three levels deep, in a type the top-level FocusManifest declaration never mentions by name.
      expect(extractFocusManifestFields(fixture)).toEqual(["review.visual.productionUrl"]);
    });

    it("skips the gate/settings top-level fields (already exhaustively covered elsewhere, see FOCUS_MANIFEST_SKIP_TOP_LEVEL_FIELDS)", () => {
      const fixture = `
        export type FocusManifest = {
          present: boolean;
          gate: FocusManifestGateConfig;
          settings: FocusManifestSettings;
          review: FocusManifestReviewConfig;
        };
        export type FocusManifestGateConfig = {
          present: boolean;
          someGateField: string;
        };
        export type FocusManifestSettings = {
          present: boolean;
          someSettingsField: string;
        };
        export type FocusManifestReviewConfig = {
          present: boolean;
          someReviewField: string;
        };
      `;

      const fields = extractFocusManifestFields(fixture);

      expect(fields).toEqual(["review.someReviewField"]);
      expect(fields).not.toContain("gate.someGateField");
      expect(fields).not.toContain("settings.someSettingsField");
    });

    it("excludes parser-computed bookkeeping fields (present/source/warnings/sharedConfigSource) at every nesting level", () => {
      const fixture = `
        export type FocusManifest = {
          present: boolean;
          source: string;
          warnings: string[];
          review: FocusManifestReviewConfig;
        };
        export type FocusManifestReviewConfig = {
          present: boolean;
          sharedConfigSource: string | null;
          realField: string;
        };
      `;

      expect(extractFocusManifestFields(fixture)).toEqual(["review.realField"]);
    });

    it("treats an array/union/generic-typed field as one leaf rather than recursing into its element shape", () => {
      const fixture = `
        export type FocusManifest = {
          present: boolean;
          review: FocusManifestReviewConfig;
        };
        export type FocusManifestReviewConfig = {
          present: boolean;
          pathInstructions: ReviewPathInstruction[];
          maxFindings: MaxFindingsConfig | null;
        };
        export type ReviewPathInstruction = { path: string; instructions: string };
        export type MaxFindingsConfig = { blockers: number | null; nits: number | null };
      `;

      // `ReviewPathInstruction[]` is an array type (not a bare identifier) so it's a leaf; `MaxFindingsConfig |
      // null` is a union (not a bare identifier either), also a leaf -- neither recurses into its element shape.
      expect(extractFocusManifestFields(fixture)).toEqual(["review.pathInstructions", "review.maxFindings"]);
    });

    it("returns [] when FocusManifest has no declaration in the text", () => {
      expect(extractFocusManifestFields("export type SomethingElse = { x: string };")).toEqual([]);
    });
  });

  describe("checkDocsDrift", () => {
    // A minimal set of fixtures that satisfies every check EXCEPT the one under test in each case below.
    const baseFlags = Array.from({ length: 10 }, (_, i) => `LOOPOVER_REVIEW_FLAG_${i}?: string;`).join("\n");
    const baseCommandsSource = `
      const PUBLIC_MENTION_COMMAND_CATALOG = [
        ${Array.from({ length: 10 }, (_, i) => `{ id: "public-${i}", title: "Public ${i}" },`).join("\n")}
      ] as const;
      const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [
        ${Array.from({ length: 9 }, (_, i) => `{ id: "maint-${i}", title: "Maint ${i}" },`).join("\n")}
      ] as const;
    `;
    const allBaseCommandIds = [
      ...Array.from({ length: 10 }, (_, i) => `public-${i}`),
      ...Array.from({ length: 9 }, (_, i) => `maint-${i}`),
    ];
    const baseFlagNames = Array.from({ length: 10 }, (_, i) => `LOOPOVER_REVIEW_FLAG_${i}`);
    // Extra plain (non-*GateMode-shaped) RepositorySettings fields -- proves check 4 covers the FULL surface,
    // not just what extractGateModeFields already saw via GATE_MODE_MANIFEST.
    const baseSettingsExtraFields = Array.from({ length: 20 }, (_, i) => `settingsField${i}`);
    // Extra FocusManifestReviewConfig fields, plus a nested `visual.productionUrl` -- the nesting reproduces
    // #4617's own concrete gap shape (a field 2+ levels below the top-level FocusManifest type).
    const baseFocusManifestReviewFields = Array.from({ length: 18 }, (_, i) => `reviewField${i}`);

    function buildDocsPageText(commandIds: string[]) {
      return commandIds.map((id) => `@gittensory ${id}`).join("\n");
    }

    function buildFlagsPageText(flagNames: string[]) {
      return flagNames.join("\n");
    }

    function buildGateModePageText() {
      return GATE_MODE_MANIFEST.flatMap((row) => row.aliases).join("\n");
    }

    function buildRepositorySettingsSource(extraFieldNames: string[]) {
      return [
        "export type RepositorySettings = {",
        ...GATE_MODE_MANIFEST.map((row) => `  ${row.field}: GateRuleMode;`),
        ...extraFieldNames.map((name) => `  ${name}: string;`),
        "};",
      ].join("\n");
    }

    function buildFocusManifestSource(reviewFieldNames: string[]) {
      return [
        "export type FocusManifest = {",
        "  present: boolean;",
        "  gate: FocusManifestGateConfig;",
        "  settings: FocusManifestSettings;",
        "  review: FocusManifestReviewConfig;",
        "};",
        "export type FocusManifestGateConfig = {",
        "  present: boolean;",
        "  someGateField: string;",
        "};",
        "export type FocusManifestSettings = {",
        "  present: boolean;",
        "  someSettingsField: string;",
        "};",
        "export type FocusManifestReviewConfig = {",
        "  present: boolean;",
        ...reviewFieldNames.map((name) => `  ${name}: string;`),
        "  visual: VisualConfig;",
        "};",
        "export type VisualConfig = {",
        "  productionUrl: string | null;",
        "};",
      ].join("\n");
    }

    function buildYmlExampleText(settingsFieldNames: string[], reviewFieldNames: string[]) {
      return [...settingsFieldNames.map((name) => `${name}: null`), ...reviewFieldNames.map((name) => `${name}: null`), "production_url: null"].join(
        "\n",
      );
    }

    function baseFixtures(): Record<string, string> {
      const files: Record<string, string> = {
        "src/env.d.ts": baseFlags,
        "src/github/commands.ts": baseCommandsSource,
        "src/types.ts": buildRepositorySettingsSource(baseSettingsExtraFields),
        "packages/gittensory-engine/src/focus-manifest.ts": buildFocusManifestSource(baseFocusManifestReviewFields),
        ".loopover.yml.example": buildYmlExampleText(baseSettingsExtraFields, baseFocusManifestReviewFields),
        "apps/gittensory-ui/src/routes/docs.tuning.tsx": [buildFlagsPageText(baseFlagNames), buildGateModePageText()].join("\n"),
        "apps/gittensory-ui/src/routes/docs.privacy-security.tsx": buildFlagsPageText(baseFlagNames),
        "apps/gittensory-ui/src/routes/docs.maintainer-workflow.tsx": buildDocsPageText(allBaseCommandIds),
        "apps/gittensory-ui/src/routes/docs.maintainer-install-trust.tsx": buildDocsPageText(allBaseCommandIds),
        "apps/gittensory-ui/src/routes/docs.gittensory-commands.tsx":
          'import { PUBLIC_COMMAND_ENTRIES, MAINTAINER_COMMAND_ENTRIES, ACTION_COMMAND_ENTRIES } from "@/lib/command-reference";',
        "apps/gittensory-ui/src/routes/docs.how-reviews-work.tsx": buildGateModePageText(),
        "apps/gittensory-ui/src/routes/docs.github-app.tsx": buildGateModePageText(),
      };
      return files;
    }

    function makeReadFile(files: Record<string, string>) {
      return (_root: string, relativePath: string): string => {
        const contents = files[relativePath];
        if (contents === undefined) throw new Error(`unexpected read: ${relativePath}`);
        return contents;
      };
    }

    it("passes cleanly against a fully-consistent synthetic fixture set", () => {
      const files = baseFixtures();
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      expect(result.failures).toEqual([]);
      // gateModes bumped 12 -> 13 for copycatGateMode (#1969, currently inert config scaffold).
      // settingsFields = 13 GATE_MODE_MANIFEST fields + 20 synthetic extras; focusManifestFields = 18
      // synthetic review fields + the nested review.visual.productionUrl leaf (#4617).
      expect(result.counts).toEqual({ flags: 10, commands: 19, gateModes: 13, settingsFields: 33, focusManifestFields: 19 });
    });

    it("catches an unmapped *GateMode field missing from GATE_MODE_MANIFEST", () => {
      const files = baseFixtures();
      files["src/types.ts"] += "\nnewThingGateMode?: GateRuleMode;";
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("newThingGateMode") && failure.includes("GATE_MODE_MANIFEST"));
      expect(hit).toBeDefined();
    });

    it("catches a docs page missing a known feature flag", () => {
      const files = baseFixtures();
      // Drop one known flag from docs.tuning.tsx.
      files["apps/gittensory-ui/src/routes/docs.tuning.tsx"] = [
        buildFlagsPageText(baseFlagNames.filter((flag) => flag !== "LOOPOVER_REVIEW_FLAG_3")),
        buildGateModePageText(),
      ].join("\n");
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("docs.tuning.tsx") && failure.includes("LOOPOVER_REVIEW_FLAG_3"));
      expect(hit).toBeDefined();
    });

    it("catches a docs page missing a known @gittensory command", () => {
      const files = baseFixtures();
      files["apps/gittensory-ui/src/routes/docs.maintainer-workflow.tsx"] = buildDocsPageText(
        allBaseCommandIds.filter((id) => id !== "public-5"),
      );
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("docs.maintainer-workflow.tsx") && failure.includes("public-5"));
      expect(hit).toBeDefined();
    });

    it("skips per-command checks for a page that delegates to the generated command-reference instead of listing commands itself", () => {
      const files = baseFixtures();
      // Replace the page's literal @gittensory lines with an import marker only -- none of the individual
      // command ids appear in the page's own source anymore, mirroring docs.maintainer-workflow.tsx after
      // it switched to `import { PUBLIC_COMMAND_LIST, MAINTAINER_COMMAND_LIST } from "@/lib/command-reference"`.
      files["apps/gittensory-ui/src/routes/docs.maintainer-workflow.tsx"] =
        'import { PUBLIC_COMMAND_LIST } from "@/lib/command-reference";';
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      expect(result.failures).toEqual([]);
    });

    it("still checks a page for missing commands when it does NOT delegate to the generated command-reference", () => {
      const files = baseFixtures();
      files["apps/gittensory-ui/src/routes/docs.maintainer-install-trust.tsx"] = buildDocsPageText(
        allBaseCommandIds.filter((id) => id !== "maint-2"),
      );
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("docs.maintainer-install-trust.tsx") && failure.includes("maint-2"));
      expect(hit).toBeDefined();
    });

    it("catches a docs page missing a gate-mode alias", () => {
      const files = baseFixtures();
      const withoutSlop = GATE_MODE_MANIFEST.filter((row) => row.field !== "slopGateMode")
        .flatMap((row) => row.aliases)
        .join("\n");
      files["apps/gittensory-ui/src/routes/docs.tuning.tsx"] = [buildFlagsPageText(baseFlagNames), withoutSlop].join("\n");
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("docs.tuning.tsx") && failure.includes("slopGateMode"));
      expect(hit).toBeDefined();
    });

    it("self-defends against a broken flag-extraction regex (fewer than 10 flags found)", () => {
      const files = baseFixtures();
      files["src/env.d.ts"] = "LOOPOVER_REVIEW_ONLY_ONE?: string;";
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("src/env.d.ts") && failure.includes("extraction regex may be broken"));
      expect(hit).toBeDefined();
    });

    it("self-defends against a broken command-extraction regex (fewer than 15 commands found)", () => {
      const files = baseFixtures();
      files["src/github/commands.ts"] = `
        const PUBLIC_MENTION_COMMAND_CATALOG = [{ id: "only-one", title: "Only" }] as const;
        const MAINTAINER_QUEUE_DIGEST_COMMAND_CATALOG = [] as const;
      `;
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("src/github/commands.ts") && failure.includes("extraction regex may be broken"));
      expect(hit).toBeDefined();
    });

    it("self-defends against a broken gate-mode-extraction regex (fewer than 5 fields found)", () => {
      const files = baseFixtures();
      files["src/types.ts"] = "onlyOneGateMode: GateRuleMode;";
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("src/types.ts") && failure.includes("extraction regex may be broken"));
      expect(hit).toBeDefined();
    });

    it("self-defends against a broken RepositorySettings-extraction (fewer than 20 fields found, #4617)", () => {
      const files = baseFixtures();
      // No "export type RepositorySettings = {" wrapper at all -- extractRepositorySettingsFields finds nothing.
      files["src/types.ts"] = "someField: string;";
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find(
        (failure) => failure.includes("src/types.ts") && failure.includes("RepositorySettings fields") && failure.includes("extraction regex may be broken"),
      );
      expect(hit).toBeDefined();
    });

    it("self-defends against a broken FocusManifest-extraction (fewer than 15 leaf fields found, #4617)", () => {
      const files = baseFixtures();
      files["packages/gittensory-engine/src/focus-manifest.ts"] = "export type FocusManifest = { present: boolean; onlyOneField: string; };";
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find(
        (failure) =>
          failure.includes("packages/gittensory-engine/src/focus-manifest.ts") &&
          failure.includes("FocusManifest leaf fields") &&
          failure.includes("extraction regex may be broken"),
      );
      expect(hit).toBeDefined();
    });

    it("catches a RepositorySettings field with zero .loopover.yml.example mention and no alias/exclude entry (#4617)", () => {
      const files = baseFixtures();
      files["src/types.ts"] = files["src/types.ts"]!.replace("};", "  totallyUndocumentedField: boolean;\n};");
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find(
        (failure) => failure.includes(".loopover.yml.example") && failure.includes("totallyUndocumentedField"),
      );
      expect(hit).toBeDefined();
      // This exact shape -- a plain, non-*GateMode-named field -- is invisible to the OLD narrow check: it
      // extracts nothing beyond GATE_MODE_MANIFEST's own 13 rows, so it could never have raised this failure.
      expect(extractGateModeFields(files["src/types.ts"])).not.toContain("totallyUndocumentedField");
    });

    it("does not flag a RepositorySettings field whose real yml key is recorded in SETTINGS_ALIAS_MANIFEST", () => {
      // Every real alias-manifest row, exercised directly: add the field to the synthetic RepositorySettings,
      // do NOT mention its literal name anywhere, but DO include its recorded alias -- must pass cleanly
      // (baseFixtures() alone is already a clean pass, so any failure here can only be this new field).
      for (const row of SETTINGS_ALIAS_MANIFEST) {
        const files = baseFixtures();
        files["src/types.ts"] = files["src/types.ts"]!.replace("};", `  ${row.field}: string;\n};`);
        files[".loopover.yml.example"] += `\n${row.aliases[0]}`;
        const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

        expect(result.failures, `${row.field} should pass via alias ${row.aliases[0]}`).toEqual([]);
      }
    });

    it("treats NOT_YML_CONFIGURABLE_SETTINGS_FIELDS members as excluded even with zero yml mention (repoFullName, createdAt, updatedAt, agentGlobalFreezeOverride)", () => {
      const files = baseFixtures();
      files["src/types.ts"] = files["src/types.ts"]!.replace(
        "};",
        "  repoFullName: string;\n  createdAt?: string | null | undefined;\n  updatedAt?: string | null | undefined;\n  agentGlobalFreezeOverride?: boolean | undefined;\n};",
      );
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      for (const field of ["repoFullName", "createdAt", "updatedAt", "agentGlobalFreezeOverride"]) {
        expect(result.failures.find((failure) => failure.includes(field))).toBeUndefined();
      }
    });

    it("catches a FocusManifest field nested inside another config type with zero yml mention -- the exact review.visual.production_url shape (#4617)", () => {
      const files = baseFixtures();
      // A SECOND VisualConfig-shaped leaf that the synthetic .loopover.yml.example never mentions.
      files["packages/gittensory-engine/src/focus-manifest.ts"] = files["packages/gittensory-engine/src/focus-manifest.ts"]!.replace(
        "productionUrl: string | null;",
        "productionUrl: string | null;\n  totallyUndocumentedNestedField: string | null;",
      );
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find(
        (failure) => failure.includes(".loopover.yml.example") && failure.includes("review.visual.totally_undocumented_nested_field"),
      );
      expect(hit).toBeDefined();
      // A check that only enumerated FocusManifest's own TOP-LEVEL fields (never recursing into `review`, let
      // alone `review.visual`) could never have produced this path -- proving the recursion is load-bearing,
      // not just a nice-to-have, for catching #4617's own concrete gap shape.
      expect(extractFocusManifestFields(files["packages/gittensory-engine/src/focus-manifest.ts"])).toContain(
        "review.visual.totallyUndocumentedNestedField",
      );
    });

    it("does not flag a FocusManifest field whose real yml key is recorded in FOCUS_MANIFEST_ALIAS_MANIFEST", () => {
      // Same shape as the SETTINGS_ALIAS_MANIFEST case above: baseFixtures() alone is already a clean pass, so
      // any failure here can only be this new field failing to resolve through its recorded alias.
      for (const row of FOCUS_MANIFEST_ALIAS_MANIFEST) {
        const files = baseFixtures();
        const leafName = row.field.split(".").pop();
        files["packages/gittensory-engine/src/focus-manifest.ts"] = files["packages/gittensory-engine/src/focus-manifest.ts"]!.replace(
          "visual: VisualConfig;",
          `${leafName}: string | null;\n  visual: VisualConfig;`,
        );
        files[".loopover.yml.example"] += `\n${row.aliases[0]}`;
        const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

        expect(result.failures, `${row.field} should pass via alias ${row.aliases[0]}`).toEqual([]);
      }
    });

    // Most important regression test in this file: proves the REAL current repo state (source files +
    // docs pages) passes cleanly, using the real filesystem reader against the real repo root. If this
    // fails, either a real doc gap exists or the extraction logic is broken -- either way, the check must
    // not be weakened to make this test pass.
    it("the real repo's surfaces and docs pages agree (regression guard)", () => {
      const result = checkDocsDrift({ root: process.cwd() });

      expect(result.failures).toEqual([]);
    });

    it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
      const output = execFileSync("node", ["scripts/check-docs-drift.mjs"], { encoding: "utf8" });

      expect(output).toMatch(
        /Docs-drift check ok: \d+ feature flags, \d+ commands, \d+ gate-mode fields, \d+ RepositorySettings fields, \d+ FocusManifest fields all documented\./,
      );
    });
  });
});
