import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaudeCliPresent, checkCodexCliPresent } from "../../packages/gittensory-miner/lib/laptop-init.js";
import {
  checkCodingAgentCredential,
  checkGitHubTokenPresent,
  runDoctorChecks,
} from "../../packages/gittensory-miner/lib/status.js";

const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-clicheck-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner doctor — coding-agent CLI checks (#4304)", () => {
  it("claude: present + authenticated when the OAuth token is set", () => {
    const check = checkClaudeCliPresent({ env: { CLAUDE_CODE_OAUTH_TOKEN: "present" }, resolveClaudePath: () => "/usr/bin/claude" });
    expect(check).toMatchObject({ name: "claude-cli-present", ok: true });
    expect(check.detail).toBe("found at /usr/bin/claude (authenticated)");
  });

  it("claude: present but not authenticated when the OAuth token is absent (still advisory)", () => {
    const check = checkClaudeCliPresent({ env: {}, resolveClaudePath: () => "/usr/bin/claude" });
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/found at \/usr\/bin\/claude \(not authenticated: set CLAUDE_CODE_OAUTH_TOKEN\)/);
  });

  it("claude: absent → advisory (ok true, optional)", () => {
    const check = checkClaudeCliPresent({ env: {}, resolveClaudePath: () => null });
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/^not installed \(optional/);
  });

  it("codex: present + authenticated when auth.json is readable", () => {
    const authFile = join(tempRoot(), "auth.json");
    writeFileSync(authFile, "{}");
    const check = checkCodexCliPresent({ env: {}, resolveCodexPath: () => "/usr/bin/codex", resolveCodexAuthPath: () => authFile });
    expect(check.detail).toBe("found at /usr/bin/codex (authenticated)");
  });

  it("codex: present but not authenticated when auth.json is missing (still advisory)", () => {
    const check = checkCodexCliPresent({ env: {}, resolveCodexPath: () => "/usr/bin/codex", resolveCodexAuthPath: () => join(tempRoot(), "does-not-exist.json") });
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/found at \/usr\/bin\/codex \(not authenticated: run `codex auth`\)/);
  });

  it("codex: absent → advisory (ok true, optional)", () => {
    const check = checkCodexCliPresent({ env: {}, resolveCodexPath: () => null });
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/^not installed \(optional/);
  });

  it("runDoctorChecks includes both coding-agent CLI checks", () => {
    const names = runDoctorChecks({ GITTENSORY_MINER_CONFIG_DIR: tempRoot() }).map((check) => check.name);
    expect(names).toContain("claude-cli-present");
    expect(names).toContain("codex-cli-present");
  });

  describe("provider-gated CLI-presence failures (#5165)", () => {
    it("claude: regression -- CLI missing while unconfigured no longer breaks doctor (ok stays true)", () => {
      const check = checkClaudeCliPresent({ env: {}, resolveClaudePath: () => null });
      expect(check.ok).toBe(true);
    });

    it("claude: CLI missing + a DIFFERENT provider configured stays advisory (ok true)", () => {
      const check = checkClaudeCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        resolveClaudePath: () => null,
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/^not installed \(optional/);
    });

    it("claude: CLI missing + claude-cli configured fails doctor with an actionable message", () => {
      const check = checkClaudeCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
        resolveClaudePath: () => null,
      });
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(
        "not installed — MINER_CODING_AGENT_PROVIDER is set to claude-cli, every attempt will fail without it",
      );
    });

    it("claude: CLI present + claude-cli configured still reports the normal present/authenticated detail", () => {
      const check = checkClaudeCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli", CLAUDE_CODE_OAUTH_TOKEN: "present" },
        resolveClaudePath: () => "/usr/bin/claude",
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("found at /usr/bin/claude (authenticated)");
    });

    it("codex: regression -- CLI missing while unconfigured no longer breaks doctor (ok stays true)", () => {
      const check = checkCodexCliPresent({ env: {}, resolveCodexPath: () => null });
      expect(check.ok).toBe(true);
    });

    it("codex: CLI missing + a DIFFERENT provider configured stays advisory (ok true)", () => {
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
        resolveCodexPath: () => null,
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/^not installed \(optional/);
    });

    it("codex: CLI missing + codex-cli configured fails doctor with an actionable message", () => {
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        resolveCodexPath: () => null,
      });
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(
        "not installed — MINER_CODING_AGENT_PROVIDER is set to codex-cli, every attempt will fail without it",
      );
    });

    it("codex: CLI present + codex-cli configured still reports the normal present/authenticated detail", () => {
      const authFile = join(tempRoot(), "auth.json");
      writeFileSync(authFile, "{}");
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => authFile,
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("found at /usr/bin/codex (authenticated)");
    });

    it("codex: auth-freshness remediation -- names the exact remediation step when codex-cli is configured and auth.json is missing", () => {
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => join(tempRoot(), "does-not-exist.json"),
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe(
        "found at /usr/bin/codex but auth.json is missing or expired — run `codex auth` to authenticate before attempts run",
      );
    });

    it("codex: auth-freshness remediation -- no remediation message when codex-cli is configured and auth.json IS present", () => {
      const authFile = join(tempRoot(), "auth.json");
      writeFileSync(authFile, "{}");
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => authFile,
      });
      expect(check.detail).toBe("found at /usr/bin/codex (authenticated)");
      expect(check.detail).not.toContain("run `codex auth`");
    });

    it("codex: auth-freshness remediation -- a DIFFERENT provider configured keeps the generic advisory message unchanged", () => {
      const check = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => join(tempRoot(), "does-not-exist.json"),
      });
      expect(check.detail).toBe("found at /usr/bin/codex (not authenticated: run `codex auth`)");
    });

    it("invariant: the unconfigured-provider message shape never changes regardless of auth.json state", () => {
      const authMissing = checkCodexCliPresent({
        env: {},
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => join(tempRoot(), "does-not-exist.json"),
      });
      const authPresentFile = join(tempRoot(), "auth.json");
      writeFileSync(authPresentFile, "{}");
      const authPresent = checkCodexCliPresent({
        env: {},
        resolveCodexPath: () => "/usr/bin/codex",
        resolveCodexAuthPath: () => authPresentFile,
      });
      expect(authMissing.detail).toBe("found at /usr/bin/codex (not authenticated: run `codex auth`)");
      expect(authPresent.detail).toBe("found at /usr/bin/codex (authenticated)");
    });

    it("invariant: an unconfigured (or differently-configured) provider's CLI check is never reported as ok: false regardless of CLI presence", () => {
      const missingUnconfigured = checkClaudeCliPresent({ env: {}, resolveClaudePath: () => null });
      const presentUnconfigured = checkClaudeCliPresent({ env: {}, resolveClaudePath: () => "/usr/bin/claude" });
      const missingOtherProvider = checkCodexCliPresent({
        env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
        resolveCodexPath: () => null,
      });
      expect(missingUnconfigured.ok).toBe(true);
      expect(presentUnconfigured.ok).toBe(true);
      expect(missingOtherProvider.ok).toBe(true);
    });
  });

  describe("four-state coding-agent CLI matrix (#5195)", () => {
    const CLAUDE_PATH = "/usr/bin/claude";
    const CODEX_PATH = "/usr/bin/codex";
    const ADVISORY_MISSING = "not installed (optional until a coding-agent driver is configured)";
    const CLAUDE_CONFIGURED_MISSING =
      "not installed — MINER_CODING_AGENT_PROVIDER is set to claude-cli, every attempt will fail without it";
    const CODEX_CONFIGURED_MISSING =
      "not installed — MINER_CODING_AGENT_PROVIDER is set to codex-cli, every attempt will fail without it";
    const CLAUDE_UNAUTH_ADVISORY = `found at ${CLAUDE_PATH} (not authenticated: set CLAUDE_CODE_OAUTH_TOKEN)`;
    const CODEX_UNAUTH_ADVISORY = `found at ${CODEX_PATH} (not authenticated: run \`codex auth\`)`;
    const CODEX_CONFIGURED_UNAUTH =
      `found at ${CODEX_PATH} but auth.json is missing or expired — run \`codex auth\` to authenticate before attempts run`;

    type MatrixCase = {
      label: string;
      run: (authPath: string) => { ok: boolean; detail: string };
      expectedOk: boolean;
      expectedDetail: string;
    };

    const matrix: MatrixCase[] = [
      {
        label: "claude: no provider configured + CLI missing",
        run: () => checkClaudeCliPresent({ env: {}, resolveClaudePath: () => null }),
        expectedOk: true,
        expectedDetail: ADVISORY_MISSING,
      },
      {
        label: "claude: no provider configured + CLI present but unauthenticated",
        run: () => checkClaudeCliPresent({ env: {}, resolveClaudePath: () => CLAUDE_PATH }),
        expectedOk: true,
        expectedDetail: CLAUDE_UNAUTH_ADVISORY,
      },
      {
        label: "claude: claude-cli configured + CLI missing",
        run: () =>
          checkClaudeCliPresent({
            env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
            resolveClaudePath: () => null,
          }),
        expectedOk: false,
        expectedDetail: CLAUDE_CONFIGURED_MISSING,
      },
      {
        label: "claude: claude-cli configured + CLI present but unauthenticated",
        run: () =>
          checkClaudeCliPresent({
            env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
            resolveClaudePath: () => CLAUDE_PATH,
          }),
        // Auth probe stays advisory when the CLI binary is present (#5165) — only absence is a hard failure.
        expectedOk: true,
        expectedDetail: CLAUDE_UNAUTH_ADVISORY,
      },
      {
        label: "codex: no provider configured + CLI missing",
        run: () => checkCodexCliPresent({ env: {}, resolveCodexPath: () => null }),
        expectedOk: true,
        expectedDetail: ADVISORY_MISSING,
      },
      {
        label: "codex: no provider configured + CLI present but unauthenticated",
        run: (authPath) =>
          checkCodexCliPresent({
            env: {},
            resolveCodexPath: () => CODEX_PATH,
            resolveCodexAuthPath: () => authPath,
          }),
        expectedOk: true,
        expectedDetail: CODEX_UNAUTH_ADVISORY,
      },
      {
        label: "codex: codex-cli configured + CLI missing",
        run: () =>
          checkCodexCliPresent({
            env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
            resolveCodexPath: () => null,
          }),
        expectedOk: false,
        expectedDetail: CODEX_CONFIGURED_MISSING,
      },
      {
        label: "codex: codex-cli configured + CLI present but unauthenticated",
        run: (authPath) =>
          checkCodexCliPresent({
            env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
            resolveCodexPath: () => CODEX_PATH,
            resolveCodexAuthPath: () => authPath,
          }),
        // CLI present but auth.json missing: actionable remediation, still advisory ok (#5165/#5166).
        expectedOk: true,
        expectedDetail: CODEX_CONFIGURED_UNAUTH,
      },
    ];

    it.each(matrix)("$label => ok:$expectedOk with exact detail", ({ run, expectedOk, expectedDetail }) => {
      const authPath = join(tempRoot(), "missing-auth.json");
      const check = run(authPath);
      expect(check.ok).toBe(expectedOk);
      expect(check.detail).toBe(expectedDetail);
    });

    it("invariant: ok is false only when the configured provider's CLI binary is absent — never for an unconfigured or differently-configured provider, and never when the CLI is present but unauthenticated (#5195)", () => {
      const authPath = join(tempRoot(), "missing-auth.json");
      const hardFailures = [
        checkClaudeCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
          resolveClaudePath: () => null,
        }),
        checkCodexCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
          resolveCodexPath: () => null,
        }),
      ];
      const alwaysAdvisory = [
        checkClaudeCliPresent({ env: {}, resolveClaudePath: () => null }),
        checkClaudeCliPresent({ env: {}, resolveClaudePath: () => CLAUDE_PATH }),
        checkClaudeCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
          resolveClaudePath: () => CLAUDE_PATH,
        }),
        checkCodexCliPresent({ env: {}, resolveCodexPath: () => null }),
        checkCodexCliPresent({
          env: {},
          resolveCodexPath: () => CODEX_PATH,
          resolveCodexAuthPath: () => authPath,
        }),
        checkCodexCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
          resolveCodexPath: () => CODEX_PATH,
          resolveCodexAuthPath: () => authPath,
        }),
        checkClaudeCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "codex-cli" },
          resolveClaudePath: () => null,
        }),
        checkCodexCliPresent({
          env: { MINER_CODING_AGENT_PROVIDER: "claude-cli" },
          resolveCodexPath: () => null,
        }),
      ];

      for (const check of hardFailures) expect(check.ok).toBe(false);
      for (const check of alwaysAdvisory) expect(check.ok).toBe(true);
    });
  });
});

