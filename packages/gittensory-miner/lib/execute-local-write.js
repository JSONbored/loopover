// Real executeLocalWrite implementation (#5132, Wave 3.5). Mirrors coding-agent-construction.js's
// createRealCliSubprocessSpawn pattern (real child_process, resolve-not-reject on error/timeout so a
// killed/errored process's partial output -- e.g. an auth failure line on stderr -- is never lost to an
// unhandled rejection) but for LocalWriteActionSpec.command: a single shell-safe string (built with
// packages/gittensory-engine/src/miner/local-write-tools.ts's own single-quote escaping), not the
// cmd/args-array CliSubprocessSpawnFn contract the coding-agent driver itself uses. Runs it via `sh -c` in
// the given working directory. Per local-write-tools.ts's own boundary comment, this always runs with
// whatever `gh`/`git` credentials are already configured in that environment -- gittensory never performs
// the write itself.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * @param {import("@jsonbored/gittensory-engine").LocalWriteActionSpec} spec
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 * @returns {Promise<{ action: string, stdout: string, stderr: string, code: number | null, timedOut: boolean }>}
 */
export function executeLocalWrite(spec, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", spec.command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ action: spec.action, stdout, stderr, code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      // A spawn-level error (e.g. no `sh` on PATH) fires before the child ever produces output -- mirrors
      // createRealCliSubprocessSpawn's own identical handling.
      clearTimeout(timer);
      resolve({ action: spec.action, stdout, stderr: err.message, code: null, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ action: spec.action, stdout, stderr, code, timedOut: false });
    });
  });
}
