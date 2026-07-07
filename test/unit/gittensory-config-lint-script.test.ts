import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLintReport, readManifestTextForLint } from "../../scripts/gittensory-config-lint";
import { lintManifestText } from "../../src/selfhost/config-lint";
import { MAX_FOCUS_MANIFEST_BYTES } from "../../src/signals/focus-manifest";

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

describe("readManifestTextForLint (#2923 regression)", () => {
  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "gittensory-config-lint-"));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads a regular manifest file at or below the parser byte limit", () => {
    withTempDir((dir) => {
      const path = join(dir, "manifest.yml");
      writeFileSync(path, "wantedPaths:\n  - src/\n");

      expect(readManifestTextForLint(path)).toBe("wantedPaths:\n  - src/\n");
    });
  });

  it("rejects missing paths before attempting to read", () => {
    withTempDir((dir) => {
      const path = join(dir, "missing.yml");

      expect(() => readManifestTextForLint(path)).toThrow(`no such file: ${path}`);
    });
  });

  it("rejects symlinks so repository-controlled manifests cannot target special files", () => {
    withTempDir((dir) => {
      const target = join(dir, "target.yml");
      const link = join(dir, "manifest.yml");
      writeFileSync(target, "wantedPaths:\n  - src/\n");
      symlinkSync(target, link);

      expect(() => readManifestTextForLint(link)).toThrow(`refusing to read symlink: ${link}`);
    });
  });

  it("rejects non-regular files before reading", () => {
    withTempDir((dir) => {
      const manifestDir = join(dir, "manifest.yml");
      mkdirSync(manifestDir);

      expect(() => readManifestTextForLint(manifestDir)).toThrow(`not a regular file: ${manifestDir}`);
    });
  });

  it("rejects oversized regular files before loading their contents", () => {
    withTempDir((dir) => {
      const path = join(dir, "manifest.yml");
      writeFileSync(path, "a".repeat(MAX_FOCUS_MANIFEST_BYTES + 1));

      expect(() => readManifestTextForLint(path)).toThrow(`file exceeds ${MAX_FOCUS_MANIFEST_BYTES} bytes: ${path}`);
    });
  });
});