describe("gittensory-miner doctor — credential presence checks (#5170)", () => {
  describe("checkGitHubTokenPresent", () => {
    it("passes when GITHUB_TOKEN is set and non-empty", () => {
      const check = checkGitHubTokenPresent({ GITHUB_TOKEN: "ghp_present" });
      expect(check).toMatchObject({ name: "github-token", ok: true, detail: "GITHUB_TOKEN is set" });
    });

    it("fails with an actionable message when GITHUB_TOKEN is unset", () => {
      const check = checkGitHubTokenPresent({});
      expect(check.ok).toBe(false);
      expect(check.detail).toBe("GITHUB_TOKEN is not set — attempts that push a branch or open a PR will fail");
    });

    it("fails when GITHUB_TOKEN is present but empty (the length>0 branch)", () => {
      expect(checkGitHubTokenPresent({ GITHUB_TOKEN: "" }).ok).toBe(false);
    });
  });

  describe("checkCodingAgentCredential", () => {
    const readableAuth = () => {
      const authFile = join(tempRoot(), "auth.json");
      writeFileSync(authFile, "{}");
      return authFile;
    };
    const missingAuth = () => join(tempRoot(), "does-not-exist.json");

    it("skips (ok) when no provider is configured", () => {
      const check = checkCodingAgentCredential({});
      expect(check).toMatchObject({ name: "coding-agent-credential", ok: true });
      expect(check.detail).toBe("no coding-agent provider configured (skipped)");
    });

    it("skips (ok) for the noop driver", () => {
      const check = checkCodingAgentCredential({ MINER_CODING_AGENT_PROVIDER: "noop" });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("noop driver needs no credential");
    });

    it("claude-cli: passes when CLAUDE_CODE_OAUTH_TOKEN is set", () => {
      const check = checkCodingAgentCredential({
        MINER_CODING_AGENT_PROVIDER: "claude-cli",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("claude-cli: Claude credential is set");
    });

    it("claude-cli: fails with a specific remediation when no Claude credential is set", () => {
      const check = checkCodingAgentCredential({ MINER_CODING_AGENT_PROVIDER: "claude-cli" });
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(
        "claude-cli: no Claude credential — set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)",
      );
    });

    it("agent-sdk: accepts a raw ANTHROPIC_API_KEY as the credential (the API-key branch)", () => {
      const check = checkCodingAgentCredential({
        MINER_CODING_AGENT_PROVIDER: "agent-sdk",
        ANTHROPIC_API_KEY: "sk-ant-xyz",
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("agent-sdk: Claude credential is set");
    });

    it("agent-sdk: fails when neither Claude credential is present", () => {
      expect(checkCodingAgentCredential({ MINER_CODING_AGENT_PROVIDER: "agent-sdk" }).ok).toBe(false);
    });

    it("codex-cli: passes when auth.json is readable", () => {
      const authPath = readableAuth();
      const check = checkCodingAgentCredential({ MINER_CODING_AGENT_PROVIDER: "codex-cli" }, () => authPath);
      expect(check.ok).toBe(true);
      expect(check.detail).toBe(`codex-cli: auth.json is readable at ${authPath}`);
    });

    it("codex-cli: fails with the `codex auth` remediation when auth.json is missing", () => {
      const authPath = missingAuth();
      const check = checkCodingAgentCredential({ MINER_CODING_AGENT_PROVIDER: "codex-cli" }, () => authPath);
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(
        `codex-cli: auth.json missing or unreadable at ${authPath} — run \`codex auth\``,
      );
    });

    it("resolves the credential for the FIRST configured provider in a fallback chain", () => {
      // "agent-sdk,codex-cli" resolves to agent-sdk first, so its Claude credential is what's checked.
      const check = checkCodingAgentCredential({
        MINER_CODING_AGENT_PROVIDER: "agent-sdk,codex-cli",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
      });
      expect(check.ok).toBe(true);
      expect(check.detail).toBe("agent-sdk: Claude credential is set");
    });
  });

  it("runDoctorChecks now includes the github-token and coding-agent-credential checks", () => {
    const names = runDoctorChecks({ GITTENSORY_MINER_CONFIG_DIR: tempRoot() }).map((check) => check.name);
    expect(names).toContain("github-token");
    expect(names).toContain("coding-agent-credential");
  });

  it("REGRESSION (#5170): claude-cli configured + CLI present but no token now FAILS doctor (the gap the CLI-present advisory left open)", () => {
    // Before this check, checkClaudeCliPresent stayed ok:true when only the credential was missing (#5165), so
    // doctor passed cleanly and the operator only learned of the missing token when a live attempt failed.
    const checks = runDoctorChecks({
      MINER_CODING_AGENT_PROVIDER: "claude-cli",
      GITHUB_TOKEN: "ghp_present",
      GITTENSORY_MINER_CONFIG_DIR: tempRoot(),
    });
    const credential = checks.find((check) => check.name === "coding-agent-credential");
    expect(credential?.ok).toBe(false);
  });

  it("invariant: doctor never prints a credential VALUE, only presence + env-var/file names", () => {
    const SECRET_GH = "ghp_super_secret_token_value";
    const SECRET_CLAUDE = "oauth_super_secret_value";
    const SECRET_ANTHROPIC = "sk-ant-super-secret-value";
    const checks = runDoctorChecks({
      MINER_CODING_AGENT_PROVIDER: "agent-sdk",
      GITHUB_TOKEN: SECRET_GH,
      CLAUDE_CODE_OAUTH_TOKEN: SECRET_CLAUDE,
      ANTHROPIC_API_KEY: SECRET_ANTHROPIC,
      GITTENSORY_MINER_CONFIG_DIR: tempRoot(),
    });
    for (const check of checks) {
      expect(check.detail).not.toContain(SECRET_GH);
      expect(check.detail).not.toContain(SECRET_CLAUDE);
      expect(check.detail).not.toContain(SECRET_ANTHROPIC);
    }
  });
});
