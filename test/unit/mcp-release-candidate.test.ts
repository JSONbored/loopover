import { describe, expect, it } from "vitest";
import {
  buildReleaseCandidateReport,
  changelogHasVersionSection,
  checkChangelog,
  checkTag,
  checkTarball,
  checkTokenlessPublish,
  expectedReleaseTag,
  fileLooksLikeSecret,
  parseReleaseTag,
  redactSensitive,
  unexpectedTarballFiles,
} from "../../scripts/mcp-release-candidate-core.mjs";

const FORBIDDEN_PUBLIC_LANGUAGE = /\b(wallet|hotkey|coldkey|raw trust|trust score|payout|reward estimate|farming|private reviewability|public score estimate)\b/i;

// Mirrors the allowlisted shape of the published tarball.
const ALLOWED_FILES = ["bin/loopover-mcp.js", "lib/local-branch.js", "scripts/gittensor-score-preview.mjs", "package.json", "README.md", "CHANGELOG.md", "LICENSE"];
const CHANGELOG = "# Changelog\n\n## mcp-v0.4.0 - 2026-06-02\n\n### Features\n- Add a thing\n";

// A tokenless trusted-publishing workflow fixture (same shape as publish-mcp.yml).
const TOKENLESS_WORKFLOW = [
  "permissions:",
  "  contents: read",
  "jobs:",
  "  publish:",
  "    permissions:",
  "      contents: read",
  "      id-token: write",
  "    steps:",
  "      - name: Publish with npm trusted publishing",
  "        run: npx -y npm@11.15.0 publish --workspace @loopover/mcp --access public --provenance",
].join("\n");

describe("parseReleaseTag / checkTag", () => {
  it("accepts a well-formed tag and extracts the version", () => {
    expect(parseReleaseTag("mcp-v0.4.0")).toEqual({ valid: true, version: "0.4.0" });
    expect(expectedReleaseTag("0.4.0")).toBe("mcp-v0.4.0");
  });

  it("rejects malformed tag/version assumptions", () => {
    for (const bad of ["v0.4.0", "mcp-0.4.0", "mcp-v0.4", "mcp-v0.4.0-rc.1", "release-1", "", null]) {
      expect(parseReleaseTag(bad).valid).toBe(false);
    }
    expect(checkTag({ tag: "v0.4.0", packageVersion: "0.4.0" })).toMatchObject({ ok: false, code: "tag_format_invalid" });
  });

  it("passes when the tag matches the package version", () => {
    expect(checkTag({ tag: "mcp-v0.4.0", packageVersion: "0.4.0" })).toMatchObject({ ok: true, code: "tag_ok" });
  });

  it("fails on a tag/package version mismatch", () => {
    const result = checkTag({ tag: "mcp-v0.5.0", packageVersion: "0.4.0" });
    expect(result).toMatchObject({ ok: false, code: "tag_version_mismatch" });
    expect(result.message).toMatch(/0\.5\.0.*0\.4\.0/);
  });

  it("fails when the package version cannot be read", () => {
    expect(checkTag({ tag: "mcp-v0.4.0", packageVersion: null })).toMatchObject({ ok: false, code: "package_version_missing" });
  });
});

describe("checkChangelog", () => {
  it("passes when a dated target-version section exists (success fixture)", () => {
    expect(changelogHasVersionSection(CHANGELOG, "0.4.0")).toBe(true);
    expect(checkChangelog({ changelog: CHANGELOG, version: "0.4.0" })).toMatchObject({ ok: true, code: "changelog_ok" });
  });

  it("fails when the target-version section is missing (failure fixture)", () => {
    expect(checkChangelog({ changelog: CHANGELOG, version: "0.5.0" })).toMatchObject({ ok: false, code: "changelog_section_missing" });
    // A header without a date does not count as a real section.
    expect(changelogHasVersionSection("# Changelog\n\n## mcp-v0.5.0\n", "0.5.0")).toBe(false);
    expect(checkChangelog({ changelog: "", version: "0.4.0" })).toMatchObject({ ok: false });
  });
});

