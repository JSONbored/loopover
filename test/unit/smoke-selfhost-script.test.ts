import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/smoke-selfhost.sh";

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o755 });
}

function runSmoke(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-selfhost-test-"));
  const calls = join(dir, "calls.log");
  writeExecutable(
    join(dir, "docker"),
    `#!/usr/bin/env bash
printf 'docker' >> "${calls}"
for arg in "$@"; do printf '\\t%s' "$arg" >> "${calls}"; done
printf '\\n' >> "${calls}"
if [ "$1" = "exec" ]; then echo PONG; fi
if [ "$1" = "logs" ]; then echo '{"event":"selfhost_migrations_applied"}'; fi
`,
  );
  writeExecutable(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf 'curl' >> "${calls}"
for arg in "$@"; do printf '\\t%s' "$arg" >> "${calls}"; done
printf '\\n' >> "${calls}"
case "$*" in
  *'/health'*) echo '{"status":"ok"}' ;;
  *'/ready'*) echo '{"ok":true}' ;;
  *'/metrics'*) echo 'gittensory_uptime_seconds 1' ;;
esac
`,
  );

  const result = spawnSync("bash", [SCRIPT_PATH, "gittensory:rc-candidate"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      SELFHOST_SMOKE_PORT: "18787",
      ...extraEnv,
    },
    encoding: "utf8",
  });
  const output = readFileSync(calls, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { result, output };
}

describe("smoke-selfhost.sh", () => {
  it("binds the app port to loopback and generates an unpredictable setup token by default", () => {
    const { result, output } = runSmoke();

    expect(result.status, result.stderr).toBe(0);
    expect(output).toContain("\t-p\t127.0.0.1:18787:8787");
    expect(output).not.toContain("\t-p\t18787:8787");
    expect(output).not.toContain("SELFHOST_SETUP_TOKEN=selfhost-smoke-setup-token");
    expect(output).toMatch(/SELFHOST_SETUP_TOKEN=[0-9a-f]{32}/);
    expect(output).toContain("curl\t-sf\thttp://127.0.0.1:18787/health");
  });

  it("uses the caller-supplied setup token when explicitly provided", () => {
    const { result, output } = runSmoke({ SELFHOST_SMOKE_SETUP_TOKEN: "caller-token" });

    expect(result.status, result.stderr).toBe(0);
    expect(output).toContain("SELFHOST_SETUP_TOKEN=caller-token");
  });
});
