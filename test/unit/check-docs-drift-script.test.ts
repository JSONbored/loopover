import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  checkDocsDrift,
  extractCatalogIds,
  extractGateModeFields,
  extractGittensoryReviewFlags,
  GATE_MODE_MANIFEST,
} from "../../scripts/check-docs-drift.mjs";

describe("check-docs-drift script", () => {
  describe("extractGittensoryReviewFlags", () => {
    it("extracts only real field declarations, not a comment mentioning a flag name", () => {
      const fixture = `
        interface Env {
          /** See GITTENSORY_REVIEW_SAFETY for context on why this one is separate. */
          GITTENSORY_REVIEW_FOO?: string;
          GITTENSORY_REVIEW_BAR: string;
          GITTENSORY_REVIEW_BAZ?: string;
        }
      `;

      const flags = extractGittensoryReviewFlags(fixture);

      expect(flags.sort()).toEqual(["GITTENSORY_REVIEW_BAR", "GITTENSORY_REVIEW_BAZ", "GITTENSORY_REVIEW_FOO"]);
      expect(flags).not.toContain("GITTENSORY_REVIEW_SAFETY");
    });

    it("returns unique values only", () => {
      const fixture = `
        GITTENSORY_REVIEW_FOO?: string;
        GITTENSORY_REVIEW_FOO?: string;
      `;

      expect(extractGittensoryReviewFlags(fixture)).toEqual(["GITTENSORY_REVIEW_FOO"]);
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

  describe("checkDocsDrift", () => {
    // A minimal set of fixtures that satisfies every check EXCEPT the one under test in each case below.
    const baseFlags = Array.from({ length: 10 }, (_, i) => `GITTENSORY_REVIEW_FLAG_${i}?: string;`).join("\n");
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
    const baseFlagNames = Array.from({ length: 10 }, (_, i) => `GITTENSORY_REVIEW_FLAG_${i}`);

    function buildDocsPageText(commandIds: string[]) {
      return commandIds.map((id) => `@gittensory ${id}`).join("\n");
    }

    function buildFlagsPageText(flagNames: string[]) {
      return flagNames.join("\n");
    }

    function buildGateModePageText() {
      return GATE_MODE_MANIFEST.flatMap((row) => row.aliases).join("\n");
    }

    function baseFixtures(): Record<string, string> {
      const files: Record<string, string> = {
        "src/env.d.ts": baseFlags,
        "src/github/commands.ts": baseCommandsSource,
        "src/types.ts": GATE_MODE_MANIFEST.map((row) => `${row.field}: GateRuleMode;`).join("\n"),
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
      expect(result.counts).toEqual({ flags: 10, commands: 19, gateModes: 11 });
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
        buildFlagsPageText(baseFlagNames.filter((flag) => flag !== "GITTENSORY_REVIEW_FLAG_3")),
        buildGateModePageText(),
      ].join("\n");
      const result = checkDocsDrift({ root: "/fake", readFile: makeReadFile(files) });

      const hit = result.failures.find((failure) => failure.includes("docs.tuning.tsx") && failure.includes("GITTENSORY_REVIEW_FLAG_3"));
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
      files["src/env.d.ts"] = "GITTENSORY_REVIEW_ONLY_ONE?: string;";
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

      expect(output).toMatch(/Docs-drift check ok: \d+ feature flags, \d+ commands, \d+ gate-mode fields all documented\./);
    });
  });
});
