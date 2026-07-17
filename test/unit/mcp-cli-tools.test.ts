import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

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
    configDir = mkdtempSync(join(tmpdir(), "loopover-cli-tools-"));
    const apiUrl = await startFixtureServer();
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: {
        ...process.env,
        LOOPOVER_CONFIG_DIR: configDir,
        LOOPOVER_API_URL: apiUrl,
        LOOPOVER_TOKEN: "session-token",
        LOOPOVER_API_TIMEOUT_MS: "5000",
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

  it("annotates every tool with exactly one known category and groups the output by it (#6301)", () => {
    const categories = [
      { id: "discovery", label: "Discovery & planning" },
      { id: "branch", label: "Local branch & PR prep" },
      { id: "review", label: "Review & gate prediction" },
      { id: "agent", label: "Agent automation" },
      { id: "maintainer", label: "Maintainer & repo owner" },
      { id: "utility", label: "Registry, config & status" },
    ];
    const validIds = new Set(categories.map((category) => category.id));

    const payload = JSON.parse(run(["tools", "--json"])) as {
      count: number;
      categories: Array<{ id: string; label: string; count: number }>;
      tools: Array<{ name: string; category: string; description: string }>;
    };

    // Every tool has exactly one category, and it is one of the known ids.
    for (const tool of payload.tools) {
      expect(typeof tool.category, `missing category for ${tool.name}`).toBe("string");
      expect(validIds.has(tool.category), `unknown category ${tool.category} for ${tool.name}`).toBe(true);
    }

    // The category summary partitions the tools exactly: counts sum to the total, and each label
    // matches the canonical one for its id.
    const summedCount = payload.categories.reduce((total, category) => total + category.count, 0);
    expect(summedCount).toBe(payload.count);
    const labelById = new Map(categories.map((category) => [category.id, category.label]));
    for (const category of payload.categories) {
      expect(category.label).toBe(labelById.get(category.id));
      expect(category.count).toBe(payload.tools.filter((tool) => tool.category === category.id).length);
    }

    // Human output groups tools under their category headers, in the canonical order, with every
    // tool listed exactly once under a header that matches its own category.
    const plain = run(["tools"]);
    const emittedLabels = payload.categories.map((category) => category.label);
    const headerOrder = emittedLabels.map((label) => plain.indexOf(`${label} (`));
    expect(headerOrder.every((index) => index >= 0)).toBe(true);
    expect([...headerOrder]).toEqual([...headerOrder].sort((a, b) => a - b));
    for (const category of payload.categories) {
      expect(plain).toContain(`${category.label} (${category.count})`);
    }
  });

  it("documents LOOPOVER_LOGIN / GITHUB_LOGIN in the --help Environment block (#5930)", () => {
    const help = run(["--help"]);
    expect(help).toContain("Environment:");
    // Seven subcommands resolve the login from LOOPOVER_LOGIN (then GITHUB_LOGIN); help must list it.
    expect(help).toMatch(/LOOPOVER_LOGIN or GITHUB_LOGIN/);
  });
});
