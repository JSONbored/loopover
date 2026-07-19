import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";
import type { CodingAgentDriverName } from "@loopover/engine";
import { initLaptopState } from "./laptop-init.js";
import { resolveMinerStateDir, runDoctor } from "./status.js";
import { DeviceFlowError, resolveAmsOauthClientId, runDeviceFlowAuthorization } from "./oauth-device-flow.js";

// First-run onboarding wizard for `loopover-miner init --interactive` (#5176): prompts for a GITHUB_TOKEN
// (masked, never echoed to stdout/logs) and an optional coding-agent provider + its companion vars, writes them
// to a starter .env in the state dir, then reruns the existing offline `doctor` checks against the collected
// values so the operator sees pass/fail immediately. `doctor` itself stays offline by contract (status.js), and
// this module never calls verifyGithubToken (that stays behind the separate, explicitly opt-in
// `init --verify-token` flag).
//
// #5682: when LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID is configured, the wizard offers "Authorize with GitHub"
// (device flow -- see oauth-device-flow.js) as an ADDITIONAL onboarding path alongside the original pasted-PAT
// prompt, never replacing it. Unconfigured (today's default -- the App isn't registered yet) is byte-identical
// to the original prompt-only flow, so every existing deployment is unaffected until an operator opts in.

export type WizardIo = {
  promptText(question: string): Promise<string>;
  promptMasked(question: string): Promise<string>;
  writeLine(text: string): void;
  close?: () => void;
  /** Whether this `io`'s underlying input is a real, interactive terminal. Optional -- a fake test `io` that
   *  omits it is treated as interactive (matching every pre-#6846 test's existing behavior); `createWizardIo`'s
   *  real adapter always sets it from the actual stream's `isTTY`. */
  isInteractive?: boolean;
};

export type RunInteractiveInitOptions = {
  /** DI override for the device-flow's outbound fetch calls (tests never touch the real network). */
  fetchImpl?: typeof fetch;
  /** DI override for the device-flow poll loop's sleep between requests (tests never wait on a real timer). */
  sleepFn?: (ms: number) => Promise<void>;
};

/** Readline's private output hook used for masked prompts — not in the public Interface typings. */
type MaskableReadline = Interface & {
  _writeToOutput(stringToWrite: string): void;
};

type StreamWithTty = NodeJS.ReadableStream & { isTTY?: boolean };

const COMPANION_VAR_LABELS: Record<string, string> = {
  model: "model override",
  timeoutMs: "timeout in milliseconds",
};

/** Where the wizard writes its starter .env file: the miner state dir, the same directory `init` already uses
 *  for laptop-state.sqlite3. */
export function resolveWizardEnvFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(resolveMinerStateDir(env), ".env");
}

/** Render collected `[KEY, value]` pairs as sourceable `KEY=value` lines, one per entry, insertion order. Pure
 *  and filesystem-free so it is directly testable. */
