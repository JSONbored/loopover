import type {
  CodingAgentDriver,
  CodingAgentDriverResult,
  CodingAgentDriverTask,
} from "./coding-agent-driver.js";
import { SUBPROCESS_CLI_ENV_ALLOWLIST, buildAllowlistedEnv, redactSecrets } from "../subprocess-env.js";

// CLI-subprocess CodingAgentDriver (#4266). Implements the CodingAgentDriver seam (#4262) by running the coding
// agent (`claude`/`codex`) as a subprocess in the attempt's scoped working directory. The spawn primitive is
// INJECTED (a generalized version of src/selfhost/ai.ts's SpawnFn, redeclared here so gittensory-engine stays
// standalone and doesn't import from src/), so the driver is fully testable without a real child process. Two
// safety primitives are reused from subprocess-env.ts (#4284) rather than re-implemented: the child gets a STRICT
// allowlisted env (never the full host env — a coding-agent subprocess is prompt-injectable), and any subprocess
// output surfaced in an error/transcript is run through `redactSecrets` first. Detecting which files changed is a
// sibling concern (a git diff over the worktree, #4269), so this driver reports `changedFiles: []` and leaves that
// to the caller.

/** The spawn primitive a CLI driver depends on — the generalized shape of src/selfhost/ai.ts's `SpawnFn`. Injected
 *  so the driver never hardcodes `child_process`; a fake resolves this in tests. */
export type CliSubprocessSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs: number;
  },
) => Promise<{ stdout: string; code: number | null; stderr?: string; timedOut?: boolean }>;

export type CliSubprocessDriverOptions = {
  /** The coding-agent CLI to spawn (e.g. "claude" or "codex"). */
  command: string;
  /** Injected spawn — a real `child_process` spawn in prod, a fake in tests. */
  spawn: CliSubprocessSpawnFn;
  /** Per-run wall-clock budget handed to the spawn. Default: 120000ms. */
  timeoutMs?: number;
  /** Parent env to allowlist from. Default: `{}` (a real caller passes `process.env`; the default stays pure). */
  parentEnv?: Record<string, string | undefined>;
  /** Extra env overlaid on the allowlisted parent (e.g. an auth value the CLI reads). */
  env?: Record<string, string | undefined>;
  /** Known secret values (e.g. an injected auth token) to strip from any surfaced output, on top of the well-known
   *  token-shape patterns. */
  knownSecrets?: readonly string[];
  /** Build the CLI argv from a task. Default is a generic max-turns / acceptance-criteria / instructions argv that a
   *  caller overrides to match the real CLI's flags. */
  buildArgs?: (task: CodingAgentDriverTask) => readonly string[];
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_ERROR_DETAIL_CHARS = 500;

function defaultBuildArgs(task: CodingAgentDriverTask): string[] {
  return [
    "--max-turns",
    String(task.maxTurns),
    "--acceptance-criteria",
    task.acceptanceCriteriaPath,
    task.instructions,
  ];
}

/**
 * Create a {@link CodingAgentDriver} that runs the coding agent as a CLI subprocess. A non-zero or absent exit
 * code, or a timeout, yields `ok: false` with a redacted error; exit `0` yields `ok: true`. Any subprocess output
 * kept as a transcript or folded into an error is redacted first.
 */
export function createCliSubprocessCodingAgentDriver(options: CliSubprocessDriverOptions): CodingAgentDriver {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const buildArgs = options.buildArgs ?? defaultBuildArgs;
  const knownSecrets = options.knownSecrets ?? [];
  return {
    async run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult> {
      const env = buildAllowlistedEnv(options.parentEnv ?? {}, SUBPROCESS_CLI_ENV_ALLOWLIST, options.env ?? {});
      const spawned = await options.spawn(options.command, buildArgs(task), {
        cwd: task.workingDirectory,
        env,
        timeoutMs,
      });
      const transcript = redactSecrets(spawned.stdout, knownSecrets).slice(0, MAX_TRANSCRIPT_CHARS);

      if (spawned.timedOut) {
        return {
          ok: false,
          changedFiles: [],
          summary: `${options.command} timed out after ${timeoutMs}ms`,
          transcript,
          error: `${options.command}_timeout_${timeoutMs}ms`,
        };
      }
      if (spawned.code !== 0) {
        const stderr = (spawned.stderr ?? "").trim();
        const detail = redactSecrets(stderr || `exit ${spawned.code}`, knownSecrets).slice(0, MAX_ERROR_DETAIL_CHARS);
        return {
          ok: false,
          changedFiles: [],
          summary: `${options.command} exited non-zero`,
          transcript,
          error: `${options.command}_exit_${spawned.code}: ${detail}`,
        };
      }
      return {
        ok: true,
        changedFiles: [],
        summary: `${options.command} completed for ${task.attemptId}`,
        transcript,
      };
    },
  };
}
