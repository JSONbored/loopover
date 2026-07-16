import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// forbidden-content.mjs bills itself as the "single source of truth" for the packaged secret-shape detector.
// Both package checkers must consume that one exported constant rather than hand-copying the regex literal, or the
// two can silently drift and protect one package while leaving the other behind. These guards read the checker
// sources and assert the shared import stays wired up — a source-level check by necessity, since the checkers run
// their `npm pack` dry-run behind a main-guard and export nothing to compare by identity.
const CONSUMERS = ["check-mcp-package.mjs", "check-miner-package.mjs"];

// Vitest runs from the repo root, the same convention the sibling check-*-package tests rely on.
function readScript(name: string): string {
  return readFileSync(join(process.cwd(), "scripts", name), "utf8");
}

describe("forbidden-content shared secret-shape detector", () => {
  it("exports a stateless detector safe to share across checkers", () => {
    expect(FORBIDDEN_CONTENT).toBeInstanceOf(RegExp);
    // A /g (or /y) detector would carry lastIndex between .test() calls and make shared use order-dependent.
    expect(FORBIDDEN_CONTENT.global).toBe(false);
    expect(FORBIDDEN_CONTENT.sticky).toBe(false);
  });

  it.each(CONSUMERS)("%s imports FORBIDDEN_CONTENT from the shared module", (name) => {
    const source = readScript(name);
    expect(source).toMatch(
      /import\s*\{[^}]*\bFORBIDDEN_CONTENT\b[^}]*\}\s*from\s*["']\.\/forbidden-content\.mjs["']/,
    );
  });

  it.each(CONSUMERS)("%s declares no local FORBIDDEN_CONTENT literal of its own", (name) => {
    const source = readScript(name);
    expect(source).not.toMatch(/(?:const|let|var)\s+FORBIDDEN_CONTENT\s*=/);
  });
});
