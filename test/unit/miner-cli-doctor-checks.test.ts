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
});