describe("checkTarball", () => {
  it("passes for an allowlisted file set with no secret-like content (success fixture)", () => {
    const result = checkTarball({ files: ALLOWED_FILES, contentsByFile: { "README.md": "# gittensory-mcp", "package.json": "{}" } });
    expect(result).toMatchObject({ ok: true, code: "tarball_ok" });
    expect(result.unexpected).toEqual([]);
  });

  it("fails when the tarball includes an unexpected file (failure fixture)", () => {
    expect(unexpectedTarballFiles([...ALLOWED_FILES, ".npmrc"])).toEqual([".npmrc"]);
    const result = checkTarball({ files: [...ALLOWED_FILES, "src/secret-notes.ts"] });
    expect(result).toMatchObject({ ok: false, code: "tarball_unsafe" });
    expect(result.unexpected).toContain("src/secret-notes.ts");
  });

  it("fails when a packaged file carries secret-like content (failure fixture)", () => {
    expect(fileLooksLikeSecret("NPM_TOKEN=abc123")).toBe(true);
    expect(fileLooksLikeSecret("just docs")).toBe(false);
    const result = checkTarball({ files: ALLOWED_FILES, contentsByFile: { "README.md": "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } });
    expect(result).toMatchObject({ ok: false, code: "tarball_unsafe" });
    expect(result.secretFiles).toEqual(["README.md"]);
  });
});

describe("checkTokenlessPublish", () => {
  it("passes for a tokenless trusted-publishing workflow", () => {
    expect(checkTokenlessPublish(TOKENLESS_WORKFLOW)).toMatchObject({ ok: true, code: "publish_tokenless", issues: [] });
  });

  it("fails when an npm auth token is referenced", () => {
    const withToken = `${TOKENLESS_WORKFLOW}\n        env:\n          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}`;
    const result = checkTokenlessPublish(withToken);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/token/i);
  });

  it("fails when id-token or provenance is missing", () => {
    expect(checkTokenlessPublish("jobs:\n  publish:\n    steps:\n      - run: npm publish --provenance").issues.join(" ")).toMatch(/id-token/);
    expect(checkTokenlessPublish("permissions:\n  id-token: write\njobs:\n  publish:\n    steps:\n      - run: npm publish").issues.join(" ")).toMatch(/provenance/);
  });

  it("ignores commented tokenless signals and disabled provenance flags", () => {
    const invalid = [
      "permissions:",
      "  contents: read",
      "  # id-token: write",
      "jobs:",
      "  publish:",
      "    steps:",
      "      # npm publish --provenance",
      "      - run: npm publish --provenance=false",
    ].join("\n");
    const result = checkTokenlessPublish(invalid);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/id-token/);
    expect(result.issues.join(" ")).toMatch(/provenance/);
  });
});

describe("buildReleaseCandidateReport", () => {
  const passing = {
    tag: { ok: true, code: "tag_ok", message: "ok", tag: "mcp-v0.4.0" },
    changelog: { ok: true, code: "changelog_ok", message: "ok" },
    tarball: { ok: true, code: "tarball_ok", message: "ok" },
    cliSmoke: { ok: true, code: "cli_smoke_ok", message: "ok" },
    tokenless: { ok: true, code: "publish_tokenless", message: "ok" },
  };

  it("reports safe-to-tag with non-publishing next steps when every check passes", () => {
    const report = buildReleaseCandidateReport(passing);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.nextSteps.join(" ")).toMatch(/mcp-v0\.4\.0/);
    expect(report.nextSteps.join(" ")).toMatch(/no publish was attempted/i);
  });

  it("aggregates failures with remediation and never tells the maintainer to publish", () => {
    const report = buildReleaseCandidateReport({
      ...passing,
      changelog: { ok: false, code: "changelog_section_missing", message: "missing" },
      tarball: { ok: false, code: "tarball_unsafe", message: "unsafe" },
    });
    expect(report.ok).toBe(false);
    expect(report.failures.map((f) => f.code)).toEqual(expect.arrayContaining(["changelog_section_missing", "tarball_unsafe"]));
    expect(report.nextSteps.join(" ")).toMatch(/changelog:mcp/);
    expect(report.nextSteps.join(" ")).toMatch(/do not tag until it passes/i);
    expect(JSON.stringify(report)).not.toMatch(/\bnpm publish\b/);
  });
});

describe("redactSensitive (dry-run log safety)", () => {
  it("scrubs tokens, npm credentials, GitHub auth, and absolute local paths", () => {
    const dirty = [
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "github_pat_11AAAAAAA0bbbbbbbbbb_cccccccc",
      "NODE_AUTH_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123",
      "//registry.npmjs.org/:_authToken=npm_secretvalue000000000000",
      "path /Users/maintainer/.npmrc and C:\\Users\\maintainer\\secret",
    ].join("\n");
    const clean = redactSensitive(dirty);
    expect(clean).not.toMatch(/ghp_[A-Z0-9]/i);
    expect(clean).not.toMatch(/github_pat_/);
    expect(clean).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
    expect(clean).not.toMatch(/_authToken=npm_/);
    expect(clean).not.toMatch(/\/Users\/maintainer|C:\\Users\\maintainer/);
    expect(clean).toContain("[redacted-token]");
    expect(clean).toContain("[local-path]");
  });

  it("keeps redaction idempotent and leaves safe text intact", () => {
    const safe = "MCP release-candidate dry-run for mcp-v0.4.0 (no publish attempted)";
    expect(redactSensitive(safe)).toBe(safe);
    expect(redactSensitive(redactSensitive("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"))).toBe("[redacted-token]");
  });
});

describe("public-output safety", () => {
  it("never emits forbidden private/compensation language in any check message or next step", () => {
    const reports = [
      buildReleaseCandidateReport({
        tag: checkTag({ tag: "mcp-v0.4.0", packageVersion: "0.4.0" }),
        changelog: checkChangelog({ changelog: CHANGELOG, version: "0.4.0" }),
        tarball: checkTarball({ files: ALLOWED_FILES }),
        cliSmoke: { ok: true, code: "cli_smoke_ok", message: "ok" },
        tokenless: checkTokenlessPublish(TOKENLESS_WORKFLOW),
      }),
      buildReleaseCandidateReport({
        tag: checkTag({ tag: "bad", packageVersion: "0.4.0" }),
        changelog: checkChangelog({ changelog: "", version: "0.4.0" }),
        tarball: checkTarball({ files: [...ALLOWED_FILES, ".env"], contentsByFile: { ".env": "API_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } }),
        cliSmoke: { ok: false, code: "cli_smoke_failed", message: "failed" },
        tokenless: checkTokenlessPublish("run: npm publish"),
      }),
    ];
    for (const report of reports) {
      const blob = redactSensitive(JSON.stringify(report));
      expect(blob).not.toMatch(FORBIDDEN_PUBLIC_LANGUAGE);
      expect(blob).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    }
  });
});
