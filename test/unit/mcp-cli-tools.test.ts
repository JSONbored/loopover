import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/loopover-mcp.js");

describe("loopover-mcp CLI — tools", () => {
  let configDir: string | null = null;
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    transport = null;
    await closeFixtureServer();
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    configDir = null;
  });

  it("lists every registered stdio tool with a non-empty description", async () => {
    configDir = mkdtempSync(join(tmpdir(), "gittensory-cli-tools-"));
    const apiUrl = await startFixtureServer();
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: {
        ...process.env,
        GITTENSORY_CONFIG_DIR: configDir,
        GITTENSORY_API_URL: apiUrl,
        GITTENSORY_TOKEN: "session-token",
        GITTENSORY_API_TIMEOUT_MS: "5000",
      },
    });
    client = new Client({ name: "tools-cli-test", version: "0.0.1" });
    await client.connect(transport);
    const { tools: registered } = await client.listTools();

    const payload = JSON.parse(run(["tools", "--json"])) as {
      count: number;
      tools: Array<{ name: string; description: string }>;
    };
    expect(payload.count).toBe(registered.length);
    expect(payload.tools).toHaveLength(registered.length);
    expect(payload.count).toBeGreaterThan(0);

    const byName = new Map(payload.tools.map((tool) => [tool.name, tool.description]));
    for (const tool of registered) {
      const description = byName.get(tool.name);
      expect(description, `missing CLI descriptor for ${tool.name}`).toBeTruthy();
      expect(description!.trim().length).toBeGreaterThan(0);
      expect(tool.description).toBe(description);
    }
    expect([...byName.keys()].sort()).toEqual([...registered.map((tool) => tool.name)].sort());
  });

  it("prints name + description rows for humans and documents --json in help", () => {
    const help = run(["--help"]);
    expect(help).toContain("loopover-mcp tools [--json]");

    const plain = run(["tools"]);
    const payload = JSON.parse(run(["tools", "--json"])) as {
      count: number;
      tools: Array<{ name: string; description: string }>;
    };
    expect(payload.tools.length).toBe(payload.count);
    for (const tool of payload.tools) {
      expect(plain).toContain(tool.name);
      expect(plain).toContain(tool.description);
      expect(tool.description.trim().length).toBeGreaterThan(0);
    }
  });
});
