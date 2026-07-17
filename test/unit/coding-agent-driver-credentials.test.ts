import { describe, expect, it } from "vitest";
import {
  CODING_AGENT_CLI_CREDENTIAL_ENV,
  CODING_AGENT_DRIVER_CONFIG_ENV,
  createCodingAgentDriver,
} from "../../packages/loopover-engine/src/index";
import type { CodingAgentDriverTask } from "../../packages/loopover-engine/src/index";

// #6875: what the spawned coding-agent subprocess actually receives in its env. The pre-existing CLI-provider
// cases assert the ARGV shape only, which is why a driver that could never authenticate shipped green -- every
// case here asserts `opts.env` instead.

const TASK: CodingAgentDriverTask = {
  attemptId: "attempt-6875",
  workingDirectory: "/tmp/work",
  acceptanceCriteriaPath: "/tmp/work/ACCEPTANCE.md",
  instructions: "fix the flaky test",
  maxTurns: 4,
};

/** Run a CLI provider against a fake spawn and hand back the env the child would really have received. */
async function spawnedEnv(
  providerName: "claude-cli" | "codex-cli",
  env: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  let captured: Record<string, string | undefined> = {};
  const driver = createCodingAgentDriver({
    providerName,
    env,
    spawn: async (_cmd, _args, opts) => {
      captured = opts.env;
      return { stdout: "done", code: 0 };
    },
  });
  await driver.run(TASK);
  return captured;
}

describe("coding-agent CLI subprocess env (#6875)", () => {
  it("forwards HOME and the XDG config paths to the child", async () => {
    // Without these the CLI cannot locate its persisted credential and answers "Not logged in · Please run
    // /login" behind an is_error:true + subtype:"success" envelope -- i.e. claude_code_error_success, 0 turns.
    const env = await spawnedEnv("claude-cli", {
      HOME: "/home/miner",
      XDG_CONFIG_HOME: "/home/miner/.config",
      XDG_DATA_HOME: "/home/miner/.local/share",
      XDG_STATE_HOME: "/home/miner/.local/state",
      PATH: "/usr/bin",
    });
    expect(env.HOME).toBe("/home/miner");
    expect(env.XDG_CONFIG_HOME).toBe("/home/miner/.config");
    expect(env.XDG_DATA_HOME).toBe("/home/miner/.local/share");
    expect(env.XDG_STATE_HOME).toBe("/home/miner/.local/state");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("forwards only the selected provider's own credential", async () => {
    // The least-privilege half of the fix: an operator with both keys exported who runs claude-cli must not
    // hand the unrelated OpenAI key to a prompt-injectable child.
    const claude = await spawnedEnv("claude-cli", {
      ANTHROPIC_API_KEY: "anthropic-key-6875",
      OPENAI_API_KEY: "openai-key-6875",
    });
    expect(claude.ANTHROPIC_API_KEY).toBe("anthropic-key-6875");
    expect(claude.OPENAI_API_KEY).toBeUndefined();

    const codex = await spawnedEnv("codex-cli", {
      ANTHROPIC_API_KEY: "anthropic-key-6875",
      OPENAI_API_KEY: "openai-key-6875",
    });
    expect(codex.OPENAI_API_KEY).toBe("openai-key-6875");
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("prefers the first configured key of a provider's list", async () => {
    const both = await spawnedEnv("claude-cli", {
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok-6875",
      ANTHROPIC_API_KEY: "anthropic-key-6875",
    });
    expect(both.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-tok-6875");
    expect(both.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("treats a blank credential as unconfigured and falls through to the next key", async () => {
    // firstConfiguredEnvValue's own semantics: an empty/whitespace value is not a token, so forwarding it as if
    // it were real would authenticate as nobody while masking the key that actually works.
    const blank = await spawnedEnv("claude-cli", {
      CLAUDE_CODE_OAUTH_TOKEN: "   ",
      ANTHROPIC_API_KEY: "anthropic-key-6875",
    });
    expect(blank.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(blank.ANTHROPIC_API_KEY).toBe("anthropic-key-6875");
  });

  it("still spawns when no credential env is set (locally-authenticated)", async () => {
    // isConfiguredCodingAgentDriver treats CLI providers as always-configured because a credential persisted
    // under HOME is equally valid -- resolving no key must not throw or fabricate an empty one.
    const env = await spawnedEnv("claude-cli", { HOME: "/home/miner" });
    expect(env.HOME).toBe("/home/miner");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("never forwards an arbitrary runtime var from the parent env", async () => {
    // The invariant the widened allowlist must not cost us: the child gets the allowlist, never the full env.
    const env = await spawnedEnv("claude-cli", {
      HOME: "/home/miner",
      RUNTIME_ONLY_FLAG: "leak-me",
      DATABASE_URL: "postgres://leak",
    });
    expect(env.RUNTIME_ONLY_FLAG).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("redacts a forwarded credential out of the transcript", async () => {
    // Anything deliberately handed to a prompt-injectable child must be redactable out of what it says back.
    // The token is >=8 chars (redactSecrets' length guard) and deliberately matches NO SECRET_PATTERNS shape,
    // so passing this proves the knownSecrets wiring rather than the pattern fallback.
    const token = "oauth-tok-6875-not-a-known-shape";
    const driver = createCodingAgentDriver({
      providerName: "claude-cli",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      spawn: async () => ({ stdout: `authenticated with ${token}`, code: 0 }),
    });
    const result = await driver.run(TASK);
    expect(result.ok).toBe(true);
    expect(result.transcript).not.toContain(token);
    expect(result.transcript).toContain("[redacted]");
  });

  it("keeps a caller's own knownSecrets alongside the forwarded credential", async () => {
    const token = "oauth-tok-6875-not-a-known-shape";
    const callerSecret = "caller-secret-6875";
    const driver = createCodingAgentDriver({
      providerName: "claude-cli",
      env: { CLAUDE_CODE_OAUTH_TOKEN: token },
      knownSecrets: [callerSecret],
      spawn: async () => ({ stdout: `saw ${token} and ${callerSecret}`, code: 0 }),
    });
    const result = await driver.run(TASK);
    expect(result.transcript).not.toContain(token);
    expect(result.transcript).not.toContain(callerSecret);
  });

  it("leaves a codex subprocess without a credential when none is configured", async () => {
    const env = await spawnedEnv("codex-cli", { HOME: "/home/miner" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(env.HOME).toBe("/home/miner");
  });

  it("declares the credential keys as config-as-code, in preference order", () => {
    expect(CODING_AGENT_CLI_CREDENTIAL_ENV.claude).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ]);
    expect(CODING_AGENT_CLI_CREDENTIAL_ENV.codex).toEqual(["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]);
    expect(Object.isFrozen(CODING_AGENT_CLI_CREDENTIAL_ENV)).toBe(true);
  });

  it("keeps the credential keys OUT of the companion-var registry", () => {
    // CODING_AGENT_DRIVER_CONFIG_ENV's contract is one `kind -> single env var NAME`, and generic consumers
    // depend on it: init-wizard.js's promptCompanionVars iterates its entries and prompts once per value, so a
    // list-valued entry renders as `Optional undefined for claude-cli (env A,B)` and writes a junk .env line if
    // answered. This pins that contract -- every value stays a plain string.
    for (const config of Object.values(CODING_AGENT_DRIVER_CONFIG_ENV)) {
      for (const value of Object.values(config)) {
        expect(typeof value).toBe("string");
      }
    }
  });
});
