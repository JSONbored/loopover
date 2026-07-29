import { describe, expect, it } from "vitest";
import {
  CLIENT_HOSTS,
  CLIENT_HOST_SPEC,
  CONNECTION_MODES,
  CONNECTION_MODE_SPEC,
  REMOTE_MCP_URL,
  REMOTE_TOKEN_ENV_VAR,
  clientConfigFile,
  clientConfigMatrix,
  clientConfigSnippet,
  compactStringArrays,
  supportsConnectionMode,
} from "@loopover/contract/client-config";

// #9526: the client-config grid. Its whole job is that a snippet WORKS when pasted, so these assertions are
// about the shapes real clients read -- not about the strings matching some other copy of themselves.

describe("the grid covers three connection modes across every host (#9526)", () => {
  it("names exactly the three modes the issue records, stdio first", () => {
    expect(CONNECTION_MODES).toEqual(["stdio", "remote", "miner"]);
  });

  it("every (host, mode) pair either has a snippet or is refused — never a plausible-looking wrong one", () => {
    for (const host of CLIENT_HOSTS) {
      for (const mode of CONNECTION_MODES) {
        if (supportsConnectionMode(host, mode)) expect(clientConfigSnippet(host, mode)).toBeTruthy();
        else expect(() => clientConfigSnippet(host, mode)).toThrow(/cannot connect/i);
      }
    }
  });

  it("the matrix is every supported pair, and only those", () => {
    const matrix = clientConfigMatrix();
    expect(matrix.every((pair) => supportsConnectionMode(pair.host, pair.mode))).toBe(true);
    // Every stdio pair, plus remote for the hosts whose remote dialect this repo can actually vouch for.
    const remoteHosts = CLIENT_HOSTS.filter((host) => CLIENT_HOST_SPEC[host].supportsRemote);
    expect(matrix).toHaveLength(CLIENT_HOSTS.length * 2 + remoteHosts.length);
    expect(remoteHosts.length).toBeLessThan(CLIENT_HOSTS.length);
  });

  it("REFUSES a pair it cannot vouch for rather than printing a snippet that fails on paste", () => {
    // The generic `mcpServers` bucket is an unnamed host; its remote dialect is a guess, and the stdio
    // gateway already serves it the remote tools.
    expect(supportsConnectionMode("mcp", "remote")).toBe(false);
    expect(() => clientConfigSnippet("mcp", "remote")).toThrow(/cannot connect over/);
  });
});

describe("each host gets the shape it actually reads (#9526)", () => {
  it("Codex gets a TOML table, not JSON", () => {
    const snippet = clientConfigSnippet("codex", "stdio");
    expect(snippet).toContain("[mcp_servers.loopover]");
    expect(snippet).toContain('args = ["--stdio"]');
    expect(snippet).not.toContain("{");
  });

  it.each(["claude", "cursor", "mcp"] as const)("%s gets the mcpServers shape with no transport type", (host) => {
    const config = JSON.parse(clientConfigSnippet(host, "stdio")) as { mcpServers: Record<string, { command: string; args: string[]; type?: string }> };
    expect(config.mcpServers.loopover).toEqual({ command: "loopover-mcp", args: ["--stdio"] });
    // `mcpServers` hosts infer stdio from `command`; spelling it out would be noise in a file people read.
    expect(config.mcpServers.loopover!.type).toBeUndefined();
  });

  it("VS Code gets a `servers` map WITH the explicit transport type it requires", () => {
    const config = JSON.parse(clientConfigSnippet("vscode", "stdio")) as { servers: Record<string, { type: string }>; mcpServers?: unknown };
    expect(config.servers.loopover!.type).toBe("stdio");
    expect(config.mcpServers).toBeUndefined();
  });

  it("an overridden command lands in the snippet, for a client that does not inherit PATH", () => {
    expect(clientConfigSnippet("claude", "stdio", { command: "/opt/bin/loopover-mcp" })).toContain("/opt/bin/loopover-mcp");
  });
});

describe("the remote mode never puts a secret in a config file (#9526)", () => {
  it.each(CLIENT_HOSTS.filter((host) => CLIENT_HOST_SPEC[host].supportsRemote))("%s references the env var rather than a token value", (host) => {
    const snippet = clientConfigSnippet(host, "remote");
    expect(snippet).toContain(REMOTE_TOKEN_ENV_VAR);
    expect(snippet).toContain(REMOTE_MCP_URL);
    // A literal token would be in shell history, backups, and eventually a screenshot.
    expect(snippet).not.toMatch(/github_pat_|gh[pousr]_|Bearer [A-Za-z0-9]{8}/);
  });

  it("Codex names the variable in its own key; the JSON hosts spell out the header", () => {
    expect(clientConfigSnippet("codex", "remote")).toContain(`bearer_token_env_var = "${REMOTE_TOKEN_ENV_VAR}"`);
    const config = JSON.parse(clientConfigSnippet("vscode", "remote")) as { servers: Record<string, { type: string; url: string; headers: Record<string, string> }> };
    expect(config.servers.loopover).toEqual({ type: "http", url: REMOTE_MCP_URL, headers: { Authorization: `Bearer \${${REMOTE_TOKEN_ENV_VAR}}` } });
  });

  it("points a remote Claude entry at .mcp.json — Claude Desktop has no config file for this", () => {
    expect(clientConfigFile("claude", "remote")).toBe(".mcp.json");
    expect(clientConfigFile("claude", "stdio")).toBe("claude_desktop_config.json");
  });

  it("falls back to the host's one file when it has no separate remote location", () => {
    expect(clientConfigFile("cursor", "remote")).toBe(CLIENT_HOST_SPEC.cursor.file);
  });
});

describe("the miner mode stays its own server (#9526)", () => {
  it("registers under a different key, with no flags and no login", () => {
    const config = JSON.parse(clientConfigSnippet("claude", "miner")) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers["loopover-miner"]).toEqual({ command: "loopover-miner-mcp", args: [] });
    expect(config.mcpServers.loopover).toBeUndefined();
  });

  it("its keys never collide with the gateway's, so both fit in one client config", () => {
    expect(CONNECTION_MODE_SPEC.miner.serverKey).not.toBe(CONNECTION_MODE_SPEC.stdio.serverKey);
  });
});

describe("every mode explains itself (#9526)", () => {
  it.each(CONNECTION_MODES)("%s carries a summary and at least one actionable note", (mode) => {
    const spec = CONNECTION_MODE_SPEC[mode];
    expect(spec.summary.length).toBeGreaterThan(40);
    expect(spec.notes.length).toBeGreaterThan(0);
  });

  it("the stdio mode tells a reader how to log in AND how to opt out of the remote mount", () => {
    const notes = CONNECTION_MODE_SPEC.stdio.notes.join("\n");
    expect(notes).toContain("loopover-mcp login");
    expect(notes).toContain("--no-remote");
  });
});

describe("snippet formatting (#9526)", () => {
  it("keeps a short string array on one line so the block reads as config, not as a list", () => {
    expect(compactStringArrays('{\n  "args": [\n    "--stdio"\n  ]\n}')).toBe('{\n  "args": ["--stdio"]\n}');
  });

  it("leaves a long array expanded rather than producing an unreadable line", () => {
    const long = JSON.stringify({ args: Array.from({ length: 12 }, (_, index) => `--flag-number-${index}`) }, null, 2);
    expect(compactStringArrays(long)).toBe(long);
  });

  it("leaves a non-string array alone", () => {
    const numeric = JSON.stringify({ ports: [1, 2, 3] }, null, 2);
    expect(compactStringArrays(numeric)).toBe(numeric);
  });
});
