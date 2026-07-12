import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMinerMcpServer } from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";
import { initLaptopState } from "../../packages/gittensory-miner/lib/laptop-init.js";
import { collectMinerDiagnostics } from "../../packages/gittensory-miner/lib/status.js";
import { containsSecretLikeText } from "../../src/review/content-lane/registry-logic";

type Content = { content: Array<{ type: string; text?: string }> };

const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-mcp-status-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connectedClient(options: Parameters<typeof createMinerMcpServer>[0] = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-status-test", version: "0.0.0" });
  await Promise.all([createMinerMcpServer(options).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

describe("gittensory_miner_status (#5154)", () => {
  it("is registered on the miner MCP server", async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_miner_status");
  });

  it("returns state-dir, engine skew, CLI presence booleans, config validity, and doctor checks", async () => {
    const root = tempRoot();
    writeFileSync(join(root, ".gittensory-miner.yml"), "minerEnabled: true\n");
    const env = {
      GITTENSORY_MINER_CONFIG_DIR: join(root, "state"),
      PATH: "",
    };
    initLaptopState(env);
    const client = await connectedClient({ diagnosticsEnv: env, diagnosticsCwd: root });
    const result = (await client.callTool({ name: "gittensory_miner_status", arguments: {} })) as Content;
    const payload = JSON.parse(toolText(result));
    expect(payload.stateDir).toBe(join(root, "state"));
    expect(payload.configFile).toBe(join(root, ".gittensory-miner.yml"));
    expect(payload.configValid).toBe(true);
    expect(payload.engineVersionSkew).toEqual(expect.objectContaining({ ok: expect.any(Boolean), detail: expect.any(String) }));
    expect(payload.presence).toEqual({
      docker: false,
      claudeCli: false,
      codexCli: false,
    });
    expect(payload.doctor.checks.map((check: { name: string }) => check.name)).toEqual([
      "node-version",
      "engine-resolves",
      "engine-version-skew",
      "state-dir-writable",
      "laptop-state-sqlite",
      "docker-present",
      "claude-cli-present",
      "codex-cli-present",
    ]);
  });

  it("is structurally identical to collectMinerDiagnostics() — the wrapper adds no drift (invariant)", async () => {
    const root = tempRoot();
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state"), PATH: "" };
    initLaptopState(env);
    const client = await connectedClient({ diagnosticsEnv: env, diagnosticsCwd: root });
    const result = (await client.callTool({ name: "gittensory_miner_status", arguments: {} })) as Content;
    expect(JSON.parse(toolText(result))).toEqual(collectMinerDiagnostics(env, root));
  });

  it("never returns secret-shaped values or configured env-var contents (invariant)", async () => {
    const root = tempRoot();
    const secretToken = `ghp_${"a".repeat(36)}`;
    const env = {
      GITTENSORY_MINER_CONFIG_DIR: join(root, "state"),
      GITHUB_TOKEN: secretToken,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret-value",
      PATH: "",
    };
    initLaptopState(env);
    const client = await connectedClient({ diagnosticsEnv: env, diagnosticsCwd: root });
    const result = (await client.callTool({ name: "gittensory_miner_status", arguments: {} })) as Content;
    const serialized = toolText(result);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("oauth-secret-value");
    expect(containsSecretLikeText(serialized)).toBe(false);
  });

  it("reports configValid false when the discovered config file is unreadable", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".gittensory-miner.yml"));
    const env = { GITTENSORY_MINER_CONFIG_DIR: join(root, "state"), PATH: "" };
    initLaptopState(env);
    const client = await connectedClient({ diagnosticsEnv: env, diagnosticsCwd: root });
    const result = (await client.callTool({ name: "gittensory_miner_status", arguments: {} })) as Content;
    expect(JSON.parse(toolText(result)).configValid).toBe(false);
  });

  it("supports a collectMinerDiagnostics injection seam for failure-path tests", async () => {
    const client = await connectedClient({
      collectMinerDiagnostics: () => ({
        package: { name: "@jsonbored/gittensory-miner", version: "0.0.0-test" },
        engine: { name: "@jsonbored/gittensory-engine", version: "0.0.0" },
        node: "v22.0.0",
        stateDir: "/tmp/missing-state",
        configFile: null,
        driver: { provider: null, modelEnvVar: null, cliPresent: null },
        configValid: true,
        engineVersionSkew: { ok: false, detail: "installed 0.1.0 is behind expected 0.2.0" },
        presence: { docker: false, claudeCli: false, codexCli: false },
        doctor: {
          ok: false,
          checks: [{ name: "state-dir-writable", ok: false, detail: "/tmp/missing-state: not writable" }],
        },
      }),
    });
    const result = (await client.callTool({ name: "gittensory_miner_status", arguments: {} })) as Content;
    const payload = JSON.parse(toolText(result));
    expect(payload.doctor.ok).toBe(false);
    expect(payload.engineVersionSkew.ok).toBe(false);
  });
});
