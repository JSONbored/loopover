import type {
  CodingAgentDriver,
  CodingAgentDriverResult,
  CodingAgentDriverTask,
} from "./coding-agent-driver.js";
import { buildAllowlistedEnv, redactSecrets } from "../subprocess-env.js";

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
    // Optional fast-fail deadline, mirrors src/selfhost/ai.ts's SpawnFn (#4994/#5053): a real spawn implementation
    // starts this timer at process start and clears it the instant any stdout data arrives, so it only fires when
    // the CLI has produced ZERO stdout by this deadline — a distinct, earlier signal than the full `timeoutMs`.
    firstOutputTimeoutMs?: number;
  },
) => Promise<{
  stdout: string;
  code: number | null;
  stderr?: string;
  timedOut?: boolean;
  // Set alongside `timedOut` only when the kill was the first-output deadline, not the full `timeoutMs` — lets the
  // driver report a distinct "stalled" error instead of conflating it with a genuine full timeout.
  stalledNoOutput?: boolean;
}>;

export type CliSubprocessDriverOptions = {
  /** The coding-agent CLI to spawn (e.g. "claude" or "codex"). */
  command: string;
  /** Injected spawn — a real `child_process` spawn in prod, a fake in tests. */
  spawn: CliSubprocessSpawnFn;
  /** Per-run wall-clock budget handed to the spawn. Default: 120000ms. */
  timeoutMs?: number;
  /** Optional fast-fail deadline (#4994/#5053): killed early and reported distinctly ("stalled", not a generic
   *  timeout) if the subprocess produces zero stdout before this elapses. Mirrors src/selfhost/ai.ts's
   *  `firstOutputTimeoutMs`/`resolveClaudeFirstOutputTimeoutMs` pattern, built after a naive single-timeout design
   *  caused a real production outage against these same claude/codex binaries. Opt-in and backward compatible:
   *  omitting it leaves behavior exactly as it was before this option existed. */
  firstOutputTimeoutMs?: number;
  /** Parent env to allowlist from. Default: `{}` (a real caller passes `process.env`; the default stays pure). */
  parentEnv?: Record<string, string | undefined>;
  /** Extra env overlaid on the allowlisted parent (e.g. an auth value the CLI reads). */
  env?: Record<string, string | undefined>;
  /** Known secret values (e.g. an injected auth token) to strip from any surfaced output, on top of the well-known
   *  token-shape patterns. */
  knownSecrets?: readonly string[];
  /** Build the CLI argv from a task. Defaults to `defaultClaudeCliArgs`/`defaultCodexCliArgs` based on
   *  `command` -- a caller overrides this to point at a different real CLI's own flags. */
  buildArgs?: (task: CodingAgentDriverTask) => readonly string[];
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_ERROR_DETAIL_CHARS = 500;

const CODING_AGENT_ENV_ALLOWLIST = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "PATH",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "https_proxy",
  "http_proxy",
  "no_proxy",
] as const;

/** Real, verified `claude -p` non-interactive argv (confirmed against `claude --help` and a live invocation,
 *  #5135 follow-up -- the previous default argv here used `--max-turns`/`--acceptance-criteria`, neither of
 *  which is a real `claude` CLI flag, and never passed `-p`/`--print` at all, meaning a spawned `claude`
 *  process would start an INTERACTIVE session against a subprocess whose stdin is closed).
 *  - `-p`/`--print` is REQUIRED for non-interactive use; without it `claude` starts an interactive session.
 *  - `--output-format json` produces a single parseable JSON result on stdout, matching `claudeErrorStatus`'s
 *    own `JSON.parse(stdout.trim())` assumption (which was already written for this shape, just never
 *    actually triggered because this flag was never passed).
 *  - `--permission-mode acceptEdits` is the same edit-permission scope the Agent-SDK driver already uses
 *    (#4267) -- file edits run unattended inside the scoped worktree, nothing broader.
 *  There is no turn-budget flag on the real CLI (verified via `claude --help`) and no acceptance-criteria
 *  flag either -- the coding agent discovers `task.acceptanceCriteriaPath` itself via its own Read tool
 *  inside the scoped working directory, exactly like the Agent-SDK driver already does (agent-sdk-driver.ts
 *  never passes it as a distinct option either; only `task.instructions` is forwarded as the prompt there
 *  too). The wall-clock `timeoutMs` (already implemented) is this provider's only real turn/cost ceiling. */
export function defaultClaudeCliArgs(task: CodingAgentDriverTask): string[] {
  return ["--print", "--output-format", "json", "--permission-mode", "acceptEdits", task.instructions];
}

