import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getToolContract, getToolDefinition } from "@loopover/contract/tools";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/dist/bin/loopover-mcp.js");

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

  // #9537: the registration helper can only type a handler if the call site says which contract
  // input it takes, so this asserts the source itself -- every `registerStdioTool` handler declares
  // `z.infer<typeof …>` and none is left as `any`. tsc enforces that the annotation MATCHES the
  // registered schema; this enforces that an annotation exists at all, which tsc cannot (an `any`
  // typechecks fine).
  it("types every stdio tool handler from a contract schema, with no `any` left (#9537)", () => {
    const source = readFileSync(join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.ts"), "utf8");
    const callSites = [...source.matchAll(/registerStdioTool\(\n  "([a-z_]+)",\n  (?:async )?\(([^\n]*?)\) =>/g)];
    expect(callSites.length).toBeGreaterThan(100);
    for (const [, name, params] of callSites) {
      if (params!.trim() === "") continue;
      expect(params, `${name} handler is not typed from a contract schema`).toMatch(/: z\.infer<typeof \w+>/);
      expect(params, `${name} handler still takes \`any\``).not.toMatch(/:\s*any\b/);
    }
  });

  // #9537: the stdio server no longer states a tool's description or schemas -- it registers from
  // @loopover/contract. These three invariants are what that buys, and what would silently rot if a
  // future tool went back to declaring its own: every registered tool is IN the registry, advertises
  // an object-typed input schema, and advertises a real output schema. Before #9537, 97 of the 102
  // had no output schema at all, so a drifting payload was undetectable.
  it("registers every tool from the contract registry, with input and output schemas (#9537)", async () => {
    configDir = mkdtempSync(join(tmpdir(), "loopover-cli-tools-contract-"));
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
    client = new Client({ name: "tools-contract-test", version: "0.0.1" });
    await client.connect(transport);
    const { tools: registered } = await client.listTools();
    expect(registered.length).toBeGreaterThan(0);

    for (const tool of registered) {
      const contract = getToolContract(tool.name);
      expect(contract, `${tool.name} is registered but has no @loopover/contract entry`).toBeTruthy();
      expect(tool.description, `${tool.name} description drifted from the registry`).toBe(contract!.description);
      expect(tool.inputSchema?.type, `${tool.name} input schema is not object-typed`).toBe("object");
      expect(tool.outputSchema, `${tool.name} advertises no output schema`).toBeTruthy();
      expect((tool.outputSchema as { type?: string }).type).toBe("object");

      // #9655: and the PROJECTED metadata, not the raw contract. `contract.annotations` is a Partial
      // stating only what differs from the default posture, so passing it through advertised
      // `{ readOnlyHint: false }` with no `destructiveHint` for the five tools that declare one field,
      // and no annotations at all for the ~95 that declare none.
      const projected = getToolDefinition(tool.name)!;
      expect(tool.title, `${tool.name} title drifted from the registry`).toBe(projected.title);
      expect(tool.annotations, `${tool.name} posture drifted from the registry`).toMatchObject(projected.annotations);
    }

    // The case that motivated it, over the real transport: a destructive tool this server serves says so,
    // and a tool declaring nothing still advertises the complete default pair.
    const byName = new Map(registered.map((tool) => [tool.name, tool]));
    expect(byName.get("loopover_decide_pending_action")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("loopover_get_repo_context")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
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
