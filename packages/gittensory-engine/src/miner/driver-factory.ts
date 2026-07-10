// CodingAgentDriver factory + provider-style config resolution (#4289). Mirrors `src/selfhost/ai-config.ts:41-74`:
// parse a comma-separated provider list, validate each name against what is actually configured, deny-by-default
// on unknown/unconfigured names, and expose a model/effort config map analogous to `SELF_HOST_REVIEWER_MODEL_ENV`.
// Concrete backends: CLI-subprocess (#4266) and Agent-SDK (#4267), plus the built-in `noop` stub.

import {
  createFakeCodingAgentDriver,
  createNoopCodingAgentDriver,
  type CodingAgentDriver,
} from "./coding-agent-driver.js";
import {
  invokeCodingAgentDriver,
  type AttemptLogSink,
} from "./coding-agent-invoke.js";
import {
  resolveCodingAgentModeFromConfig,
  type CodingAgentExecutionMode,
} from "./coding-agent-mode.js";
import type { CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";
import { guardCodingAgentDriverResult, type LintGuardOptions, type LintGuardResult } from "./lint-guard.js";
import {
  createCliSubprocessCodingAgentDriver,
  type CliSubprocessSpawnFn,
} from "./cli-subprocess-driver.js";
import {
  createAgentSdkCodingAgentDriver,
  type AgentSdkHooks,
  type AgentSdkQueryFn,
} from "./agent-sdk-driver.js";

/** Provider names the factory knows how to resolve today. */
export const CODING_AGENT_DRIVER_NAMES = Object.freeze([
  "noop",
  "cli-subprocess",
  "agent-sdk",
] as const);

export type CodingAgentDriverName = (typeof CODING_AGENT_DRIVER_NAMES)[number];

/** Per-provider env keys for coding-agent configuration (mirrors `SELF_HOST_REVIEWER_MODEL_ENV`). */
export const CODING_AGENT_DRIVER_CONFIG_ENV: Readonly<
  Record<CodingAgentDriverName, { model?: string; maxTurns?: string; command?: string; timeoutMs?: string }>
> = Object.freeze({
  noop: {},
  "cli-subprocess": {
    model: "MINER_CODING_AGENT_CLI_MODEL",
    maxTurns: "MINER_CODING_AGENT_MAX_TURNS",
    command: "MINER_CODING_AGENT_CLI",
    timeoutMs: "MINER_CODING_AGENT_TIMEOUT_MS",
  },
  "agent-sdk": {
    model: "MINER_CODING_AGENT_SDK_MODEL",
    maxTurns: "MINER_CODING_AGENT_MAX_TURNS",
  },
});

const DEFAULT_CLI_COMMAND = "claude";
const DEFAULT_CLI_TIMEOUT_MS = 120_000;

function parseDriverNames(env: Record<string, string | undefined>): string[] {
  return (env.MINER_CODING_AGENT_PROVIDER ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function firstConfigured(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Default CLI spawn — lazy `node:child_process` import, mirroring `src/selfhost/ai.ts`'s `defaultSpawn`.
 * The factory stays sync; the import runs on the first `run()` call.
 */
export function createDefaultCliSubprocessSpawn(): CliSubprocessSpawnFn {
  /* v8 ignore start -- real child_process path; factory tests inject a fake SpawnFn (same convention as the CLI driver). */
  let impl: CliSubprocessSpawnFn | undefined;
  let loading: Promise<CliSubprocessSpawnFn> | undefined;
  return async (cmd, args, opts) => {
    if (!impl) {
      loading ??= (async () => {
        const cp = await import("node:child_process");
        const real: CliSubprocessSpawnFn = (spawnCmd, spawnArgs, spawnOpts) =>
          new Promise((resolve) => {
            const child = cp.spawn(spawnCmd, [...spawnArgs], {
              cwd: spawnOpts.cwd,
              env: spawnOpts.env as NodeJS.ProcessEnv,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout?.on("data", (chunk: Buffer | string) => {
              stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            });
            child.stderr?.on("data", (chunk: Buffer | string) => {
              stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
            });
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve({ stdout, code: null, stderr, timedOut: true });
            }, spawnOpts.timeoutMs);
            child.on("error", (error) => {
              clearTimeout(timer);
              resolve({ stdout, code: null, stderr: error.message });
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              resolve({ stdout, code, stderr });
            });
          });
        impl = real;
        return real;
      })();
      impl = await loading;
    }
    return impl(cmd, args, opts);
  };
  /* v8 ignore stop */
}

/** True when `name` is a known, configured coding-agent driver. Unknown names → false (deny-by-default). */
export function isConfiguredCodingAgentDriver(
  name: string,
  _env: Record<string, string | undefined>,
): boolean {
  switch (name) {
    case "noop":
    // Local CLIs need no API key (same posture as `claude-code`/`codex` in `isConfiguredSelfHostProvider`).
    case "cli-subprocess":
    // Agent-SDK is a package dependency; the real `query()` path is a lazy dynamic import behind the driver default.
    case "agent-sdk":
      return true;
    default:
      return false;
  }
}

export function resolveConfiguredCodingAgentDriverNames(
  env: Record<string, string | undefined>,
): string[] {
  return parseDriverNames(env).filter((name) => isConfiguredCodingAgentDriver(name, env));
}

export type CreateCodingAgentDriverOptions = {
  providerName: string;
  env?: Record<string, string | undefined> | undefined;
  /** Test seam — inject a fake driver instead of constructing the named provider. */
  driver?: CodingAgentDriver | undefined;
  /** Injected CLI spawn for `cli-subprocess` (defaults to a real `child_process` spawn). */
  spawn?: CliSubprocessSpawnFn | undefined;
  /** Injected Agent-SDK `query()` for `agent-sdk` (defaults to the real SDK export). */
  query?: AgentSdkQueryFn | undefined;
  /** Forwarded onto the Agent-SDK session (`PreToolUse` etc.). */
  hooks?: AgentSdkHooks | undefined;
  /** Override the CLI binary name (else `MINER_CODING_AGENT_CLI` / `claude`). */
  command?: string | undefined;
  /** Override the CLI wall-clock budget (else `MINER_CODING_AGENT_TIMEOUT_MS` / 120s). */
  timeoutMs?: number | undefined;
};

/** Resolve a concrete driver for `providerName`. Throws on unknown/unconfigured providers (fail-closed). */
export function createCodingAgentDriver(options: CreateCodingAgentDriverOptions): CodingAgentDriver {
  if (options.driver) return options.driver;
  const name = options.providerName.trim().toLowerCase();
  const env = options.env ?? {};
  if (!isConfiguredCodingAgentDriver(name, env)) {
    throw new Error(`unconfigured_coding_agent_driver:${name}`);
  }
  switch (name) {
    case "noop":
      return createNoopCodingAgentDriver();
    case "cli-subprocess": {
      const command =
        firstConfigured(options.command, env.MINER_CODING_AGENT_CLI) ?? DEFAULT_CLI_COMMAND;
      const timeoutMs =
        options.timeoutMs ??
        parsePositiveInt(env.MINER_CODING_AGENT_TIMEOUT_MS, DEFAULT_CLI_TIMEOUT_MS);
      return createCliSubprocessCodingAgentDriver({
        command,
        spawn: options.spawn ?? createDefaultCliSubprocessSpawn(),
        parentEnv: env,
        timeoutMs,
      });
    }
    case "agent-sdk":
      return createAgentSdkCodingAgentDriver({
        query: options.query,
        hooks: options.hooks,
      });
    /* v8 ignore next -- isConfiguredCodingAgentDriver already rejects unknown names before this switch. */
    default:
      throw new Error(`unconfigured_coding_agent_driver:${name}`);
  }
}

export type RunCodingAgentAttemptOptions = {
  providerName: string;
  env?: Record<string, string | undefined> | undefined;
  agentPaused?: boolean | null | undefined;
  agentDryRun?: boolean | null | undefined;
  task: CodingAgentDriverTask;
  log?: AttemptLogSink | undefined;
  driver?: CodingAgentDriver | undefined;
  spawn?: CliSubprocessSpawnFn | undefined;
  query?: AgentSdkQueryFn | undefined;
  hooks?: AgentSdkHooks | undefined;
  command?: string | undefined;
  timeoutMs?: number | undefined;
  /** When supplied, the driver result is run through the lint guard (#4276) before being returned, so a
   *  live coding-agent edit that fails its own package's typecheck/node --check never reads as `ok: true`. */
  lintGuard?: LintGuardOptions | undefined;
};

/** End-to-end entry: resolve mode from config, pick the driver, invoke under mode gating + attempt log, then
 *  (when `lintGuard` is supplied) run the changed files through the lint guard before the caller sees the result. */
export async function runCodingAgentAttempt(
  options: RunCodingAgentAttemptOptions,
): Promise<{
  mode: CodingAgentExecutionMode;
  result: CodingAgentDriverResult & { lintGuard?: LintGuardResult };
}> {
  const mode = resolveCodingAgentModeFromConfig({
    env: options.env,
    agentPaused: options.agentPaused,
    agentDryRun: options.agentDryRun,
  });
  const driver = createCodingAgentDriver({
    providerName: options.providerName,
    env: options.env,
    driver: options.driver,
    spawn: options.spawn,
    query: options.query,
    hooks: options.hooks,
    command: options.command,
    timeoutMs: options.timeoutMs,
  });
  const result = await invokeCodingAgentDriver(driver, mode, options.task, options.log);
  if (!options.lintGuard) return { mode, result };
  return { mode, result: await guardCodingAgentDriverResult(result, options.lintGuard) };
}

/** Exported for parity tests — wraps a driver without changing its behavior (identity helper). */
export function createFakeCodingAgentDriverForFactory(): CodingAgentDriver {
  return createFakeCodingAgentDriver();
}
