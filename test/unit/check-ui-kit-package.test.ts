import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// tsx, not plain node: check-ui-kit-package.ts imports forbidden-content.ts directly, so plain node
// can't resolve that local .ts import.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

function runChecker(env: Record<string, string | undefined> = {}): { status: number; out: string } {
  try {
    const stdout = execFileSync(TSX_BIN, ["scripts/check-ui-kit-package.ts"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A minimal, valid ui-kit tarball: the required entry points, one component, and package metadata.
const MINIMAL_PACKAGE = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "src/theme.css", "dist/utils.js", "dist/utils.d.ts", "dist/components/button.js", "dist/components/button.d.ts"];

describe("check-ui-kit-package script", () => {
  it("passes on the real ui-kit workspace package (regression guard: run `npm run build --workspace @loopover/ui-kit` first if this fails)", () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^ui-kit package dry-run ok: \d+ files\.\n$/);
  });

  it("accepts a minimal allowlisted package with nested dist/ components and declaration sourcemaps", () => {
    const result = runChecker({
      CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify([...MINIMAL_PACKAGE, "dist/components/button.d.ts.map", "dist/hooks/use-mobile.js", "dist/hooks/use-mobile.d.ts"]),
      CHECK_UI_KIT_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^ui-kit package dry-run ok: 12 files\.\n$/);
  });

  it("rejects a forbidden path", () => {
    const result = runChecker({ CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify([".env"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Forbidden file in ui-kit package: .env");
  });

  it("rejects an unexpected file outside dist/", () => {
    const result = runChecker({ CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(["scripts/extra.mjs"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in ui-kit package: scripts/extra.mjs");
  });

  it("rejects a non-js/d.ts/d.ts.map file inside dist/", () => {
    const result = runChecker({ CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(["dist/utils.js", "dist/utils.d.ts", "dist/notes.txt"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in ui-kit package: dist/notes.txt");
  });

  it("rejects a package missing the dist/utils entry point", () => {
    const result = runChecker({
      CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(["package.json", "README.md", "CHANGELOG.md", "src/theme.css", "dist/components/button.js", "dist/components/button.d.ts"]),
      CHECK_UI_KIT_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("ui-kit package is missing required file: dist/utils.js");
  });

  it("rejects a package with no dist/components/*.js artifacts at all", () => {
    const result = runChecker({
      CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(["package.json", "README.md", "CHANGELOG.md", "src/theme.css", "dist/utils.js", "dist/utils.d.ts"]),
      CHECK_UI_KIT_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("ui-kit package is missing dist/components/*.js artifacts");
  });

  it("rejects secret-like content", () => {
    const probe = ["PROBE", "_", "SECRET", "=", "value"].join("");
    const result = runChecker({
      CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(["package.json", "dist/utils.js"]),
      CHECK_UI_KIT_PACK_TEST_CONTENT: probe,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in ui-kit package file:");
  });

  it("rejects a README carrying stale public-package wording (#7013)", () => {
    const result = runChecker({
      CHECK_UI_KIT_PACK_TEST_FILES: JSON.stringify(MINIMAL_PACKAGE),
      CHECK_UI_KIT_PACK_TEST_CONTENT: "Join the private beta today!",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Stale public-package wording found in ui-kit package file: README.md");
  });
});
