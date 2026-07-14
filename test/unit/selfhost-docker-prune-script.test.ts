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

type ContainerFixture = {
  id: string;
  /** ISO timestamp for docker inspect's State.FinishedAt. */
  finishedAt: string;
  /** When true, `docker rm <id>` exits non-zero (simulates a removal failure/race). */
  failRemove?: boolean;
};

// Stubs `docker` on PATH with a fake binary that records every invocation's arguments (one line per call)
// instead of touching a real Docker daemon -- the self-hosted runner this suite actually runs on has no
// Docker-in-Docker access, so a test that shells out to a real `docker image prune`/`docker ps` would be
// unreliable/environment-dependent (same constraint as the compose-file structural tests). `containers`
// fixtures let a test simulate specific exited containers with specific real stop times (docker inspect's
// State.FinishedAt) -- this is what actually exercises prune_stopped_containers()'s stop-time logic,
// distinct from the generic "TYPE TOTAL SIZE RECLAIMABLE" fallback used for every other docker subcommand.
function stubDocker(root: string, containers: ContainerFixture[] = []): { logFile: string; binDir: string } {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logFile = join(root, "docker-calls.log");
  const fixturesFile = join(root, "containers.tsv");
  writeFileSync(
    fixturesFile,
    containers.map((c) => `${c.id}\t${c.finishedAt}\t${c.failRemove ? "1" : "0"}`).join("\n"),
  );
  writeFileSync(
    join(binDir, "docker"),
    [
      "#!/bin/sh",
      `echo "$@" >> "${logFile}"`,
      `FIXTURES="${fixturesFile}"`,
      // `docker ps -a --filter status=exited --format '{{.ID}}'` -> one container id per line.
      'if [ "$1 $2" = "ps -a" ]; then',
      '  awk -F"\\t" \'{print $1}\' "$FIXTURES"',
      "  exit 0",
      "fi",
      // `docker inspect -f '{{.State.FinishedAt}}' <id>` -> that container's fixture FinishedAt.
      'if [ "$1" = "inspect" ]; then',
      '  id="$4"',
      '  awk -F"\\t" -v id="$id" \'$1==id{print $2}\' "$FIXTURES"',
      "  exit 0",
      "fi",
      // `docker rm <id>` -> succeeds unless the fixture marks it as a forced failure.
      'if [ "$1" = "rm" ]; then',
      '  id="$2"',
      '  fail=$(awk -F"\\t" -v id="$id" \'$1==id{print $3}\' "$FIXTURES")',
      '  [ "$fail" = "1" ] && exit 1',
      "  exit 0",
      "fi",
      "echo 'TYPE           TOTAL SIZE RECLAIMABLE'",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "docker"), 0o755);
  stubDate(binDir);
  return { logFile, binDir };
}

