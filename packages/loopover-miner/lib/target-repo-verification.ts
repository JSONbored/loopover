// Target-repo verification gate (#8807): run the TARGET repository's own detected test/lint/build commands
// against the attempt's worktree BEFORE a PR opens — the independent check the audit found missing: the
// only verification module that existed (engine lint-guard.ts) is hardcoded to loopover's own monorepo
// commands and never passed in production, and coding-task-spec's validation guidance only TELLS the agent
// which commands to run, trusting its self-attestation. A coding agent that skips or fakes its own test run
// previously produced a PR that passed every AMS-side gate and still broke the target repo's build.
//
// Commands come from stack-detection.js's already-inferred RepoStackResult (the same source the agent's own
// guidance renders), run in test → lint → build order (highest signal first), stop at the first failure,
// with a per-command timeout and a bounded output tail (the postmortem detail, never an unbounded dump).
// An UNDETECTED stack or a stack with no inferred commands SKIPS (recorded, never a failure): this gate can
// only ever be as smart as detection, and refusing to submit because detection came up empty would block
// legitimate work on repos with unconventional tooling.
import { spawn as nodeSpawn } from "node:child_process";
import type { RepoStackResult } from "./stack-detection.js";

export type TargetRepoVerificationSpawn = (
  command: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<{ code: number | null; output: string }>;

export type TargetRepoVerificationCheck = {
  kind: "test" | "lint" | "build";
  command: string;
  ok: boolean;
  exitCode: number | null;
  outputTail: string;
};

export type TargetRepoVerificationResult =
  | { status: "passed"; checks: TargetRepoVerificationCheck[] }
  | { status: "failed"; checks: TargetRepoVerificationCheck[]; firstFailure: TargetRepoVerificationCheck }
  | { status: "skipped"; reason: "stack_undetected" | "no_commands_detected" | "disabled" };

/** Per-command wall-clock bound. A target repo's test suite legitimately runs minutes; 10 is the ceiling
 *  before the gate itself becomes the attempt's bottleneck — a suite slower than this is skipped territory
 *  for a future per-repo override, not something to silently wait out. */
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60 * 1000;
/** Postmortem detail bound — enough tail to show the failing assertion, never an unbounded log dump. */
export const VERIFICATION_OUTPUT_TAIL_CHARS = 4000;

/** Default spawn: shell-executed (detected commands are shell strings like "npm test" / "ruff check ."),
 *  merged stdout+stderr, killed at the timeout (a killed process reports code null → treated as failure). */
export const defaultVerificationSpawn: TargetRepoVerificationSpawn = (command, options) =>
  new Promise((resolve) => {
    const child = nodeSpawn(command, { cwd: options.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-VERIFICATION_OUTPUT_TAIL_CHARS * 4);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n${String(error)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

export async function runTargetRepoVerification(options: {
  worktreeDir: string;
  stack: RepoStackResult;
  spawn?: TargetRepoVerificationSpawn;
  timeoutMsPerCommand?: number;
}): Promise<TargetRepoVerificationResult> {
  const stack = options.stack;
  if (stack.detected !== true) return { status: "skipped", reason: "stack_undetected" };
  const commands: Array<{ kind: TargetRepoVerificationCheck["kind"]; command: string | null }> = [
    { kind: "test", command: stack.testCommand },
    { kind: "lint", command: stack.lintCommand },
    { kind: "build", command: stack.buildCommand },
  ];
  const runnable = commands.filter((entry): entry is { kind: TargetRepoVerificationCheck["kind"]; command: string } => entry.command !== null);
  if (runnable.length === 0) return { status: "skipped", reason: "no_commands_detected" };

  const spawn = options.spawn ?? defaultVerificationSpawn;
  const timeoutMs = options.timeoutMsPerCommand ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const checks: TargetRepoVerificationCheck[] = [];
  for (const { kind, command } of runnable) {
    const { code, output } = await spawn(command, { cwd: options.worktreeDir, timeoutMs });
    const check: TargetRepoVerificationCheck = {
      kind,
      command,
      ok: code === 0,
      exitCode: code,
      outputTail: output.slice(-VERIFICATION_OUTPUT_TAIL_CHARS),
    };
    checks.push(check);
    // Stop at the first failure: the remaining commands' results would only pile noise onto an attempt that
    // is already not submitting, and a broken build often cascades into misleading downstream failures.
    if (!check.ok) return { status: "failed", checks, firstFailure: check };
  }
  return { status: "passed", checks };
}
