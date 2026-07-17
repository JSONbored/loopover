// CodingAgentDriver factory + provider-style config resolution (#4289). Mirrors `src/selfhost/ai-config.ts:41-74`:
// parse a comma-separated provider list, validate each name against what is actually configured, deny-by-default
// on unknown/unconfigured names, and expose a model/effort config map analogous to `SELF_HOST_REVIEWER_MODEL_ENV`.

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
  codingAgentModeExecutes,
  resolveCodingAgentModeFromConfig,
  type CodingAgentExecutionMode,
} from "./coding-agent-mode.js";
import type { CodingAgentDriverResult, CodingAgentDriverTask } from "./coding-agent-driver.js";
import { guardCodingAgentDriverResult, type LintGuardOptions, type LintGuardResult } from "./lint-guard.js";
import {
  createCliSubprocessCodingAgentDriver,
  defaultClaudeCliArgs,
  defaultCodexCliArgs,
  type CliSubprocessSpawnFn,
} from "./cli-subprocess-driver.js";
import {
  createAgentSdkCodingAgentDriver,
  type AgentSdkHooks,
  type AgentSdkQueryFn,
} from "./agent-sdk-driver.js";

/** Provider names the factory resolves: the two concrete drivers from #4266/#4267 (`claude-cli`/`codex-cli`
 *  spawn the respective CLI; `agent-sdk` runs in-process via the Agent SDK) plus the `noop` stub. All are
 *  locally-authenticated (no API-key env requirement), mirroring how `isConfiguredSelfHostProvider` treats
 *  `claude-code`/`codex` as always-configured. */
export const CODING_AGENT_DRIVER_NAMES = Object.freeze(["noop", "claude-cli", "codex-cli", "agent-sdk"] as const);

export type CodingAgentDriverName = (typeof CODING_AGENT_DRIVER_NAMES)[number];

/** Per-provider env keys for coding-agent configuration (mirrors `SELF_HOST_REVIEWER_MODEL_ENV`). Every key
 *  declared here is CONSUMED by `createCodingAgentDriver` below — a declared-but-unread entry is dead,
 *  misleading config-as-code surface. Deliberately NOT declared: a max-turns key (the turn budget is task-level
 *  input — `CodingAgentDriverTask.maxTurns` — set by the orchestrator per attempt, not per-provider config) and
 *  an agent-sdk model key (the SDK session uses the account/CLI default; it exposes no model option on the
 *  driver today). A CLI provider's own credential env is NOT declared here either — it is not a per-provider
 *  "companion var" an operator sets, and this map's one-kind-to-one-env-var-NAME shape is relied on by generic
 *  consumers (`init-wizard.js`'s `promptCompanionVars`); see `CODING_AGENT_CLI_CREDENTIAL_ENV` below. */
export const CODING_AGENT_DRIVER_CONFIG_ENV: Readonly<Record<CodingAgentDriverName, { model?: string; timeoutMs?: string }>> =
  Object.freeze({
    noop: {},
    "claude-cli": { model: "MINER_CODING_AGENT_CLAUDE_MODEL", timeoutMs: "MINER_CODING_AGENT_TIMEOUT_MS" },
    "codex-cli": { model: "MINER_CODING_AGENT_CODEX_MODEL", timeoutMs: "MINER_CODING_AGENT_TIMEOUT_MS" },
    "agent-sdk": {},
  });

/** The credential env var each CLI provider authenticates with, in preference order (#6875). Kept OUT of
 *  `CODING_AGENT_DRIVER_CONFIG_ENV` deliberately: that map's contract is one `kind -> single env var NAME`, and
 *  its generic consumers rely on it — `init-wizard.js`'s `promptCompanionVars` iterates its entries and prompts
 *  once per value, so a list-valued entry there renders as
 *  `Optional undefined for claude-cli (env CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY)` and writes a junk .env
 *  line if answered. These are also not "companion vars" an operator sets per provider — they are the upstream
 *  CLI's own credential, which is why they are declared here instead.
 *
 *  Keyed by the CLI `command` rather than the driver name because only the two spawning providers have one:
 *  `agent-sdk` authenticates in-process and `noop` runs nothing, so neither can appear here, and the lookup is
 *  total (no unreachable fallback branch). Order is preference order — the first configured key wins, mirroring
 *  `firstConfiguredEnvValue`. Not a REQUIREMENT: `isConfiguredCodingAgentDriver` treats CLI providers as
 *  locally-authenticated, so a credential persisted under `HOME` is the equally-valid other path. */
export const CODING_AGENT_CLI_CREDENTIAL_ENV: Readonly<Record<"claude" | "codex", readonly string[]>> =
  Object.freeze({
    claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    codex: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
  });