/** Real, verified `codex exec` non-interactive argv (confirmed against `codex exec --help`, #5135
 *  follow-up). `exec` is a REQUIRED subcommand -- without it `codex` starts an interactive session, the same
 *  class of bug the missing `-p` had for claude. `--json` emits the JSONL event stream
 *  `codexErrorFromStdout` already parses line-by-line. `--sandbox workspace-write` is codex's own equivalent
 *  of claude's `acceptEdits` -- the model may write within the workspace, nothing broader. Same "no
 *  turn-budget flag" and "no acceptance-criteria flag" gaps as claude apply here too. */
export function defaultCodexCliArgs(task: CodingAgentDriverTask): string[] {
  return ["exec", "--json", "--sandbox", "workspace-write", task.instructions];
}

/** Resolve the default argv builder for a known production command; throws for anything else so an
 *  unrecognized `command` fails at driver-construction time (never silently invokes a binary with no known
 *  real argv shape) unless the caller supplies an explicit `options.buildArgs` override. */
function resolveDefaultBuildArgs(command: string): (task: CodingAgentDriverTask) => readonly string[] {
  if (command === "claude") return defaultClaudeCliArgs;
  if (command === "codex") return defaultCodexCliArgs;
  throw new Error(`unsupported_cli_subprocess_command:${command}`);
}

/** Best-effort real dollar-cost extraction from a CLI's own stdout. Mirrors src/selfhost/ai.ts's
 *  `extractCliUsage`/`COST_KEYS` (redeclared here, not imported, per this file's own no-src-import
 *  convention) but narrowed to just the cost field this driver's `CodingAgentDriverResult` surfaces -- tokens
 *  and model aren't part of that shape. Tries the whole trimmed stdout as one JSON object first (claude's
 *  `--output-format json` shape, empirically confirmed to carry `total_cost_usd`, the exact same field name
 *  the Agent-SDK's own result message carries), then scans line by line (codex's `--json` JSONL stream,
 *  "still evolving" per src/selfhost/ai.ts's own comment, so multiple real key spellings are tolerated). A
 *  missing/malformed field means "no cost signal", never an error -- never fabricated. */
const COST_KEYS = ["total_cost_usd", "totalCostUsd", "cost_usd", "costUsd"] as const;

function finiteNonNegativeNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function costUsdFromRecord(record: Record<string, unknown>): number | undefined {
  let best: number | undefined;
  for (const key of COST_KEYS) {
    const n = finiteNonNegativeNumber(record[key]);
    if (n !== undefined) best = Math.max(best ?? 0, n);
  }
  return best;
}

function extractCostUsd(stdout: string): number | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  let best: number | undefined;
  const tryLine = (text: string): void => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const n = costUsdFromRecord(parsed as Record<string, unknown>);
        if (n !== undefined) best = Math.max(best ?? 0, n);
      }
    } catch {
      /* not JSON -- best-effort only */
    }
  };
  tryLine(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim()) tryLine(line);
  }
  return best;
}

/** Claude Code's `--output-format json` sometimes exits non-zero while still emitting a structured
 *  `{is_error, api_error_status}` envelope on stdout (e.g. an auth/model error). Ported from
 *  src/selfhost/ai.ts's `claudeErrorStatus` -- redeclared here rather than imported, per this file's own
 *  no-src-import convention (see header comment). Returns null on absent/malformed stdout, in which case the
 *  caller falls back to the generic exit-code error unchanged (#5168). */
function claudeErrorStatus(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (parsed.is_error === true) return String(parsed.api_error_status ?? parsed.subtype ?? "unknown");
  } catch {
    /* not a single JSON object -- handled by the caller's generic exit-code fallback */
  }
  return null;
}

/** Codex's stderr is typically just an uninformative "Reading prompt from stdin..." startup banner; the real
 *  error (auth failure, unknown model, API error) lands in its JSONL stdout instead. Scans lines in reverse
 *  (the error object is usually last) and returns the first human-readable detail found, or null. Ported from
 *  src/selfhost/ai.ts's `codexErrorFromStdout` -- redeclared here (not imported) per this file's own
 *  no-src-import convention, and returns the RAW detail unredacted; the caller applies this driver's own
 *  knownSecrets-aware `redactSecrets` at the call site (#5169). */
function codexErrorFromStdout(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line?.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const errorObj = parsed.error as Record<string, unknown> | undefined;
      const detail =
        (typeof parsed.error === "string" && parsed.error) ||
        (typeof parsed.message === "string" && parsed.message) ||
        (typeof parsed.msg === "string" && parsed.msg) ||
        (errorObj && typeof errorObj.message === "string" ? errorObj.message : null) ||
        null;
      if (detail) return detail;
    } catch {
      /* not JSON -- skip */
    }
  }
  return null;
}

