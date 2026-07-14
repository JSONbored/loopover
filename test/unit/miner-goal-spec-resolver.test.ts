import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import { resolveMinerGoalSpec } from "../../packages/loopover-miner/lib/miner-goal-spec.js";

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

  it("REGRESSION: reads a real .loopover-miner.yml from the cloned repo's root", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".loopover-miner.yml"), "killSwitch:\n  paused: true\n");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch).toEqual({ paused: true });
  });

  it("tries .github/loopover-miner.yml when the root .yml is absent", () => {
    const repoPath = tempRepo();
    mkdirSync(join(repoPath, ".github"), { recursive: true });
    writeFileSync(join(repoPath, ".github", "loopover-miner.yml"), "killSwitch:\n  paused: true\n");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch.paused).toBe(true);
  });

  it("tries the .json variants after both .yml candidates are absent", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".loopover-miner.json"), JSON.stringify({ killSwitch: { paused: true } }));
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(true);
    expect(parsed.spec.killSwitch.paused).toBe(true);
  });

  it("REGRESSION: rejects symlinked miner goal specs without reading the target", () => {
    const repoPath = tempRepo();
    const outsidePath = join(tempRepo(), "outside.yml");
    writeFileSync(outsidePath, "killSwitch:\n  paused: true\n");
    symlinkSync(outsidePath, join(repoPath, ".loopover-miner.yml"));

    const parsed = resolveMinerGoalSpec(repoPath);

    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });

  it("REGRESSION: ignores oversized miner goal specs before reading them into memory", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".loopover-miner.yml"), `${"#".repeat(32_769)}\nkillSwitch:\n  paused: true\n`);

    const parsed = resolveMinerGoalSpec(repoPath);

    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });

  it("REGRESSION: bounds the READ itself, not just the fstat-reported size, so a file that grows between the two still gets rejected", () => {
    const repoPath = tempRepo();
    // fstat reports a small, well-within-limit size, but the injected readSync keeps yielding bytes past the
    // cap anyway -- simulating a file that grows after fstatSync ran but before the read loop finishes (the
    // TOCTOU window a size check alone, without also bounding the read, cannot close.
    const parsed = resolveMinerGoalSpec(repoPath, {
      existsSync: (path) => path.endsWith(".loopover-miner.yml") && !path.includes(".github"),
      openSync: () => 999,
      fstatSync: () => ({ isFile: () => true, size: 10 }) as unknown as import("node:fs").Stats,
      readSync: (_fd, buffer, offset, length) => {
        const n = Math.min(length, 4096);
        buffer.fill(0x23, offset, offset + n); // '#' bytes, parses as a YAML comment if ever read
        return n;
      },
      closeSync: () => {},
    });

    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });

  it("degrades to safe defaults on malformed content instead of throwing", () => {
    const repoPath = tempRepo();
    writeFileSync(join(repoPath, ".loopover-miner.yml"), "killSwitch: [unterminated");
    const parsed = resolveMinerGoalSpec(repoPath);
    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
    expect(parsed.warnings.join(" ")).toMatch(/not valid YAML/i);
  });

  it("degrades to safe defaults when the discovered file can't actually be read", () => {
    const repoPath = tempRepo();
    const parsed = resolveMinerGoalSpec(repoPath, {
      existsSync: (path) => path.endsWith(".loopover-miner.yml") && !path.includes(".github"),
      openSync: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(parsed.present).toBe(false);
    expect(parsed.spec.killSwitch).toEqual({ paused: false });
  });
});