/** `firstConfigured` (src/selfhost/ai.ts:117-134) pattern: a set-and-non-empty env value, else undefined. */
function firstConfiguredEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Positive-integer env parse for the CLI wall-clock ceiling; anything else defers to the driver default. */
function configuredTimeoutMs(env: Record<string, string | undefined>): number | undefined {
  const raw = Number(firstConfiguredEnvValue(env.MINER_CODING_AGENT_TIMEOUT_MS));
  return Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function parseDriverNames(env: Record<string, string | undefined>): string[] {
  return (env.MINER_CODING_AGENT_PROVIDER ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `name` is a known, configured coding-agent driver. Unknown names → false (deny-by-default). */
export function isConfiguredCodingAgentDriver(
  name: string,
  _env: Record<string, string | undefined>,
): boolean {
  switch (name) {
    case "noop":
    case "claude-cli":
    case "codex-cli":
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

/** Primary-then-fallback resolution over `MINER_CODING_AGENT_PROVIDER`'s comma-separated list (the same
 *  fallback-chain semantic `AiRunOptions.fallback` gives reviewers): the FIRST configured name wins; unknown
 *  names are skipped (deny-by-default), and an all-unknown/empty list resolves to undefined so the caller
 *  fails closed rather than falling through to some implicit default driver. */
export function resolveFirstConfiguredCodingAgentDriverName(
  env: Record<string, string | undefined>,
): string | undefined {
  return resolveConfiguredCodingAgentDriverNames(env)[0];
}

export type CreateCodingAgentDriverOptions = {
  providerName: string;
  env?: Record<string, string | undefined> | undefined;
  /** Test seam — inject a fake driver instead of constructing the named provider. */
  driver?: CodingAgentDriver | undefined;
  /** Subprocess runner for the CLI providers (`claude-cli`/`codex-cli`). REQUIRED for those providers — the
   *  engine package ships no default spawn, so constructing a CLI driver without one fails closed rather than
   *  producing a driver that can never run. */
  spawn?: CliSubprocessSpawnFn | undefined;
  /** Optional injected `query()` loop for the `agent-sdk` provider (defaults to the real SDK import). */
  query?: AgentSdkQueryFn | undefined;
  /** Forwarded to the `agent-sdk` provider's session (#2343's PreToolUse interception point). */
  hooks?: AgentSdkHooks | undefined;
  /** Optional injected changed-file enumerator for the `agent-sdk` provider (defaults to a real `git diff`/
   *  `git ls-files` read over the task's working directory — a test harness pointing at a non-git fake path
   *  should inject one, same seam as `query`). */
  listChangedFiles?: ((cwd: string) => Promise<string[]>) | undefined;
  /** Known secret values the CLI providers strip from surfaced output, on top of the token-shape patterns. */
  knownSecrets?: readonly string[] | undefined;
};

/** Build a CLI provider's argv: the driver's own real default argv contract, with the CONFIGURED model
 *  flag inserted at the RIGHT position for that command — this is where that declared config is actually
 *  consumed. claude's `--model` is a top-level flag (prefixed before everything else is fine); codex's
 *  `-m`/`--model` is scoped to the `exec` subcommand (per `codex exec --help`) and must be inserted AFTER
 *  the leading `"exec"` token, not before it — a single shared prefix-everything scheme would silently
 *  misparse for codex. */
function buildCliArgsWithConfiguredModel(
  command: "claude" | "codex",
  model: string | undefined,
): ((task: CodingAgentDriverTask) => readonly string[]) | undefined {
  if (model === undefined) return undefined;
  if (command === "claude") {
    return (task) => ["--model", model, ...defaultClaudeCliArgs(task)];
  }
  return (task) => {
    const [subcommand, ...rest] = defaultCodexCliArgs(task);
    return [subcommand!, "--model", model, ...rest];
  };
}

/** Resolve the ONE credential the selected CLI actually authenticates with, as a `{key: value}` overlay for the
 *  driver's `env` (#6875). Returns `{}` when none is configured — a CLI provider is locally-authenticated, so a
 *  credential persisted under `HOME` is the equally-valid other path and an absent key must not fail closed
 *  here. Only the FIRST configured key of that command's own list is returned: forwarding every credential an
 *  operator happens to have exported would hand a prompt-injectable subprocess keys it has no use for. */
function resolveProviderCredentialEnv(
  command: "claude" | "codex",
  env: Record<string, string | undefined>,
): Record<string, string> {
  for (const key of CODING_AGENT_CLI_CREDENTIAL_ENV[command]) {
    const value = firstConfiguredEnvValue(env[key]);
    if (value !== undefined) return { [key]: value };
  }
  return {};
}

function createCliProvider(
  command: "claude" | "codex",
  modelEnvKey: string,
  options: CreateCodingAgentDriverOptions,
  env: Record<string, string | undefined>,
): CodingAgentDriver {
  if (!options.spawn) {
    // Fail-closed (resolveAutonomy's deny-by-default precedent): a CLI provider without a spawn dependency is
    // unconfigured in the way that matters — never hand back a driver whose every run() would throw.
    throw new Error(`unconfigured_coding_agent_driver_missing_spawn:${command}-cli`);
  }
  if (options.hooks !== undefined) {
    // CLI subprocess providers have no hook-registration surface. If a caller supplied house-rule hooks, treating
    // them as "best effort" would silently run prompt-influenced local code without the policy the caller asked
    // for, so fail closed until a CLI-native enforcement layer exists.
    throw new Error(`unsupported_coding_agent_driver_hooks:${command}-cli`);
  }
  const model = firstConfiguredEnvValue(env[modelEnvKey]);
  const timeoutMs = configuredTimeoutMs(env);
  const buildArgs = buildCliArgsWithConfiguredModel(command, model);
  // The credential rides in as the driver's `env` OVERLAY rather than as an allowlist entry (#6875). This is
  // the pattern `createClaudeCodeAi` (src/selfhost/ai.ts) already uses for the REVIEWER CLI, for the reason
  // stated there verbatim: threaded "explicitly here ... rather than widening SUBSCRIPTION_CLI_ENV_ALLOWLIST
  // itself (which also gates the codex subprocess and should stay minimal)". Identical logic applies here --
  // the allowlist is shared and provider-agnostic, so putting credential names in it would hand codex's key to
  // a claude subprocess and vice versa. Resolving the overlay per provider is what keeps this least-privilege.
  // `buildAllowlistedEnv` applies `extra` last, so it wins over any allowlisted parent value.
  const credentialEnv = resolveProviderCredentialEnv(command, env);
  // Anything we deliberately hand the child must also be redactable out of anything the child says back: the
  // subprocess is prompt-injectable, and its stdout becomes a stored transcript and an error detail. The driver
  // already redacts `knownSecrets` from both -- it just never had this value to redact. Merged with (not
  // replacing) a caller's own list.
  const knownSecrets = [...(options.knownSecrets ?? []), ...Object.values(credentialEnv)];
  return createCliSubprocessCodingAgentDriver({
    command,
    spawn: options.spawn,
    parentEnv: env,
    ...(Object.keys(credentialEnv).length > 0 ? { env: credentialEnv } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(buildArgs !== undefined ? { buildArgs } : {}),
    ...(knownSecrets.length > 0 ? { knownSecrets } : {}),
  });
}

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
    case "claude-cli":
      return createCliProvider("claude", "MINER_CODING_AGENT_CLAUDE_MODEL", options, env);
    case "codex-cli":
      return createCliProvider("codex", "MINER_CODING_AGENT_CODEX_MODEL", options, env);
    case "agent-sdk":
      // No model/timeout config today — the SDK session uses the account default; hooks/query are optional.
      return createAgentSdkCodingAgentDriver({
        ...(options.query !== undefined ? { query: options.query } : {}),
        ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
        ...(options.listChangedFiles !== undefined ? { listChangedFiles: options.listChangedFiles } : {}),
      });
    /* v8 ignore next 2 -- isConfiguredCodingAgentDriver already rejects unknown names before this switch. */
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
  /** Provider dependencies, forwarded to `createCodingAgentDriver` (see `CreateCodingAgentDriverOptions`). */
  spawn?: CliSubprocessSpawnFn | undefined;
  query?: AgentSdkQueryFn | undefined;
  hooks?: AgentSdkHooks | undefined;
  /** Optional injected changed-file enumerator for the `agent-sdk` provider (see `CreateCodingAgentDriverOptions`). */
  listChangedFiles?: ((cwd: string) => Promise<string[]>) | undefined;
  knownSecrets?: readonly string[] | undefined;
  /** When supplied, the driver result is run through the lint guard (#4276) before being returned, so a
   *  live coding-agent edit that fails its own package's typecheck/node --check never reads as `ok: true`. */
  lintGuard?: LintGuardOptions | undefined;
};

function resolveDriverForAttempt(options: RunCodingAgentAttemptOptions, mode: CodingAgentExecutionMode): CodingAgentDriver {
  if (options.driver) return options.driver;
  // Dry-run/paused attempts never call `driver.run()` (see coding-agent-driver.md lifecycle). Constructing a
  // CLI provider here would require spawn/query deps even though they would never be used — use the noop stub
  // as a stand-in so shadow/paused attempts stay dependency-free (#4289 / gate fix for #4593).
  if (!codingAgentModeExecutes(mode)) return createNoopCodingAgentDriver();
  return createCodingAgentDriver({
    providerName: options.providerName,
    env: options.env,
    spawn: options.spawn,
    query: options.query,
    hooks: options.hooks,
    listChangedFiles: options.listChangedFiles,
    knownSecrets: options.knownSecrets,
  });
}

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
  const driver = resolveDriverForAttempt(options, mode);
  const result = await invokeCodingAgentDriver(driver, mode, options.task, options.log);
  if (!options.lintGuard) return { mode, result };
  return { mode, result: await guardCodingAgentDriverResult(result, options.lintGuard) };
}

/** Exported for parity tests — wraps a driver without changing its behavior (identity helper). */
export function createFakeCodingAgentDriverForFactory(): CodingAgentDriver {
  return createFakeCodingAgentDriver();
}
