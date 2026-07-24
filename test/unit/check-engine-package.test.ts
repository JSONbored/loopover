import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// tsx, not plain node: check-engine-package.ts imports forbidden-content.ts directly, so plain node
// can't resolve that local .ts import.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

function runChecker(env: Record<string, string | undefined> = {}): { status: number; out: string } {
  try {
    const stdout = execFileSync(TSX_BIN, ["scripts/check-engine-package.ts"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A minimal, valid engine tarball: the required entry point plus package metadata.
const MINIMAL_PACKAGE = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/index.js", "dist/index.d.ts"];

describe("check-engine-package script", () => {
  it("passes on the real engine workspace package (regression guard: run `npm run build --workspace @loopover/engine` first if this fails)", () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^Engine package dry-run ok: \d+ files\.\n$/);
  });

  it("accepts a minimal allowlisted package with nested dist/ modules", () => {
    const result = runChecker({
      CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify([...MINIMAL_PACKAGE, "dist/signals/predicted-gate-engine.js", "dist/signals/predicted-gate-engine.d.ts"]),
      CHECK_ENGINE_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^Engine package dry-run ok: 8 files\.\n$/);
  });

  it("rejects a forbidden path", () => {
    const result = runChecker({ CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify([".env"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Forbidden file in engine package: .env");
  });

  it("rejects an unexpected file outside dist/", () => {
    const result = runChecker({ CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify(["scripts/extra.mjs"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in engine package: scripts/extra.mjs");
  });

  it("rejects a non-js/d.ts file inside dist/", () => {
    const result = runChecker({ CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify(["dist/index.js", "dist/index.d.ts", "dist/notes.txt"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in engine package: dist/notes.txt");
  });

  it("rejects a package missing the dist/index entry point", () => {
    const result = runChecker({
      CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify(["package.json", "README.md", "CHANGELOG.md", "dist/other.js", "dist/other.d.ts"]),
      CHECK_ENGINE_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Engine package is missing required file: dist/index.js");
  });

  it("rejects secret-like content", () => {
    const probe = ["PROBE", "_", "SECRET", "=", "value"].join("");
    const result = runChecker({
      CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify(["package.json", "dist/index.js"]),
      CHECK_ENGINE_PACK_TEST_CONTENT: probe,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in engine package file:");
  });

  it("rejects a README carrying stale public-package wording (#7013)", () => {
    const result = runChecker({
      CHECK_ENGINE_PACK_TEST_FILES: JSON.stringify(MINIMAL_PACKAGE),
      CHECK_ENGINE_PACK_TEST_CONTENT: "Join the private beta today!",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Stale public-package wording found in engine package file: README.md");
  });
});
