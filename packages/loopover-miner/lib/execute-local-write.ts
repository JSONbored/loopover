// Real executeLocalWrite implementation (#5132, Wave 3.5). Mirrors coding-agent-construction.js's
// createRealCliSubprocessSpawn pattern (real child_process, resolve-not-reject on error/timeout so a
// killed/errored process's partial output -- e.g. an auth failure line on stderr -- is never lost to an
// unhandled rejection) but for LocalWriteActionSpec.command: a single shell-safe string (built with
// packages/loopover-engine/src/miner/local-write-tools.ts's own single-quote escaping), not the
// cmd/args-array CliSubprocessSpawnFn contract the coding-agent driver itself uses. Runs it via `sh -c` in
// the given working directory. Per local-write-tools.ts's own boundary comment, this always runs with
// whatever `gh`/`git` credentials are already configured in that environment -- loopover never performs
// the write itself.

import { spawn } from "node:child_process";
import type { LocalWriteActionSpec } from "@loopover/engine";

const DEFAULT_TIMEOUT_MS = 120_000;

export type ExecuteLocalWriteResult = {
  action: string;
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
};

export function executeLocalWrite(
  spec: LocalWriteActionSpec,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<ExecuteLocalWriteResult> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? (options.timeoutMs as number) : DEFAULT_TIMEOUT_MS;

  return new Promise<ExecuteLocalWriteResult>((resolve) => {
    const child = spawn("sh", ["-c", spec.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ action: spec.action, stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      // A spawn-level error (e.g. no `sh` on PATH) fires before the child ever produces output -- mirrors
      // createRealCliSubprocessSpawn's own identical handling.
      clearTimeout(timer);
      resolve({ action: spec.action, stdout, stderr: err.message, code: null, timedOut: false });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ action: spec.action, stdout, stderr, code, timedOut: false });
    });
  });
}
