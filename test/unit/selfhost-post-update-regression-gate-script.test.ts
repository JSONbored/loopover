import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve("scripts/selfhost-post-update-regression-gate.sh");
const sandboxDirs: string[] = [];

afterEach(() => {
  while (sandboxDirs.length > 0) {
    const dir = sandboxDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

// Stub `docker` responds to exactly the subcommands the script issues: `compose version` (a no-op
// readiness probe), `compose ... ps -q <service>` (container id), `compose ... logs --since ...
// <service>` (the job_dead log lines under test, controlled via DEAD_JOB_LOG_LINES), and
// `compose ... exec -T postgres psql ...` (the kill-switch write, controlled via PSQL_EXIT_CODE and
// recorded to PSQL_CALL_LOG so a test can assert on the exact SQL sent).
function createSandbox() {
  const base = mkdtempSync(join(tmpdir(), "gittensory-selfhost-regression-gate-"));
  sandboxDirs.push(base);
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(base, "docker-compose.yml"), "services: {}\n");

  writeExecutable(
    join(bin, "docker"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "compose" ] && [ "$2" = "version" ]; then
  exit 0
fi
if [ "$1" = "compose" ]; then
  shift
  # Skip past the -f FILE args compose_file_args emits.
  args=()
  while [ $# -gt 0 ]; do
    args+=("$1")
    shift
  done
  # args now e.g.: -f docker-compose.yml ps -q loopover
  sub=""
  for a in "\${args[@]}"; do
    if [ "$a" = "ps" ] || [ "$a" = "logs" ] || [ "$a" = "exec" ]; then
      sub="$a"
      break
    fi
  done
  case "$sub" in
    ps)
      if [ "\${SIMULATE_NOT_RUNNING:-}" = "1" ]; then
        exit 0
      fi
      printf 'container-1\\n'
      exit 0
      ;;
    logs)
      printf '%s' "\${DEAD_JOB_LOG_LINES:-}"
      exit 0
      ;;
    exec)
      printf '%s\\n' "\${args[*]}" >> "\${PSQL_CALL_LOG:-/dev/null}"
      exit "\${PSQL_EXIT_CODE:-0}"
      ;;
    *)
      exit 0
      ;;
  esac
fi
exit 0
`,
  );

  writeExecutable(
    join(bin, "sleep"),
    `#!/usr/bin/env bash
exit 0
`,
  );

  return { base, bin };
}

function run(env: Record<string, string>) {
  const { base, bin } = createSandbox();
  const psqlCallLog = join(base, "psql-calls.log");
  const result = spawnSync("bash", [SCRIPT], {
    cwd: base,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PSQL_CALL_LOG: psqlCallLog, ...env },
  });
  let psqlCalls = "";
  try {
    psqlCalls = readFileSync(psqlCallLog, "utf8");
  } catch {
    psqlCalls = "";
  }
  return { ...result, psqlCalls };
}

describe("selfhost-post-update-regression-gate.sh", () => {
  it("passes cleanly and never touches the kill-switch when dead-job count is within threshold", () => {
    const result = run({ DEAD_JOB_LOG_LINES: "" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 dead job(s)");
    expect(result.stdout).toContain("ok (within threshold)");
    expect(result.psqlCalls).toBe("");
  });

  it("stays within threshold at exactly the configured boundary (5 dead jobs, default threshold 5)", () => {
    const fiveDeadJobs = Array.from({ length: 5 }, () => '{"level":"error","event":"job_dead","id":"x"}').join("\n");

    const result = run({ DEAD_JOB_LOG_LINES: fiveDeadJobs });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("5 dead job(s)");
    expect(result.stdout).toContain("ok (within threshold)");
    expect(result.psqlCalls).toBe("");
  });

  it("trips the auto-pause and writes the DB kill-switch once the dead-job count exceeds the threshold", () => {
    const sixDeadJobs = Array.from({ length: 6 }, () => '{"level":"error","event":"job_dead","id":"x"}').join("\n");

    const result = run({ DEAD_JOB_LOG_LINES: sixDeadJobs });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("6 dead job(s) exceeds threshold of 5");
    expect(result.stderr).toContain("global_agent_controls.frozen = 1");
    expect(result.psqlCalls).toContain("global_agent_controls");
    expect(result.psqlCalls).toContain("frozen");
    expect(result.psqlCalls).toContain("selfhost-post-update-regression-gate.sh");
  });

  it("respects a configured custom threshold and window", () => {
    const twoDeadJobs = Array.from({ length: 2 }, () => '{"level":"error","event":"job_dead","id":"x"}').join("\n");

    const result = run({ DEAD_JOB_LOG_LINES: twoDeadJobs, SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD: "1", SELFHOST_REGRESSION_WINDOW_SECONDS: "5" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("observing loopover for 5s (auto-pause threshold: >1 dead jobs)");
    expect(result.stderr).toContain("2 dead job(s) exceeds threshold of 1");
  });

  it("reports (and does not crash on) a failed kill-switch write, with manual-pause guidance", () => {
    const sixDeadJobs = Array.from({ length: 6 }, () => '{"level":"error","event":"job_dead","id":"x"}').join("\n");

    const result = run({ DEAD_JOB_LOG_LINES: sixDeadJobs, PSQL_EXIT_CODE: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed to write the DB kill-switch");
    expect(result.stderr).toContain("PAUSE MANUALLY");
    expect(result.stderr).toContain("AGENT_ACTIONS_PAUSED=true");
  });

  it("falls back to safe defaults for non-numeric window/threshold settings without evaluating them as Bash arithmetic", () => {
    const marker = join(tmpdir(), `gittensory-regression-gate-injection-${process.pid}`);
    rmSync(marker, { force: true });

    const result = run({
      DEAD_JOB_LOG_LINES: "",
      SELFHOST_REGRESSION_WINDOW_SECONDS: `bad[$(touch ${marker})]`,
      SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD: `bad[$(touch ${marker})]`,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("invalid SELFHOST_REGRESSION_WINDOW_SECONDS");
    expect(result.stderr).toContain("invalid SELFHOST_REGRESSION_JOB_DEAD_THRESHOLD");
    expect(result.stdout).toContain("threshold: >5 dead jobs");
    // The marker file must never be created -- proves the malicious value was never `eval`'d/interpolated
    // into an arithmetic context, only ever compared against the numeric-only regex.
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses and never sleeps out the observation window when the service is not running", () => {
    const result = run({ DEAD_JOB_LOG_LINES: "", SIMULATE_NOT_RUNNING: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("loopover is not running");
    expect(result.stdout).not.toContain("observing loopover");
  });
});
