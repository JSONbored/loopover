import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaudeCliPresent, checkCodexCliPresent } from "../../packages/gittensory-miner/lib/laptop-init.js";
import { runDoctorChecks } from "../../packages/gittensory-miner/lib/status.js";

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
});
