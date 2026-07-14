import { createInterface } from "node:readline";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_AGENT_DRIVER_CONFIG_ENV, CODING_AGENT_DRIVER_NAMES } from "@loopover/engine";
import { initLaptopState } from "./laptop-init.js";
import { resolveMinerStateDir, runDoctor } from "./status.js";
import { DeviceFlowError, resolveAmsOauthClientId, runDeviceFlowAuthorization } from "./oauth-device-flow.js";

// First-run onboarding wizard for `gittensory-miner init --interactive` (#5176): prompts for a GITHUB_TOKEN
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

const COMPANION_VAR_LABELS = { model: "model override", timeoutMs: "timeout in milliseconds" };

/** Where the wizard writes its starter .env file: the miner state dir, the same directory `init` already uses
 *  for laptop-state.sqlite3. */
export function resolveWizardEnvFilePath(env = process.env) {
  return join(resolveMinerStateDir(env), ".env");
}

/** Render collected `[KEY, value]` pairs as sourceable `KEY=value` lines, one per entry, insertion order. Pure
 *  and filesystem-free so it is directly testable. */
export function renderWizardEnvFile(entries) {
  if (entries.length === 0) return "";
  return `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function promptRequiredMasked(io, question) {
  for (;;) {
    const answer = (await io.promptMasked(question)).trim();
    if (answer) return answer;
    io.writeLine("A value is required -- please try again.");
  }
}

async function promptAuthMethod(io) {
  io.writeLine("How would you like to authorize gittensory-miner?");
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
async function collectGithubToken(io, env, options) {
  const clientId = resolveAmsOauthClientId(env);
  if (!clientId) return promptRequiredMasked(io, "GitHub token (input hidden): ");

  const method = await promptAuthMethod(io);
  if (method === "token") return promptRequiredMasked(io, "GitHub token (input hidden): ");

  try {
    const { accessToken } = await runDeviceFlowAuthorization({
      clientId,
      fetchFn: options.fetchImpl,
      sleepFn: options.sleepFn,
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
export async function promptProviderSelection(io) {
  io.writeLine("Select a coding-agent provider (press Enter to skip and use the default):");
  CODING_AGENT_DRIVER_NAMES.forEach((name, index) => {
    io.writeLine(`  ${index + 1}) ${name}`);
  });
  for (;;) {
    const answer = (await io.promptText(`Provider [1-${CODING_AGENT_DRIVER_NAMES.length}, or Enter to skip]: `)).trim();
    if (!answer) return null;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && index >= 0 && index < CODING_AGENT_DRIVER_NAMES.length) {
      return CODING_AGENT_DRIVER_NAMES[index];
    }
    io.writeLine(`Enter a number from 1 to ${CODING_AGENT_DRIVER_NAMES.length}, or press Enter to skip.`);
  }
}

/**
 * Optional, skippable per-provider companion vars (model override / timeout), sourced from the same
 * `CODING_AGENT_DRIVER_CONFIG_ENV` map the real driver factory reads -- never a hand-duplicated var-name list
 * that could drift. Empty input skips that one var; its built-in default (if any) applies at run time as usual.
 */
export async function promptCompanionVars(io, provider) {
  const varsForProvider = CODING_AGENT_DRIVER_CONFIG_ENV[provider] ?? {};
  const collected = [];
  for (const [kind, envVarName] of Object.entries(varsForProvider)) {
    const label = COMPANION_VAR_LABELS[kind];
    const answer = (await io.promptText(`Optional ${label} for ${provider} (env ${envVarName}) [Enter to skip]: `)).trim();
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
export async function runInteractiveInit(env, cwd, io, options = {}) {
  const githubToken = await collectGithubToken(io, env, options);
  const provider = await promptProviderSelection(io);

  const entries = [["GITHUB_TOKEN", githubToken]];
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

  const mergedEnv = { ...env };
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
export function createWizardIo(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output, terminal: true });
  const originalWriteToOutput = rl._writeToOutput.bind(rl);
  let masking = false;
  rl._writeToOutput = (stringToWrite) => {
    originalWriteToOutput(masking ? "*" : stringToWrite);
  };
  return {
    promptText(question) {
      return new Promise((resolve) => rl.question(question, resolve));
    },
    promptMasked(question) {
      return new Promise((resolve) => {
        rl.question(question, (answer) => {
          masking = false;
          resolve(answer);
        });
        masking = true;
      });
    },
    writeLine(text) {
      output.write(`${text}\n`);
    },
    close() {
      rl.close();
    },
  };
}
