import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatLintJson, formatLintReport, readManifestTextForLint } from "../../scripts/loopover-config-lint";
import { lintManifestText } from "../../src/selfhost/config-lint";
import { MAX_FOCUS_MANIFEST_BYTES } from "../../src/signals/focus-manifest";

describe("formatLintReport (#2906)", () => {
  it("reports a valid manifest's summary and recognized fields, no warnings", () => {
    const result = lintManifestText("wantedPaths:\n  - src/\n");
    expect(formatLintReport(".loopover.yml", result)).toBe(
      ".loopover.yml: Manifest parsed 1 recognized field.\n  recognized fields: wantedPaths",
    );
  });

  it("reports warnings without a recognized-fields line when none are recognized", () => {
    const result = lintManifestText("unknownSecretKey: super-secret-value\n");
    expect(formatLintReport(".loopover.yml", result)).toBe(
      [
        ".loopover.yml: Manifest has 2 warnings.",
        "  - Manifest contained no recognized focus fields; falling back to deterministic signals.",
        "  - Manifest contains unknown top-level field: unknownSecretKey.",
      ].join("\n"),
    );
    // Never echoes the raw supplied value into the report (#2906 dogfoods config-lint's own secret-redaction).
    expect(formatLintReport(".loopover.yml", result)).not.toContain("super-secret-value");
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

describe("formatLintJson (#5931)", () => {
  it("serializes a clean manifest to JSON carrying path + the full SelfHostConfigLintResult", () => {
    const result = lintManifestText("wantedPaths:\n  - src/\n");
    const parsed = JSON.parse(formatLintJson(".loopover.yml", result));
    expect(parsed).toEqual({
      path: ".loopover.yml",
      ok: true,
      warnings: [],
      recognizedFields: ["wantedPaths"],
      summary: "Manifest parsed 1 recognized field.",
    });
  });

  it("serializes a manifest with an unknown top-level field, exposing warnings without echoing the raw value", () => {
    const result = lintManifestText("unknownSecretKey: super-secret-value\n");
    const json = formatLintJson("private-config.yml", result);
    const parsed = JSON.parse(json);
    expect(parsed.path).toBe("private-config.yml");
    expect(parsed.ok).toBe(false);
    expect(parsed.recognizedFields).toEqual([]);
    expect(parsed.warnings).toContain("Manifest contains unknown top-level field: unknownSecretKey.");
    expect(typeof parsed.summary).toBe("string");
    // Same secret-redaction contract as the text report (#2906): the raw value never appears in the output.
    expect(json).not.toContain("super-secret-value");
  });
});

// #5931: a real CLI-invocation test so a future edit can't silently break `--json` main() wiring (the flag/path
// parsing + text-vs-json switch live in main()'s v8-ignored I/O block, so only a subprocess exercises them).
describe("selfhost:config-lint --json CLI (#5931)", () => {
  const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");
  function runJson(manifestPath: string): { code: number; parsed: { path: string; ok: boolean; warnings: string[]; recognizedFields: string[]; summary: string } } {
    try {
      const out = execFileSync(TSX_BIN, ["scripts/loopover-config-lint.ts", manifestPath, "--json"], { encoding: "utf8" });
      return { code: 0, parsed: JSON.parse(out) };
    } catch (error) {
      // A failing manifest exits 1; execFileSync throws but still captures the JSON it printed to stdout.
      const e = error as { status?: number; stdout?: string };
      return { code: e.status ?? 1, parsed: JSON.parse(e.stdout ?? "{}") };
    }
  }
  function withTempManifest(contents: string, run: (path: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "loopover-config-lint-json-"));
    try {
      const path = join(dir, "manifest.yml");
      writeFileSync(path, contents);
      run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("prints valid JSON with ok/warnings/recognizedFields/summary and exits 0 for a clean manifest", () => {
    withTempManifest("wantedPaths:\n  - src/\n", (path) => {
      const { code, parsed } = runJson(path);
      expect(code).toBe(0);
      expect(parsed).toMatchObject({ path, ok: true, warnings: [], recognizedFields: ["wantedPaths"] });
      expect(typeof parsed.summary).toBe("string");
    });
  });

  it("prints valid JSON with warnings and exits 1 for a manifest with an unknown top-level field", () => {
    withTempManifest("unknownSecretKey: super-secret-value\n", (path) => {
      const { code, parsed } = runJson(path);
      expect(code).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.warnings).toContain("Manifest contains unknown top-level field: unknownSecretKey.");
      expect(parsed.recognizedFields).toEqual([]);
    });
  });
});
