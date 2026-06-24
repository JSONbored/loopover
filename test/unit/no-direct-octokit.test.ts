import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Structural guard for the dry-run write chokepoint (#dry-run-chokepoint): every installation-scoped Octokit in
// src/github/** MUST be built through makeInstallationOctokit (src/github/client.ts), which suppresses every
// state-changing verb under a non-live action mode. A raw `new Octokit(...)` anywhere else would bypass the
// suppression hook and could mutate GitHub during a dry-run / pause / global freeze. client.ts is the sole
// exception (it is where the factory lives).
const githubDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/github");

describe("no raw `new Octokit` outside the client chokepoint", () => {
  const files = readdirSync(githubDir).filter((name) => name.endsWith(".ts") && name !== "client.ts");

  it("covers more than three github source files (the scan is wired up)", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const file of files) {
    it(`${file} builds no installation Octokit directly`, () => {
      const source = readFileSync(join(githubDir, file), "utf8");
      expect(source).not.toMatch(/new\s+Octokit\s*\(/);
    });
  }
});
