import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/compute-test-shards.ts");

function run(args: string[]) {
  return spawnSync("node", ["--experimental-strip-types", SCRIPT, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function discoverRealTestFiles(): string[] {
  // Independent re-implementation (not importing the script's own discoverTestFiles) so this test
  // can't pass merely because both sides share the same bug.
  const results: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === join("test", "workers")) continue;
        walk(full);
      } else if (entry.name.endsWith(".test.ts")) {
        results.push(full);
      }
    }
  }
  walk("test");
  return results;
}

let tmpDir: string;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("compute-test-shards.ts", () => {
  it("with no timing data, splits the real repo's test files evenly across shards (round-robin fallback)", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shard-test-"));
    const outputPath = join(tmpDir, "assignment.json");
    const result = run([`--shards=6`, `--output=${outputPath}`]);
    expect(result.status, result.stderr).toBe(0);

    const assignment = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, string[]>;
    const shardCounts = Object.values(assignment).map((files) => files.length);
    const expected = discoverRealTestFiles();
    const total = shardCounts.reduce((sum, count) => sum + count, 0);

    expect(total).toBe(expected.length);
    // Regression test (#ci-duration-aware-sharding): before the tie-break rotation fix, every file with
    // an identical (fallback) duration collapsed onto shard 1, leaving shards 2-6 completely empty --
    // the real, common case here (no timing data has ever been fetched yet). Assert every shard got a
    // roughly even share, not just that the total is right.
    for (const count of shardCounts) {
      expect(count).toBeGreaterThan(Math.floor(expected.length / 6) - 2);
      expect(count).toBeLessThan(Math.ceil(expected.length / 6) + 2);
    }
  });

  it("the union of all shards exactly equals the discovered file set, with no file duplicated", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shard-test-"));
    const outputPath = join(tmpDir, "assignment.json");
    const result = run([`--shards=6`, `--output=${outputPath}`]);
    expect(result.status, result.stderr).toBe(0);

    const assignment = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, string[]>;
    const allAssigned = Object.values(assignment).flat();
    const expected = discoverRealTestFiles();

    expect(new Set(allAssigned).size).toBe(allAssigned.length); // no duplicates
    expect(new Set(allAssigned)).toEqual(new Set(expected)); // exact set match, nothing missing or extra
  });

  it("balances weighted (real-shaped) synthetic durations far more evenly than an unweighted split would", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shard-test-"));
    const timingPath = join(tmpDir, "timing.json");
    const outputPath = join(tmpDir, "assignment.json");

    const files = discoverRealTestFiles();
    const averageSecondsByFile: Record<string, number> = {};
    files.forEach((file, index) => {
      // A handful of heavy outliers (every 47th file), everything else small -- shaped like a real
      // suite (most files fast, a few slow ones dominate wall-clock if they land in the same shard).
      averageSecondsByFile[file] = index % 47 === 0 ? 20 : 0.5;
    });
    writeFileSync(timingPath, JSON.stringify({ averageSecondsByFile }));

    const result = run([`--shards=6`, `--timing=${timingPath}`, `--output=${outputPath}`]);
    expect(result.status, result.stderr).toBe(0);

    const assignment = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, string[]>;
    const shardTotals = Object.values(assignment).map((shardFiles) =>
      shardFiles.reduce((sum, file) => sum + (averageSecondsByFile[file] ?? 0), 0),
    );
    const maxTotal = Math.max(...shardTotals);
    const minTotal = Math.min(...shardTotals);
    // LPT bin-packing's worst-case bound is well under 34% over optimal; require well inside that,
    // since real per-file variance here is much smaller than the pathological cases that bound covers.
    expect((maxTotal - minTotal) / maxTotal).toBeLessThan(0.15);
  });

  it("refuses to write output when test/ exists but contains zero test files", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shard-test-"));
    const outputPath = join(tmpDir, "assignment.json");
    mkdirSync(join(tmpDir, "test"));
    const result = spawnSync("node", [SCRIPT, "--shards=6", `--output=${outputPath}`], { cwd: tmpDir, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("discovered zero test files");
  });

  it("fails with a clear error, not a raw ENOENT stack trace, when test/ doesn't exist at all", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "shard-test-"));
    const outputPath = join(tmpDir, "assignment.json");
    const result = spawnSync("node", [SCRIPT, "--shards=6", `--output=${outputPath}`], { cwd: tmpDir, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("does not exist -- run this from the repo root");
    expect(result.stderr).not.toContain("ENOENT");
  });
});
