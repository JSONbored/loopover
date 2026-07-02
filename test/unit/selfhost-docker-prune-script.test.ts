import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "gittensory-docker-prune-"));
  tmpRoots.push(dir);
  return dir;
}

// Stubs `docker` on PATH with a fake binary that just records every invocation's arguments (one line per
// call) instead of touching a real Docker daemon -- the self-hosted runner this suite actually runs on has
// no Docker-in-Docker access, so a test that shells out to a real `docker image prune` would be
// unreliable/environment-dependent (same constraint as the compose-file structural tests).
function stubDocker(root: string): { logFile: string; binDir: string } {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(root, "docker-calls.log");
  writeFileSync(
    join(binDir, "docker"),
    ["#!/bin/sh", `echo "$@" >> "${logFile}"`, "echo 'TYPE           TOTAL SIZE RECLAIMABLE'", "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "docker"), 0o755);
  return { logFile, binDir };
}

function runPruneScript(root: string, env: Record<string, string> = {}): string {
  const { logFile, binDir } = stubDocker(root);
  execFileSync("sh", ["scripts/selfhost-docker-prune.sh"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  });
  return readFileSync(logFile, "utf8");
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selfhost-docker-prune.sh", () => {
  it("prunes images and build cache with the default 7-day (168h) age floor, never a blind full wipe", () => {
    const calls = runPruneScript(tmpRoot());

    expect(calls).toContain("image prune -af --filter until=168h");
    expect(calls).toContain("builder prune -af --filter until=168h");
    // Both prune calls must always carry an `until=` filter -- a bare `docker image prune -af` (no filter)
    // would also remove something built moments ago, defeating the rollback-safety window.
    for (const line of calls.trim().split("\n")) {
      if (line.includes("prune")) expect(line).toMatch(/--filter until=\d+h/);
    }
  });

  it("honors GITTENSORY_DOCKER_PRUNE_RETAIN_HOURS to widen or narrow the safety window", () => {
    const calls = runPruneScript(tmpRoot(), { GITTENSORY_DOCKER_PRUNE_RETAIN_HOURS: "24" });

    expect(calls).toContain("image prune -af --filter until=24h");
    expect(calls).toContain("builder prune -af --filter until=24h");
    expect(calls).not.toContain("168h");
  });

  it("reports before/after docker system df around the prune calls, for the log line an operator actually reads", () => {
    const calls = runPruneScript(tmpRoot());
    const invocations = calls.trim().split("\n");

    // "system df" (no prune flags) must appear before AND after the two prune calls, so an operator watching
    // logs can see what was actually reclaimed.
    const dfCalls = invocations.filter((line) => line === "system df");
    expect(dfCalls).toHaveLength(2);
  });
});
