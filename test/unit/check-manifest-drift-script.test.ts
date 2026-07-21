import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkManifestDrift } from "../../scripts/check-manifest-drift.js";
import { LOOPOVER_REPO_FOCUS_MANIFEST_YAML } from "../../src/config/loopover-repo-focus-manifest";

// The script imports src/config/loopover-repo-focus-manifest.ts (a .ts module), so -- like
// check-schema-drift.ts, check-migrations.mjs, and check-openapi-settings-parity.ts -- it must run via
// `tsx`, the same binary package.json's manifest:drift-check uses, rather than plain `node`.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

describe("check-manifest-drift script", () => {
  function makeReadFile(rootManifestYaml: string) {
    return (_root: string, relativePath: string): string => {
      if (relativePath !== ".loopover.yml") throw new Error(`unexpected read: ${relativePath}`);
      return rootManifestYaml;
    };
  }

  it("passes cleanly when the root manifest and the bundled fallback parse to the same object", () => {
    const rootManifestYaml = "source: repo_file\nwantedPaths:\n  - src/\n  - test/\n";
    const result = checkManifestDrift({
      root: "/fake",
      readFile: makeReadFile(rootManifestYaml),
      bundledYaml: rootManifestYaml,
    });

    expect(result.failures).toEqual([]);
  });

  it("does not flag purely cosmetic differences: comments, key order, and whitespace", () => {
    const rootManifestYaml = "# a comment\nsource: repo_file\nwantedPaths:\n  - src/\n  - test/\n";
    const bundledYaml = "wantedPaths:\n  - src/\n  - test/\nsource: repo_file\n# a different comment\n";
    const result = checkManifestDrift({
      root: "/fake",
      readFile: makeReadFile(rootManifestYaml),
      bundledYaml,
    });

    expect(result.failures).toEqual([]);
  });

  it("catches a field present in the root manifest but missing from the bundled fallback", () => {
    const rootManifestYaml = "source: repo_file\nlinkedIssuePolicy: preferred\n";
    const bundledYaml = "source: repo_file\n";
    const result = checkManifestDrift({
      root: "/fake",
      readFile: makeReadFile(rootManifestYaml),
      bundledYaml,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain(".loopover.yml");
    expect(result.failures[0]).toContain("LOOPOVER_REPO_FOCUS_MANIFEST_YAML");
    expect(result.failures[0]).toContain("linkedIssuePolicy");
  });

  it("catches a value that differs between the two files for the same key", () => {
    const rootManifestYaml = "gate:\n  duplicates: block\n";
    const bundledYaml = "gate:\n  duplicates: advisory\n";
    const result = checkManifestDrift({
      root: "/fake",
      readFile: makeReadFile(rootManifestYaml),
      bundledYaml,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("block");
    expect(result.failures[0]).toContain("advisory");
  });

  // Most important regression test in this file: proves the REAL current repo state (root .loopover.yml
  // vs. the real bundled LOOPOVER_REPO_FOCUS_MANIFEST_YAML constant) agrees, using the real filesystem
  // reader against the real repo root. If this fails, the two have genuinely drifted apart -- either way,
  // the check must not be weakened to make this test pass.
  it("the real repo's root .loopover.yml and the bundled fallback agree (regression guard)", () => {
    const result = checkManifestDrift({ root: process.cwd() });

    expect(result.failures).toEqual([]);
  });

  it("the bundled fallback constant is non-empty and includes the source: repo_file marker", () => {
    // A structural guard on the constant itself: an accidental empty-string or truncated bundle would
    // otherwise parse to `undefined`/{} and could pass a deep-equal check against an equally-broken root
    // read, so assert the constant looks like real manifest YAML independent of the comparison above.
    expect(LOOPOVER_REPO_FOCUS_MANIFEST_YAML.length).toBeGreaterThan(100);
    expect(LOOPOVER_REPO_FOCUS_MANIFEST_YAML).toContain("source: repo_file");
  });

  it("prints a clean summary and exits 0 for the real repo state when run as a subprocess", () => {
    const output = execFileSync(TSX_BIN, ["scripts/check-manifest-drift.ts"], { encoding: "utf8" });

    expect(output).toMatch(/Manifest-drift check ok: \.loopover\.yml and LOOPOVER_REPO_FOCUS_MANIFEST_YAML agree\./);
  });
});