/**
 * Create a {@link CodingAgentDriver} that runs the coding agent as a CLI subprocess. A non-zero or absent exit
 * code, or a timeout, yields `ok: false` with a redacted error; exit `0` yields `ok: true`. Any subprocess output
 * kept as a transcript or folded into an error is redacted first.
 */
export function createCliSubprocessCodingAgentDriver(options: CliSubprocessDriverOptions): CodingAgentDriver {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const buildArgs = options.buildArgs ?? resolveDefaultBuildArgs(options.command);
  const knownSecrets = options.knownSecrets ?? [];
  return {
    async run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult> {
      const env = buildAllowlistedEnv(options.parentEnv ?? {}, CODING_AGENT_ENV_ALLOWLIST, options.env ?? {});
      const spawned = await options.spawn(options.command, buildArgs(task), {
        cwd: task.workingDirectory,
        env,
        timeoutMs,
        ...(options.firstOutputTimeoutMs !== undefined
          ? { firstOutputTimeoutMs: options.firstOutputTimeoutMs }
          : {}),
      });
      const transcript = redactSecrets(spawned.stdout, knownSecrets).slice(0, MAX_TRANSCRIPT_CHARS);

      if (spawned.timedOut && spawned.stalledNoOutput) {
        // Fast-fail path (#4994/#5053): killed at firstOutputTimeoutMs, well before the full timeoutMs, because
        // stdout produced no bytes at all. A distinct error (never reusing `${command}_timeout_...`) so this
        // stall is separately countable in logs/Sentry from a genuine full timeout where the process was at
        // least emitting output before it was killed.
        return {
          ok: false,
          changedFiles: [],
          summary: `${options.command} stalled with no stdout within ${options.firstOutputTimeoutMs}ms`,
          transcript,
          error: `${options.command}_stalled_no_output`,
        };
      }
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
        if (options.command === "claude") {
          const errStatus = claudeErrorStatus(spawned.stdout);
          if (errStatus) {
            return {
              ok: false,
              changedFiles: [],
              summary: `${options.command} exited non-zero`,
              transcript,
              error: redactSecrets(`claude_code_error_${errStatus}`, knownSecrets),
            };
          }
        }
        if (options.command === "codex") {
          const stderrTrimmed = (spawned.stderr ?? "").trim();
          const jsonlDetail = codexErrorFromStdout(spawned.stdout);
          if (!jsonlDetail && stderrTrimmed === "Reading prompt from stdin...") {
            // codex's JSONL stream carried no structured detail and stderr is ONLY the stdin-reading banner (no
            // API/auth error appended) -- auth.json was present at boot-time but is now expired or was deleted.
            // A distinct, actionable remediation instead of the generic exit-code string (#5169).
            return {
              ok: false,
              changedFiles: [],
              summary: `${options.command} exited non-zero`,
              transcript,
              error: redactSecrets(
                "codex_no_auth: auth.json missing or expired -- run `codex auth` to authenticate",
                knownSecrets,
              ),
            };
          }
          if (jsonlDetail) {
            // Prefer the structured error from codex's JSONL stdout over the uninformative stderr startup
            // message -- codex reports auth/model/API failures in its JSON stream, not stderr.
            const detail = redactSecrets(jsonlDetail, knownSecrets).slice(0, MAX_ERROR_DETAIL_CHARS);
            return {
              ok: false,
              changedFiles: [],
              summary: `${options.command} exited non-zero`,
              transcript,
              error: `${options.command}_exit_${spawned.code}: ${detail}`,
            };
          }
        }
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
      // Claude Code's own documented behavior: `--output-format json` "sometimes exits non-zero", implying
      // it can ALSO exit 0 while still reporting `is_error: true` in its structured JSON envelope (confirmed
      // empirically: a live `claude -p --output-format json` invocation returns a real `is_error`/`subtype`
      // field on every result, success or not). claudeErrorStatus was already written to detect exactly this
      // shape but, before this fix, was only ever checked on the `code !== 0` branch above -- a code-0 error
      // envelope silently read as `ok: true`. Checked here, not folded into that branch, since it's a
      // genuinely different condition (exit code 0).
      if (options.command === "claude") {
        const errStatus = claudeErrorStatus(spawned.stdout);
        if (errStatus) {
          return {
            ok: false,
            changedFiles: [],
            summary: `${options.command} exited 0 but reported an error envelope`,
            transcript,
            error: redactSecrets(`claude_code_error_${errStatus}`, knownSecrets),
          };
        }
      }
      const costUsd = extractCostUsd(spawned.stdout);
      return {
        ok: true,
        changedFiles: [],
        summary: `${options.command} completed for ${task.attemptId}`,
        transcript,
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}
