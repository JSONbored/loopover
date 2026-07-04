import { describe, expect, it } from "vitest";
import { formatLintReport } from "../../scripts/gittensory-config-lint";
import { lintManifestText } from "../../src/selfhost/config-lint";

describe("formatLintReport (#2906)", () => {
  it("reports a valid manifest's summary and recognized fields, no warnings", () => {
    const result = lintManifestText("wantedPaths:\n  - src/\n");
    expect(formatLintReport(".gittensory.yml", result)).toBe(
      ".gittensory.yml: Manifest parsed 1 recognized field.\n  recognized fields: wantedPaths",
    );
  });

  it("reports warnings without a recognized-fields line when none are recognized", () => {
    const result = lintManifestText("unknownSecretKey: super-secret-value\n");
    expect(formatLintReport(".gittensory.yml", result)).toBe(
      [
        ".gittensory.yml: Manifest has 2 warnings.",
        "  - Manifest contained no recognized focus fields; falling back to deterministic signals.",
        "  - Manifest contains unknown top-level field: unknownSecretKey.",
      ].join("\n"),
    );
    // Never echoes the raw supplied value into the report (#2906 dogfoods config-lint's own secret-redaction).
    expect(formatLintReport(".gittensory.yml", result)).not.toContain("super-secret-value");
  });

  it("reports both recognized fields and warnings together for a partially-valid manifest", () => {
    const result = lintManifestText("wantedPaths: [src/]\nunknownSecretKey: super-secret-value\n");
    expect(formatLintReport("private-config.yml", result)).toBe(
      [
        "private-config.yml: Manifest has 1 warning.",
        "  recognized fields: wantedPaths",
        "  - Manifest contains unknown top-level field: unknownSecretKey.",
      ].join("\n"),
    );
  });
});
