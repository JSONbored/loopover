import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, createPacketRepo, run, runAsync, startFixtureServer } from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — basics", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("prints MCP client snippets without mutating client config", () => {
    const codex = run(["init-client", "--print", "codex"]);
    expect(codex).toContain("[mcp_servers.gittensory]");
    expect(codex).toContain('args = ["--stdio"]');

    const claude = JSON.parse(run(["init-client", "--print", "claude", "--json"])) as { snippet: string };
    expect(claude.snippet).toContain('"mcpServers"');
    expect(claude.snippet).toContain('"gittensory"');

    const cursor = JSON.parse(run(["init-client", "--print", "cursor", "--json"])) as { snippet: string };
    expect(cursor.snippet).toBe(claude.snippet);

    const generic = JSON.parse(run(["init-client", "--print", "mcp", "--json"])) as { snippet: string };
    expect(generic.snippet).toBe(claude.snippet);

    const vscode = JSON.parse(run(["init-client", "--print", "vscode", "--json"])) as { snippet: string };
    // VS Code uses a `servers` map with an explicit transport type, not the `mcpServers` shape.
    expect(vscode.snippet).toContain('"servers"');
    expect(vscode.snippet).toContain('"type": "stdio"');
    expect(vscode.snippet).toContain('"gittensory"');
    expect(vscode.snippet).not.toContain('"mcpServers"');
  });

  it("prints human-approved agent profile instructions for supported MCP clients", () => {
    const payload = JSON.parse(run(["init-client", "--print", "codex", "--agent-profile", "miner-planner", "--json"])) as {
      agentProfile: {
        id: string;
        title: string;
        recommendedPrompts: string[];
        recommendedTools: string[];
        boundaries: string[];
        whenNotToUse: string;
      };
      notes: string[];
    };

    expect(payload.agentProfile).toMatchObject({
      id: "miner-planner",
      title: "Miner planner",
      recommendedPrompts: expect.arrayContaining(["gittensory_miner_select_issue", "gittensory_miner_branch_preflight", "gittensory_miner_draft_pr_packet"]),
      recommendedTools: expect.arrayContaining(["gittensory_agent_plan_next_work", "gittensory_agent_prepare_pr_packet"]),
    });
    expect(payload.agentProfile.boundaries.join("\n")).toMatch(/do not open PRs|do not.*post comments|do not.*tokens|local source contents/i);
    expect(payload.notes.join("\n")).toMatch(/human-approved/i);
    expect(JSON.stringify(payload)).not.toMatch(/github_pat_|gh[pousr]_|[A-Z0-9_]*TOKEN=|PRIVATE_KEY=/);

    const plain = run(["init-client", "--print", "claude", "--agent-profile", "repo-owner-intake"]);
    expect(plain).toContain('"mcpServers"');
    expect(plain).toContain("Gittensory agent profile: Repo-owner intake");
    expect(plain).toContain("gittensory_repo_owner_intake_readiness");
    expect(plain).toMatch(/do not.*publish public output/i);
  });

  it("supports all documented agent profiles without changing MCP server config", () => {
    for (const profile of ["miner-planner", "maintainer-triage", "repo-owner-intake"]) {
      const payload = JSON.parse(run(["init-client", "--print", "mcp", "--agent-profile", profile, "--json"])) as {
        args: string[];
        snippet: string;
        agentProfile: { id: string; boundaries: string[]; whenNotToUse: string };
      };

      expect(payload.args).toEqual(["--stdio"]);
      expect(payload.snippet).toContain('"args": [');
      expect(payload.agentProfile.id).toBe(profile);
      expect(payload.agentProfile.boundaries.join("\n")).toMatch(/Human-approved only/i);
      expect(payload.agentProfile.whenNotToUse).not.toMatch(/wallet|hotkey|coldkey|token/i);
    }
  });

  it("prints the gate-throttled miner-auto-dev profile with a plan→implement→push driving loop (#781)", () => {
    const payload = JSON.parse(run(["init-client", "--print", "codex", "--agent-profile", "miner-auto-dev", "--json"])) as {
      agentProfile: { id: string; title: string; recommendedTools: string[]; drivingLoop: string[]; boundaries: string[]; whenNotToUse: string };
      notes: string[];
    };
    expect(payload.agentProfile.id).toBe("miner-auto-dev");
    // the new Phase-2 tools are wired in
    expect(payload.agentProfile.recommendedTools).toEqual(
      expect.arrayContaining(["gittensory_run_local_scorer", "gittensory_build_plan", "gittensory_record_step_result", "gittensory_open_pr", "gittensory_check_slop_risk"]),
    );
    // the driving loop is present and gate-throttled, with a local-execution push step
    expect(payload.agentProfile.drivingLoop.length).toBeGreaterThanOrEqual(4);
    expect(payload.agentProfile.drivingLoop.join("\n")).toMatch(/anti-slop|gate-ready|preflight/i);
    expect(payload.agentProfile.boundaries.join("\n")).toMatch(/run by YOUR harness with YOUR credentials|never performs the write/i);
    // the note reflects local execution after the gate (NOT the human-approved framing of the other profiles)
    expect(payload.notes.join("\n")).toMatch(/runs LOCALLY|after the Gittensory gate/i);
    expect(payload.notes.join("\n")).not.toMatch(/keep all GitHub writes human-approved/i);
    // the rendered markdown carries the driving loop too
    const plain = run(["init-client", "--print", "claude", "--agent-profile", "miner-auto-dev"]);
    expect(plain).toContain("Gittensory agent profile: Miner auto-dev");
    expect(plain).toMatch(/Driving loop/);
    expect(JSON.stringify(payload)).not.toMatch(/github_pat_|gh[pousr]_|PRIVATE_KEY=/);
  });

  it("rejects unsupported client snippets", () => {
    expect(() => run(["init-client", "--print", "other"])).toThrow(/Unsupported client/);
  });

  it("rejects unsupported agent profiles", () => {
    for (const profile of ["autopilot", "__proto__", "constructor"]) {
      expect(() => run(["init-client", "--print", "codex", "--agent-profile", profile])).toThrow(/Unsupported agent profile/);
      expect(() => run(["init-client", "--print", "codex", "--agent-profile", profile, "--json"])).toThrow(/Unsupported agent profile/);
    }
  });

  it("reports the package version via version, --version, and -v", () => {
    const expected = "@jsonbored/gittensory-mcp/0.7.0";
    for (const flag of ["version", "--version", "-v"]) {
      const plain = run([flag]).trim();
      expect(plain).toContain(expected);
      // The plain form reports all three values the README documents.
      expect(plain).toContain("api 0.1.0");
      expect(plain).toContain(`node ${process.version}`);
    }
  });

  it("emits machine-readable version output with --json", () => {
    const payload = JSON.parse(run(["version", "--json"])) as { name: string; version: string; apiVersion: string; node: string };
    expect(payload.name).toBe("@jsonbored/gittensory-mcp");
    expect(payload.version).toBe("0.7.0");
    expect(payload.apiVersion).toBe("0.1.0");
    expect(payload.node).toBe(process.version);
  });

  it("redacts private account-state workspace intelligence from preflight output", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer();

    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };
    const jsonOutput = await runAsync(["preflight", "--login", "JSONbored", "--cwd", tempDir, "--repo", "JSONbored/gittensory", "--json"], env);
    const payload = JSON.parse(jsonOutput) as { workspaceIntelligence: { blockers: { accountState: string[] }; rerunWhen: string } };
    expect(payload.workspaceIntelligence.blockers.accountState).toEqual([]);
    expect(payload.workspaceIntelligence.rerunWhen).toBe("Rerun after any branch, base, or PR state changes before opening/submitting.");
    expect(jsonOutput).not.toMatch(/Open PR count|Credibility|account\/queue maturity|projected score/i);

    const humanOutput = await runAsync(["preflight", "--login", "JSONbored", "--cwd", tempDir, "--repo", "JSONbored/gittensory"], env);
    expect(humanOutput).not.toContain("Account/queue blockers:");
    expect(humanOutput).not.toMatch(/Open PR count|Credibility|account\/queue maturity|projected score/i);
  });

  it("guides unknown commands to --help", () => {
    expect(() => run(["bogus-command"])).toThrow(/Unknown command: bogus-command/);
    expect(() => run(["bogus-command"])).toThrow(/gittensory-mcp --help/);
  });

  it("suggests the closest command for a near-miss typo", () => {
    // The suggestion is interpolated into the message, so matching `status` (not the literal
    // template token) confirms it ran rather than just matching the throw's printed source line.
    expect(() => run(["staus"])).toThrow(/Unknown command: staus\. Did you mean `status`\?/);
    expect(() => run(["verison"])).toThrow(/Did you mean `version`\?/);
    expect(() => run(["confi"])).toThrow(/Did you mean `config`\?/);
    expect(() => run(["doctr"])).toThrow(/Did you mean `doctor`\?/);
  });

  it("prints shell completion scripts for bash, zsh, and fish", () => {
    const bash = run(["completion", "bash"]);
    expect(bash).toContain("_gittensory_mcp()");
    expect(bash).toContain("complete -F _gittensory_mcp gittensory-mcp");
    expect(bash).toContain("analyze-branch");
    expect(bash).toContain("local commands=\"login logout whoami config status changelog completion version doctor");
    expect(bash).toContain("version");
    expect(bash).toContain("plan status explain packet");

    const zsh = run(["completion", "zsh"]);
    expect(zsh).toContain("#compdef gittensory-mcp");
    expect(zsh).toContain("_describe 'command' commands");
    expect(zsh).toContain("commands=(login logout whoami config status changelog completion version doctor");
    expect(zsh).toContain("list create switch remove");

    const fish = run(["completion", "fish"]);
    expect(fish).toContain("complete -c gittensory-mcp");
    expect(fish).toContain("complete -c gittensory-mcp -n __fish_use_subcommand -a config");
    expect(fish).toContain("complete -c gittensory-mcp -n __fish_use_subcommand -a completion");
    expect(fish).toContain("__fish_seen_subcommand_from agent");
  });

  it("prints a PowerShell argument-completer script", () => {
    const ps = run(["completion", "powershell"]);
    expect(ps).toContain("Register-ArgumentCompleter -Native -CommandName gittensory-mcp");
    expect(ps).toContain("[System.Management.Automation.CompletionResult]::new");
    expect(ps).toContain("$commands = @('login', 'logout'");
    expect(ps).toContain("'maintain' = @('status', 'approve', 'reject', 'pause', 'resume', 'set-level')");
  });

  it("emits completion as machine-readable json", () => {
    const payload = JSON.parse(run(["completion", "zsh", "--json"])) as { shell: string; script: string };
    expect(payload.shell).toBe("zsh");
    expect(payload.script).toContain("#compdef gittensory-mcp");
  });

  it("rejects missing or unsupported completion shells", () => {
    expect(() => run(["completion"])).toThrow(/Usage: gittensory-mcp completion <bash\|zsh\|fish\|powershell>/);
    expect(() => run(["completion", "tcsh"])).toThrow(/Unsupported shell: tcsh/);
  });

  it("reports resolved configuration provenance via config", () => {
    const payload = JSON.parse(run(["config", "--json"])) as {
      apiUrl: string;
      apiUrlSource: string;
      activeProfile: string;
      profileCount: number;
      configured: boolean;
      configPathSource: string;
      cacheDirSource: string;
      tokenConfigured: boolean;
      tokenSource: string;
      sourceUpload: { default: boolean; enabled: boolean; source: string; supported: boolean };
    };
    // The run() harness sets GITTENSORY_CONFIG_DIR but no API URL or token.
    expect(payload.apiUrl).toBe("https://gittensory-api.aethereal.dev");
    expect(payload.apiUrlSource).toBe("default");
    expect(payload.activeProfile).toBe("default");
    expect(payload.profileCount).toBeGreaterThanOrEqual(1);
    expect(payload.configured).toBe(false);
    expect(payload.configPathSource).toBe("GITTENSORY_CONFIG_DIR");
    expect(payload.cacheDirSource).toBe("default");
    expect(payload.tokenConfigured).toBe(false);
    expect(payload.tokenSource).toBe("none");
    expect(payload.sourceUpload).toEqual({ default: false, enabled: false, source: "default", supported: false });
  });

  it("attributes config values to environment overrides without leaking secrets", () => {
    const secretDir = mkdtempSync(join(tmpdir(), "gittensory-config-secret-"));
    try {
      const out = run(["config"], {
        GITTENSORY_API_URL: "https://example.test",
        GITTENSORY_TOKEN: "super-secret-token",
        GITTENSORY_CACHE_DIR: join(secretDir, "cache"),
        GITTENSORY_CONFIG_DIR: secretDir,
      });
      expect(out).toContain("API URL: https://example.test (environment)");
      expect(out).toContain("Token: configured (environment)");
      expect(out).toContain("Cache dir: GITTENSORY_CACHE_DIR");
      expect(out).toContain("Source upload: disabled (unsupported)");
      // No token value or local absolute path may appear in output.
      expect(out).not.toContain("super-secret-token");
      expect(out).not.toContain(secretDir);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it("reports enabled unsupported source upload environment settings via config", () => {
    const payload = JSON.parse(run(["config", "--json"], { GITTENSORY_UPLOAD_SOURCE: "true" })) as {
      sourceUpload: { default: boolean; enabled: boolean; source: string; supported: boolean };
    };
    expect(payload.sourceUpload).toEqual({ default: false, enabled: true, source: "GITTENSORY_UPLOAD_SOURCE", supported: false });

    const out = run(["config"], { GITTENSORY_UPLOAD_SOURCE: "true" });
    expect(out).toContain("Source upload: enabled via GITTENSORY_UPLOAD_SOURCE (unsupported; unset GITTENSORY_UPLOAD_SOURCE)");
  });

  it("attributes API URL and token to a named profile from the config file", () => {
    const configDir = mkdtempSync(join(tmpdir(), "gittensory-config-profile-"));
    try {
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({
          activeProfile: "work",
          profiles: { work: { apiUrl: "https://profile.example", session: { token: "tok", login: "octocat", expiresAt: "2099-01-01T00:00:00Z" } } },
        }),
        { mode: 0o600 },
      );
      const payload = JSON.parse(run(["config", "--json"], { GITTENSORY_CONFIG_DIR: configDir })) as {
        apiUrl: string;
        apiUrlSource: string;
        activeProfile: string;
        configured: boolean;
        tokenConfigured: boolean;
        tokenSource: string;
        profile: { login: string };
      };
      expect(payload.activeProfile).toBe("work");
      expect(payload.apiUrl).toBe("https://profile.example");
      expect(payload.apiUrlSource).toBe("profile");
      expect(payload.configured).toBe(true);
      expect(payload.tokenConfigured).toBe(true);
      expect(payload.tokenSource).toBe("profile");
      expect(payload.profile.login).toBe("octocat");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("attributes API URL to a global config file reached through a config-path override", () => {
    const dir = mkdtempSync(join(tmpdir(), "gittensory-config-global-"));
    const file = join(dir, "custom-config.json");
    try {
      writeFileSync(file, JSON.stringify({ apiUrl: "https://global.example" }), { mode: 0o600 });
      const payload = JSON.parse(run(["config", "--json"], { GITTENSORY_CONFIG_PATH: file, GITTENSORY_CONFIG_DIR: "" })) as {
        apiUrl: string;
        apiUrlSource: string;
        configPathSource: string;
        configured: boolean;
      };
      expect(payload.apiUrl).toBe("https://global.example");
      expect(payload.apiUrlSource).toBe("config");
      expect(payload.configPathSource).toBe("GITTENSORY_CONFIG_PATH");
      expect(payload.configured).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