export function renderWizardEnvFile(entries: ReadonlyArray<readonly [string, string]>): string {
  if (entries.length === 0) return "";
  return `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function promptRequiredMasked(io: WizardIo, question: string): Promise<string> {
  for (;;) {
    const answer = (await io.promptMasked(question)).trim();
    if (answer) return answer;
    io.writeLine("A value is required -- please try again.");
  }
}

async function promptAuthMethod(io: WizardIo): Promise<"device" | "token"> {
  io.writeLine("How would you like to authorize loopover-miner?");
  io.writeLine("  1) Authorize with GitHub (recommended -- no token to copy)");
  io.writeLine("  2) Paste a GitHub token (personal access token)");
  for (;;) {
    const answer = (await io.promptText("Choice [1/2, default 1]: ")).trim();
    if (!answer || answer === "1") return "device";
    if (answer === "2") return "token";
    io.writeLine("Enter 1 or 2.");
  }
}

/**
 * Collect a GitHub credential for the wizard's starter .env. When LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID isn't
 * configured (today's default, before the loopover-ams App is registered), this is IDENTICAL to the original
 * masked-token-only prompt -- no menu, no behavior change. Once configured, offers device-flow authorization as
 * the default choice, with the original pasted-token path still available (option 2) and as the automatic
 * fallback on any device-flow failure -- never a hard dependency.
 */
async function collectGithubToken(
  io: WizardIo,
  env: Record<string, string | undefined>,
  options: RunInteractiveInitOptions,
): Promise<string> {
  const clientId = resolveAmsOauthClientId(env);
  if (!clientId) return promptRequiredMasked(io, "GitHub token (input hidden): ");

  const method = await promptAuthMethod(io);
  if (method === "token") return promptRequiredMasked(io, "GitHub token (input hidden): ");

  try {
    const { accessToken } = await runDeviceFlowAuthorization({
      clientId,
      ...(options.fetchImpl !== undefined ? { fetchFn: options.fetchImpl } : {}),
      ...(options.sleepFn !== undefined ? { sleepFn: options.sleepFn } : {}),
      onCode: (code) => {
        io.writeLine("");
        io.writeLine(`To authorize, visit ${code.verificationUri} and enter code: ${code.userCode}`);
        io.writeLine("Waiting for authorization...");
      },
    });
    io.writeLine("Authorized.");
    return accessToken;
  } catch (error) {
    const reason = error instanceof DeviceFlowError ? error.code : "device_flow_failed";
    io.writeLine(`Device-flow authorization failed (${reason}) -- falling back to a pasted token.`);
    return promptRequiredMasked(io, "GitHub token (input hidden): ");
  }
}

/**
 * Menu selection sourced from the engine's own `CODING_AGENT_DRIVER_NAMES`, so the choices can never drift from
 * what the driver factory actually resolves. Empty input SKIPS provider selection entirely (leaves
 * MINER_CODING_AGENT_PROVIDER unwritten, deferring to whatever default the CLI already resolves) -- distinct
 * from explicitly choosing the `noop` entry.
 */
export async function promptProviderSelection(io: WizardIo): Promise<string | null> {
  io.writeLine("Select a coding-agent provider (press Enter to skip and use the default):");
  CODING_AGENT_DRIVER_NAMES.forEach((name, index) => {
    io.writeLine(`  ${index + 1}) ${name}`);
  });
  for (;;) {
    const answer = (await io.promptText(`Provider [1-${CODING_AGENT_DRIVER_NAMES.length}, or Enter to skip]: `)).trim();
    if (!answer) return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < CODING_AGENT_DRIVER_NAMES.length) {
      return CODING_AGENT_DRIVER_NAMES[index] ?? null;
    }
    io.writeLine(`Enter a number from 1 to ${CODING_AGENT_DRIVER_NAMES.length}, or press Enter to skip.`);
  }
}

/**
 * Optional, skippable per-provider companion vars (model override / timeout), sourced from the same
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map the real driver factory reads -- never a hand-duplicated var-name list
 * that could drift. Empty input skips that one var; its built-in default (if any) applies at run time as usual.
 */
export async function promptCompanionVars(io: WizardIo, provider: string): Promise<Array<[string, string]>> {
  const varsForProvider =
    CODING_AGENT_DRIVER_CONFIG_ENV[provider as CodingAgentDriverName] ?? {};
  const collected: Array<[string, string]> = [];
  for (const [kind, envVarName] of Object.entries(varsForProvider)) {
    if (typeof envVarName !== "string") continue;
    const label = COMPANION_VAR_LABELS[kind] ?? kind;
    const answer = (
      await io.promptText(`Optional ${label} for ${provider} (env ${envVarName}) [Enter to skip]: `)
    ).trim();
    if (answer) collected.push([envVarName, answer]);
  }
  return collected;
}

/**
 * Run the interactive onboarding wizard end to end: collect GITHUB_TOKEN (pasted, or via device-flow
 * authorization when configured -- see collectGithubToken) + optional provider config, write the starter .env,
 * initialize laptop state, then rerun the existing offline doctor checks against the collected values. Returns
 * doctor's exit code. `io` is injected so tests never touch a real terminal; `options.fetchImpl`/`sleepFn` are
 * injected so tests never make a real network call or wait on a real timer during device-flow polling.
 */
export async function runInteractiveInit(
  env: Record<string, string | undefined>,
  cwd: string,
  io: WizardIo,
  options: RunInteractiveInitOptions = {},
): Promise<number> {
  // #6846: fail fast, not silently forever. `io.isInteractive` is only ever `false` for a real
  // `createWizardIo()` adapter over a non-TTY stdin (a test's fake `io` has no such field and stays
  // interactive by default, so every existing test is unaffected) -- an operator running this over a
  // no-pty SSH session or a CI/fleet script gets clear, actionable guidance instead of a hang on the
  // wizard's first prompt, which can never receive a real line of input.
  if (io.isInteractive === false) {
    io.writeLine("init --interactive requires a real terminal (no TTY detected on stdin).");
    io.writeLine("For an unattended/fleet setup, skip this wizard and set these env vars directly instead:");
    io.writeLine("  - GITHUB_TOKEN (your GitHub credential)");
    io.writeLine("  - MINER_CODING_AGENT_PROVIDER (claude-cli or codex-cli)");
    io.writeLine("  - ANTHROPIC_API_KEY for claude-cli, or OPENAI_API_KEY for codex-cli");
    io.writeLine("Then verify with: loopover-miner doctor");
    return 3;
  }
  const githubToken = await collectGithubToken(io, env, options);
  const provider = await promptProviderSelection(io);

  const entries: Array<[string, string]> = [["GITHUB_TOKEN", githubToken]];
  if (provider) {
    entries.push(["MINER_CODING_AGENT_PROVIDER", provider]);
    entries.push(...(await promptCompanionVars(io, provider)));
  }

  const stateDir = resolveMinerStateDir(env);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const envFilePath = resolveWizardEnvFilePath(env);
  // { mode: 0o600 } on writeFileSync applies only when the file is newly created -- an existing file (e.g. from
  // a prior wizard run, or hand-created by the operator with looser permissions) keeps its current mode across
  // a write. The chmodSync below still runs unconditionally so the end state is always 0600 either way; the
  // writeFileSync mode option exists so a BRAND NEW file is never briefly readable at the default umask
  // permissions between being created and being locked down.
  writeFileSync(envFilePath, renderWizardEnvFile(entries), { mode: 0o600 });
  chmodSync(envFilePath, 0o600);
  io.writeLine(`wrote ${envFilePath}`);

  const initResult = initLaptopState(env);
  io.writeLine(`initialized ${initResult.stateDir}`);
  io.writeLine(`sqlite: ${initResult.dbPath}${initResult.created ? "" : " (already existed)"}`);

  const mergedEnv: Record<string, string | undefined> = { ...env };
  for (const [key, value] of entries) mergedEnv[key] = value;

  io.writeLine("");
  io.writeLine("Running doctor against the new configuration:");
  return runDoctor([], mergedEnv, cwd);
}

/**
 * Real terminal I/O for the wizard. Masked input is implemented by overriding readline's own output-write hook
 * to render `*` instead of the typed prompt's characters while the interface is still doing its normal
 * cooked-mode line editing (Enter/Backspace all still work exactly as with a plain prompt) -- no raw-mode byte
 * handling and no extra dependency. `input`/`output` are parameters (defaulting to the real stdio) purely so
 * tests can drive the exact same code path with fake streams instead of a real terminal.
 */
export function createWizardIo(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): WizardIo & { close: () => void; isInteractive: boolean } {
  const rl = createInterface({ input, output, terminal: true }) as MaskableReadline;
  const originalWriteToOutput = rl._writeToOutput.bind(rl);
  let masking = false;
  rl._writeToOutput = (stringToWrite: string) => {
    originalWriteToOutput(masking ? "*" : stringToWrite);
  };
  return {
    // #6846: whether `input` is a real, interactive terminal -- `runInteractiveInit` checks this BEFORE
    // issuing its first prompt, so a no-TTY invocation (piped stdin, a plain `ssh host "loopover-miner init
    // --interactive"` with no allocated pty) fails fast with actionable guidance instead of hanging forever
    // on a `readline` prompt that can never receive a real line of input.
    isInteractive: Boolean((input as StreamWithTty).isTTY),
    promptText(question: string) {
      return new Promise((resolve) => rl.question(question, resolve));
    },
    promptMasked(question: string) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          masking = false;
          resolve(answer);
        });
        masking = true;
      });
    },
    writeLine(text: string) {
      output.write(`${text}\n`);
    },
    close() {
      rl.close();
    },
  };
}