// The script under test deliberately avoids GNU-coreutils-only `date -d <arbitrary-string>` (that's exactly
// the portability bug this fix corrects -- BusyBox `date` can't parse it), using only two forms instead:
// `date -u +%s` (current epoch; already identical across GNU/BSD/BusyBox) and `date -u -d "@<epoch>" +FORMAT`
// (format a KNOWN-GOOD epoch; BusyBox supports the `@<epoch>` input, but this repo's CI/dev hosts are a mix
// of GNU coreutils and macOS/BSD date, which does NOT support `-d` at all). Stubbing `date` with a
// deterministic python3-backed fake -- instead of relying on whichever `date` the test happens to run on --
// lets this suite exercise the real GNU/BusyBox-compatible code path even on a macOS dev machine, the same
// way `docker` itself is stubbed rather than requiring a real daemon.
function stubDate(binDir: string): void {
  writeFileSync(
    join(binDir, "date"),
    [
      "#!/bin/sh",
      'if [ "$1 $2" = "-u +%s" ]; then',
      '  python3 -c "import time; print(int(time.time()))"',
      "  exit 0",
      "fi",
      'if [ "$1 $2" = "-u -d" ]; then',
      '  epoch="${3#@}"',
      '  fmt="${4#+}"',
      '  python3 -W ignore::DeprecationWarning -c "import sys, datetime; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).strftime(sys.argv[2]))" "$epoch" "$fmt"',
      "  exit 0",
      "fi",
      // Only used for the human-readable "starting"/"done" log lines -- no test asserts on the exact value.
      "python3 -W ignore::DeprecationWarning -c \"import datetime; print(datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'))\"",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  chmodSync(join(binDir, "date"), 0o755);
}

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function runPruneScript(
  root: string,
  env: Record<string, string> = {},
  args: string[] = [],
  containers: ContainerFixture[] = [],
): string {
  const { logFile, binDir } = stubDocker(root, containers);
  execFileSync("sh", ["scripts/selfhost-docker-prune.sh", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  });
  return readFileSync(logFile, "utf8");
}

/** Like runPruneScript, but also returns the script's own combined stdout+stderr (for assertions on the
 *  human-readable log lines, e.g. "removed stopped container ..." on stdout / "WARNING: ..." on stderr),
 *  not just the raw docker-call log. Merges stderr into stdout via shell redirection since
 *  execFileSync's return value only ever captures one stream. */
function runPruneScriptCapturingOutput(
  root: string,
  env: Record<string, string> = {},
  args: string[] = [],
  containers: ContainerFixture[] = [],
): { calls: string; output: string } {
  const { logFile, binDir } = stubDocker(root, containers);
  const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const output = execFileSync("sh", ["-c", `sh scripts/selfhost-docker-prune.sh ${quotedArgs} 2>&1`], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
  }).toString();
  return { calls: readFileSync(logFile, "utf8"), output };
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("selfhost-docker-prune.sh", () => {
  it("prunes images and build cache with the default 7-day (168h) age floor, never a blind full wipe", () => {
    const calls = runPruneScript(tmpRoot());

    expect(calls).toContain("image prune -af --filter until=168h");
    expect(calls).toContain("builder prune -af --filter until=168h");
    // Every image/builder prune call must always carry an `until=` filter -- a bare `docker image prune -af`
    // (no filter) would also remove something built moments ago, defeating the rollback-safety window.
    for (const line of calls.trim().split("\n")) {
      if (line.includes("image prune") || line.includes("builder prune")) expect(line).toMatch(/--filter until=\d+h/);
    }
    // Never the old creation-time container filter -- that is exactly the defect this script now avoids.
    expect(calls).not.toContain("container prune");
  });

  it("honors LOOPOVER_DOCKER_PRUNE_RETAIN_HOURS to widen or narrow the safety window", () => {
    const calls = runPruneScript(tmpRoot(), { LOOPOVER_DOCKER_PRUNE_RETAIN_HOURS: "24" });

    expect(calls).toContain("image prune -af --filter until=24h");
    expect(calls).toContain("builder prune -af --filter until=24h");
    expect(calls).not.toContain("168h");
  });

  it("reports before/after docker system df around the prune calls, for the log line an operator actually reads", () => {
    const calls = runPruneScript(tmpRoot());
    const invocations = calls.trim().split("\n");

    // "system df" (no prune flags) must appear before AND after the prune steps, so an operator watching
    // logs can see what was actually reclaimed.
    const dfCalls = invocations.filter((line) => line === "system df");
    expect(dfCalls).toHaveLength(2);
  });

  it("--dry-run reports usage but issues no destructive prune call, and volumes are never touched by either mode", () => {
    const calls = runPruneScript(tmpRoot(), {}, ["--dry-run"]);
    const invocations = calls.trim().split("\n");

    // Only the read-only "before" system df call -- no "after" (nothing was pruned to report on), and no
    // image/builder prune invocation reached the real `docker` binary at all.
    expect(invocations.filter((line) => line === "system df")).toHaveLength(1);
    expect(calls).not.toMatch(/prune -af\b/);
    // Neither mode ever names a volume subcommand -- this script cannot delete application/backup/runner state.
    expect(calls).not.toMatch(/\bvolume\b/);
  });

  it("--dry-run still honors LOOPOVER_DOCKER_PRUNE_RETAIN_HOURS in its preview output", () => {
    const root = tmpRoot();
    const { binDir } = stubDocker(root);
    const stdout = execFileSync("sh", ["scripts/selfhost-docker-prune.sh", "--dry-run"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, LOOPOVER_DOCKER_PRUNE_RETAIN_HOURS: "48" },
    }).toString();

    expect(stdout).toContain("until=48h");
    expect(stdout).not.toContain("until=168h");
  });

  it("rejects an unrecognized argument instead of silently ignoring it", () => {
    const root = tmpRoot();
    const { binDir } = stubDocker(root);

    expect(() =>
      execFileSync("sh", ["scripts/selfhost-docker-prune.sh", "--nonsense"], {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        stdio: ["ignore", "ignore", "pipe"],
      }),
    ).toThrow();
  });

  describe("stopped-container pruning uses ACTUAL stop time, not creation time (#gate-review docker-prune-2721)", () => {
    it("removes a container that has genuinely been stopped longer than the retention window", () => {
      const { calls, output } = runPruneScriptCapturingOutput(
        tmpRoot(),
        {},
        [],
        [{ id: "old-stopped", finishedAt: isoHoursAgo(200) }],
      );

      expect(calls).toContain("rm old-stopped");
      expect(output).toContain("removed stopped container old-stopped");
    });

    it("REGRESSION: leaves a container alone that was created long ago but stopped moments ago -- the exact defect the old creation-time filter had", () => {
      // A long-lived container (irrelevant when it was CREATED) that exited 5 minutes ago must survive a
      // 168h-retention run: the old `docker container prune --filter until=168h` would have deleted this
      // immediately because that filter keys off creation time, not stop time.
      const root = tmpRoot();
      const calls = runPruneScript(root, {}, [], [{ id: "just-stopped", finishedAt: isoHoursAgo(0.08) }]);

      expect(calls).not.toContain("rm just-stopped");
    });

    it("does not remove a container stopped just under the retention window, and does remove one stopped just over it", () => {
      const root = tmpRoot();
      const calls = runPruneScript(
        root,
        { LOOPOVER_DOCKER_PRUNE_RETAIN_HOURS: "24" },
        [],
        [
          { id: "just-under", finishedAt: isoHoursAgo(23) },
          { id: "just-over", finishedAt: isoHoursAgo(25) },
        ],
      );

      expect(calls).not.toContain("rm just-under");
      expect(calls).toContain("rm just-over");
    });

    it("--dry-run reports which stopped containers WOULD be removed, without ever calling docker rm", () => {
      const { calls, output } = runPruneScriptCapturingOutput(
        tmpRoot(),
        {},
        ["--dry-run"],
        [{ id: "would-remove", finishedAt: isoHoursAgo(200) }],
      );

      expect(output).toContain("DRY RUN -- would remove stopped container would-remove");
      expect(calls).not.toContain("rm would-remove");
    });

    it("does nothing (no error, no removal) when there are no exited containers at all", () => {
      const calls = runPruneScript(tmpRoot(), {}, [], []);
      expect(calls).not.toMatch(/\brm\b/);
    });

    it("warns but does not abort the rest of the run when a container's removal itself fails", () => {
      const { output } = runPruneScriptCapturingOutput(
        tmpRoot(),
        {},
        [],
        [{ id: "fails-to-remove", finishedAt: isoHoursAgo(200), failRemove: true }],
      );

      expect(output).toContain("WARNING: failed to remove stopped container fails-to-remove");
      // The run must still reach and report the image/build-cache steps afterward -- one failed removal
      // must never abort the rest of the hygiene pass.
      expect(output).toContain("pruning unused images");
      expect(output).toContain("pruning build cache");
    });

    it("handles multiple exited containers independently, removing only the ones past the retention window", () => {
      const root = tmpRoot();
      const calls = runPruneScript(
        root,
        {},
        [],
        [
          { id: "keep-1", finishedAt: isoHoursAgo(1) },
          { id: "remove-1", finishedAt: isoHoursAgo(500) },
          { id: "keep-2", finishedAt: isoHoursAgo(10) },
          { id: "remove-2", finishedAt: isoHoursAgo(1000) },
        ],
      );

      expect(calls).toContain("rm remove-1");
      expect(calls).toContain("rm remove-2");
      expect(calls).not.toContain("rm keep-1");
      expect(calls).not.toContain("rm keep-2");
    });
  });
});
