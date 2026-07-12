import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { resolveMinerGoalSpec } from "../../packages/gittensory-miner/lib/miner-goal-spec.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-goal-spec-"));
  roots.push(root);
  return root;
}

describe("resolveMinerGoalSpec (#5132)", () => {
  it("returns an absent safe-default spec when no candidate file exists", () => {
    const repoPath = tempRepo();
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });

  it("REGRESSION: reads a real .gittensory-miner.yml from the cloned repo's root", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".gittensory-miner.yml"), "killSwitch:\n  paused: true\n");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch).toEqual({ paused: true });
  });

  it("tries .github/gittensory-miner.yml when the root .yml is absent", () => {
    const repoPath = tempRepo();
    mkdirSync(join(repoPath, ".github"), { recursive: true });
    writeFileSync(join(repoPath, ".github", "gittensory-miner.yml"), "killSwitch:\n  paused: true\n");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch.paused).toBe(true);
  });

  it("tries the .json variants after both .yml candidates are absent", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".gittensory-miner.json"), JSON.stringify({ killSwitch: { paused: true } }));
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch.paused).toBe(true);
  });

  it("degrades to safe defaults on malformed content instead of throwing", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".gittensory-miner.yml"), "killSwitch: [unterminated");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
    expect(parsed.warnings.join(" ")).toMatch(/not valid YAML/i);
  });

  it("degrades to safe defaults when the discovered file can't actually be read", () => {
    const repoPath = tempRepo();
    const parsed = resolveMinerGoalSpec(repoPath, {
      existsSync: (path) => path.endsWith(".gittensory-miner.yml") && !path.includes(".github"),
      readFileSync: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });
});
