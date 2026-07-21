import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// tsx, not plain node: check-mcp-package.mjs imports forbidden-content.ts and mcp-package-allowlist.ts
// directly, so plain node can't resolve those local .ts imports.
const TSX_BIN = join(process.cwd(), "node_modules", ".bin", "tsx");

function runChecker(env: Record<string, string | undefined> = {}): { status: number; out: string } {
  try {
    const stdout = execFileSync(TSX_BIN, ["scripts/check-mcp-package.mjs"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, out: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A complete, valid MCP tarball: a bin, shipped lib modules, the preview scripts, and the package metadata files.
const FULL_PACKAGE = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "bin/loopover-mcp.js",
  "lib/cli-error.js",
  "lib/telemetry.js",
  "scripts/gittensor-score-preview.mjs",
  "scripts/gittensor-score-preview.py",
];

describe("check-mcp-package script", () => {
  it("passes on the real MCP workspace package", () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^MCP package dry-run ok:/);
    expect(result.out).toContain("bin/loopover-mcp.js");
    expect(result.out).toContain("package.json");
  });

  it("accepts a complete allowlisted package", () => {
    const result = runChecker({
      CHECK_MCP_PACK_TEST_FILES: JSON.stringify(FULL_PACKAGE),
      CHECK_MCP_PACK_TEST_CONTENT: "public docs, nothing secret",
    });
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^MCP package dry-run ok:/);
    expect(result.out).toContain("lib/cli-error.js");
    expect(result.out).toContain("scripts/gittensor-score-preview.mjs");
  });

  it("rejects a forbidden path", () => {
    const result = runChecker({ CHECK_MCP_PACK_TEST_FILES: JSON.stringify([".env"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Forbidden file in MCP package: .env");
  });

  it("rejects an unexpected file", () => {
    const result = runChecker({ CHECK_MCP_PACK_TEST_FILES: JSON.stringify(["scripts/extra.mjs"]) });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in MCP package: scripts/extra.mjs");
  });

  it("rejects an unexpected bin that matches the package name prefix", () => {
    const result = runChecker({
      CHECK_MCP_PACK_TEST_FILES: JSON.stringify(["package.json", "bin/loopover-mcp-backdoor.js"]),
      CHECK_MCP_PACK_TEST_CONTENT: "console.log('not secret');",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Unexpected file in MCP package: bin/loopover-mcp-backdoor.js");
  });

  it("rejects secret-like content", () => {
    const probe = ["PROBE", "_", "SECRET", "=", "value"].join("");
    const result = runChecker({
      CHECK_MCP_PACK_TEST_FILES: JSON.stringify(["package.json", "bin/loopover-mcp.js"]),
      CHECK_MCP_PACK_TEST_CONTENT: probe,
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Secret-like content found in MCP package file:");
  });

  it("rejects stale public-package wording in README.md", () => {
    const result = runChecker({
      CHECK_MCP_PACK_TEST_FILES: JSON.stringify(["package.json", "README.md"]),
      CHECK_MCP_PACK_TEST_CONTENT: "Join the private beta today!",
    });
    expect(result.status).toBe(1);
    expect(result.out).toContain("Stale public-package wording found in MCP package file: README.md");
  });

  it("only scopes the stale-wording check to README.md, not other allowlisted files", () => {
    // The same stale phrase in a non-README file (here CHANGELOG.md) is accepted — the guard is README-only.
    const result = runChecker({
      CHECK_MCP_PACK_TEST_FILES: JSON.stringify(["package.json", "CHANGELOG.md"]),
      CHECK_MCP_PACK_TEST_CONTENT: "Historic note: was once a private beta.",
    });
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/^MCP package dry-run ok:/);
  });
});
