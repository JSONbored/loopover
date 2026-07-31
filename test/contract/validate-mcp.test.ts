// The MCP contract validator (#9520).
//
// Makes LoopOver's tool contract ENFORCED rather than aspirational. It boots all three real MCP
// servers against a seeded local environment -- no network -- and for every registered tool:
//
//   1. asserts the server's `tools/list` agrees with the registry;
//   2. Ajv-compiles the advertised outputSchema up front, so an uncompilable schema fails loudly
//      rather than at whichever call happens to hit it first;
//   3. smoke-calls it with arguments SYNTHESIZED from its own advertised inputSchema, and validates
//      the successful result's structuredContent against that compiled schema;
//   4. asserts no registered tool was skipped.
//
// Plus the negative paths and the release version lock.
//
// WHY A TEST FILE RATHER THAN A BARE SCRIPT. The remote server imports `cloudflare:` modules, which
// the plain Node loader cannot resolve; vitest's Workers-aware resolution can. Running here also
// means the validator reuses the same seeded-D1 helper the rest of the suite does instead of
// standing up a second, divergent fixture environment. `npm run validate:mcp` runs exactly this
// file, and test:ci runs it as its own step.
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listToolDefinitions, type McpToolDefinition } from "@loopover/contract";
import { LoopoverMcp } from "../../src/mcp/server";
import { LATEST_RECOMMENDED_MCP_VERSION } from "../../src/services/mcp-compatibility";
import { createMinerMcpServer } from "../../packages/loopover-miner/bin/loopover-miner-mcp";
import { createTestEnv } from "../helpers/d1";
import {
  checkAdvertisedMetadata,
  checkAdvertisedShape,
  checkInputNarrowing,
  checkEveryToolCalled,
  checkVersionLock,
  checkWatchedPathsExist,
  diffToolSets,
  type ListedTool,
} from "../../scripts/lib/validate-mcp/invariants";
import { buildSmokeArguments, type JsonSchema } from "../../scripts/lib/validate-mcp/synthesize-input";
import { overrideFor, RELEASE_AUTOMATION_WATCHED_PATHS } from "../../scripts/lib/validate-mcp/overrides";

type ToolCallResult = { isError?: boolean; structuredContent?: unknown };
type CompiledValidators = Map<string, ReturnType<Ajv2020["compile"]>>;

/** Ajv rejects an unknown `format` by default; the contract legitimately uses `date-time`, and this
 *  validator checks STRUCTURE, not string formats. */
function createAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
}

/**
 * Strip the `$schema` the SDK stamps onto an advertised schema before compiling.
 *
 * The contract emits draft-2020-12, but the MCP SDK re-serializes it with a draft-07 `$schema`, so
 * an Ajv2020 instance refuses every one of them. Dropping the dialect declaration and compiling
 * with the 2020 validator is right rather than merely convenient: 2020-12 is the dialect the
 * contract actually authored, and none of these schemas use a construct whose meaning differs
 * between the two drafts.
 */
function withoutDialect(schema: object): object {
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

function compileOutputSchemas(listed: readonly ListedTool[]): { validators: CompiledValidators; failures: string[] } {
  const ajv = createAjv();
  const validators: CompiledValidators = new Map();
  const failures: string[] = [];
  for (const tool of listed) {
    if (!tool.outputSchema) continue;
    try {
      validators.set(tool.name, ajv.compile(withoutDialect(tool.outputSchema as object)));
    } catch (error) {
      failures.push(`${tool.name} outputSchema does not compile: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { validators, failures };
}

/**
 * Smoke-call every listed tool and validate the ones that succeed.
 *
 * An `isError` result is NOT a failure. A tool that reports "not configured", declines an
 * elicitation, or refuses a repo it cannot see has answered correctly for a cold fixture env; what
 * is enforced is that a SUCCESSFUL answer matches the schema the tool advertised. A thrown
 * transport error, by contrast, means the tool crashed rather than answered.
 */
async function smokeCallAll(
  client: Client,
  listed: readonly ListedTool[],
  validators: CompiledValidators,
): Promise<{ called: Set<string>; failures: string[]; validated: number; declined: number }> {
  const called = new Set<string>();
  const failures: string[] = [];
  let validated = 0;
  let declined = 0;
  for (const tool of listed) {
    const args = buildSmokeArguments(tool.inputSchema as JsonSchema | undefined, overrideFor(tool.name));
    called.add(tool.name);
    let result: ToolCallResult;
    try {
      result = (await client.callTool({ name: tool.name, arguments: args })) as ToolCallResult;
    } catch (error) {
      failures.push(`${tool.name} threw instead of answering: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (result.isError) {
      declined += 1;
      continue;
    }
    if (result.structuredContent === undefined) {
      failures.push(`${tool.name} succeeded without structuredContent, but advertises an outputSchema`);
      continue;
    }
    const validate = validators.get(tool.name);
    if (!validate) continue;
    if (validate(result.structuredContent)) {
      validated += 1;
    } else {
      const detail = (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
      failures.push(`${tool.name} structuredContent does not match its advertised outputSchema: ${detail}`);
    }
  }
  return { called, failures, validated, declined };
}

/** The negative paths every server must handle the documented way. */
async function checkNegativePaths(client: Client, sampleTool: string): Promise<string[]> {
  const failures: string[] = [];
  try {
    const unknown = (await client.callTool({ name: "loopover_definitely_not_a_tool", arguments: {} })) as ToolCallResult;
    if (!unknown.isError) failures.push("an unknown tool name did not produce isError");
  } catch {
    // The SDK surfaces an unknown tool as a protocol error on some transports; either shape is the
    // refusal this asserts.
  }
  try {
    const malformed = (await client.callTool({ name: sampleTool, arguments: { __not_a_declared_field__: Number.NaN } })) as ToolCallResult;
    if (!malformed.isError && malformed.structuredContent === undefined) {
      failures.push(`${sampleTool} neither refused nor answered malformed input`);
    }
  } catch {
    // A schema rejection raised as a protocol error is also a refusal.
  }
  return failures;
}

type ConnectableServer = { connect: (transport: InMemoryTransport) => Promise<void> };

async function connect(server: ConnectableServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "validate-mcp", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function validateSurface(
  client: Client,
  expected: readonly McpToolDefinition[],
): Promise<{ failures: string[]; tools: number; validated: number; declined: number }> {
  const listed = (await client.listTools()).tools as unknown as ListedTool[];
  const failures = [...diffToolSets(expected, listed), ...checkAdvertisedShape(listed), ...checkAdvertisedMetadata(expected, listed), ...checkInputNarrowing(expected, listed)];
  const { validators, failures: compileFailures } = compileOutputSchemas(listed);
  failures.push(...compileFailures);
  const { called, failures: callFailures, validated, declined } = await smokeCallAll(client, listed, validators);
  failures.push(...callFailures, ...checkEveryToolCalled(listed, called));
  failures.push(...(await checkNegativePaths(client, listed[0]!.name)));
  return { failures, tools: listed.length, validated, declined };
}

/** Report the split rather than a bare pass. A tool that DECLINES has answered correctly for a cold
 *  fixture env, but it did not exercise its output schema -- so a surface where everything declines
 *  proves far less than its tool count implies, and hiding that behind a green check would be the
 *  same self-congratulatory reporting this validator exists to replace. */
function report(surface: string, result: { tools: number; validated: number; declined: number }): void {
  process.stdout.write(`  ${surface}: ${result.tools} tools — ${result.validated} validated against their output schema, ${result.declined} declined in this env\n`);
}

describe("MCP contract validator (#9520)", () => {
  it("enforces the remote server's advertised contract", async () => {
    const client = await connect(new LoopoverMcp(createTestEnv()).createServer());
    try {
      // Set equality against a locality filter would be false precision in BOTH directions: the
      // remote server also serves tools the registry marks `local-git` (a caller may supply the
      // branch metadata itself instead of having it read off a checkout), and it does NOT serve the
      // miner's tools or the admin ones, which stay unregistered unless LOOPOVER_MCP_ADMIN_ENABLED
      // is set. So the strict assertion is the direction that actually matters -- nothing is
      // registered without a contract entry -- and the other direction is asserted separately below,
      // over the tools this server is the only possible home for.
      const registered = new Set(((await client.listTools()).tools as unknown as ListedTool[]).map((tool) => tool.name));
      const result = await validateSurface(client, listToolDefinitions().filter((tool) => registered.has(tool.name)));
      report("remote", result);
      expect(result.failures).toEqual([]);
      expect(result.tools).toBeGreaterThan(100);

      // Every `remote`-locality tool that is not self-host-only must be here: no other server can
      // serve one, so an absence is a promised capability with nothing behind it.
      const missing = listToolDefinitions({ locality: ["remote"] })
        .filter((tool) => tool.availability !== "selfhost")
        .map((tool) => tool.name)
        .filter((name) => !registered.has(name));
      expect(missing).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 180_000);

  it("enforces the remote server's ADMIN surface, which no other case can see", async () => {
    // #9657: the five admin tools register only when LOOPOVER_MCP_ADMIN_ENABLED is set, and every other
    // case here boots a server without it -- so the admin category was never diffed, compiled,
    // smoke-called or output-validated. That is how `loopover_admin_rotate_secret` kept registering from
    // schemas declared in src/mcp/server.ts long after its four siblings moved to the contract: the
    // validator's own "nothing is registered without a contract entry" assertion was structurally unable
    // to see the one tool that violated it.
    const client = await connect(new LoopoverMcp({ ...createTestEnv(), LOOPOVER_MCP_ADMIN_ENABLED: "1" }).createServer());
    try {
      const registered = new Set(((await client.listTools()).tools as unknown as ListedTool[]).map((tool) => tool.name));
      const result = await validateSurface(client, listToolDefinitions().filter((tool) => registered.has(tool.name)));
      report("remote+admin", result);
      expect(result.failures).toEqual([]);

      // Every admin tool the registry knows, with none left behind in a local declaration.
      const adminTools = listToolDefinitions({ category: ["admin"] }).map((tool) => tool.name);
      expect(adminTools.length).toBeGreaterThanOrEqual(5);
      expect(adminTools.filter((name) => !registered.has(name))).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 180_000);

  it("enforces the stdio server's advertised contract", async () => {
    const stdio = await import("../../packages/loopover-mcp/bin/loopover-mcp");
    const names = new Set<string>(stdio.STDIO_TOOL_NAMES);
    const client = await connect(stdio.server);
    try {
      // The stdio server's slice is its own explicit name list -- it spans localities, so no filter
      // reproduces it. Comparing against the registry entries FOR THOSE NAMES makes both directions
      // of diffToolSets meaningful: a name in the list the server never registered, and a registered
      // tool absent from the list, both fail.
      const result = await validateSurface(client, listToolDefinitions().filter((tool) => names.has(tool.name)));
      report("stdio", result);
      expect(result.failures).toEqual([]);
      expect(result.tools).toBe(stdio.STDIO_TOOL_NAMES.length);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 180_000);

  it("enforces the miner server's advertised contract", async () => {
    const client = await connect(createMinerMcpServer({}));
    try {
      const result = await validateSurface(client, listToolDefinitions({ locality: ["miner"] }));
      report("miner", result);
      expect(result.failures).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 180_000);

  it("REGRESSION (#10038): the stdio and miner servers advertise _meta.category for every listed tool", async () => {
    // registerStdioTool and registerMinerTool used to omit `_meta` entirely, so half of the stdio
    // server's tools/list (its locally-registered tools, as opposed to the proxied ones that inherit
    // the remote's `_meta`) and all of the miner's carried no category, even though checkAdvertisedMetadata
    // above already re-runs on every surface and would have caught it once the field was modelled.
    const categoryByName = new Map(listToolDefinitions().map((tool) => [tool.name, tool.category]));

    const stdio = await import("../../packages/loopover-mcp/bin/loopover-mcp");
    const stdioClient = await connect(stdio.server);
    try {
      const listed = (await stdioClient.listTools()).tools as unknown as ListedTool[];
      expect(listed.length).toBeGreaterThan(0);
      for (const tool of listed) {
        expect(tool._meta?.category).toBe(categoryByName.get(tool.name));
      }
    } finally {
      await stdioClient.close().catch(() => undefined);
    }

    const minerClient = await connect(createMinerMcpServer({}));
    try {
      const listed = (await minerClient.listTools()).tools as unknown as ListedTool[];
      expect(listed.length).toBeGreaterThan(0);
      for (const tool of listed) {
        expect(tool._meta?.category).toBe(categoryByName.get(tool.name));
      }
    } finally {
      await minerClient.close().catch(() => undefined);
    }
  }, 180_000);

  it("REGRESSION: one tool name has ONE locality, which is what makes gateway collisions impossible", () => {
    // #9526's gateway mounts every `remote` tool onto the stdio server, which serves the `local-git` ones.
    // That is only safe because a NAME belongs to exactly one entry in the one registry — the same name
    // registered at both localities would mean the gateway tries to register a tool the stdio server
    // already has, and the SDK throws on a duplicate. The registry structurally prevents it (one entry per
    // name); this asserts nothing has introduced a second.
    const byName = new Map<string, string[]>();
    for (const tool of listToolDefinitions()) {
      byName.set(tool.name, [...(byName.get(tool.name) ?? []), tool.locality]);
    }
    const ambiguous = [...byName.entries()].filter(([, localities]) => new Set(localities).size > 1);
    expect(ambiguous.map(([name]) => name)).toEqual([]);

    // And no name is declared twice at all, whatever its locality.
    const duplicated = [...byName.entries()].filter(([, localities]) => localities.length > 1);
    expect(duplicated.map(([name]) => name)).toEqual([]);
  });

  it("locks the published MCP version across the three places it appears", async () => {
    // #9661: `serverInfoVersion` used to be the SAME EXPRESSION as `packageVersion`, so the one leg
    // `checkVersionLock`'s own doc calls "the one that can drift" was asserted against itself. It is
    // read off a connected client now -- the value a real client actually sees.
    const packageVersion = (JSON.parse(readFileSync(join(process.cwd(), "packages/loopover-mcp/package.json"), "utf8")) as { version: string }).version;
    const stdio = await import("../../packages/loopover-mcp/bin/loopover-mcp");
    const client = await connect(stdio.server);
    try {
      expect(
        checkVersionLock({
          packageVersion,
          advertisedLatestVersion: LATEST_RECOMMENDED_MCP_VERSION,
          serverInfoVersion: client.getServerVersion()?.version,
        }),
      ).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 180_000);

  it("locks the miner server's advertised version to its own package", async () => {
    // The second server was unlocked entirely: it reads its version from its own package.json at
    // construction and nothing compared the two. No compatibility constant exists for the miner, so this
    // is the two-way lock. (The REMOTE server's `version: "0.1.0"` is hardcoded and stays out of the lock
    // deliberately -- making it derivable is #9526's, not this one's.)
    const packageVersion = (JSON.parse(readFileSync(join(process.cwd(), "packages/loopover-miner/package.json"), "utf8")) as { version: string }).version;
    const client = await connect(createMinerMcpServer({}));
    try {
      expect(checkVersionLock({ packageVersion, serverInfoVersion: client.getServerVersion()?.version, serverLabel: "miner" })).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("fails if a path the release automation reads has been moved or deleted", () => {
    // The anti-rot guard metagraphed's validator lacks: a version lock that only compares constants
    // to each other stays green while the thing meant to update them has stopped running -- the
    // constants agree precisely BECAUSE nothing is touching them.
    expect(checkWatchedPathsExist(RELEASE_AUTOMATION_WATCHED_PATHS, (path) => existsSync(join(process.cwd(), path)))).toEqual([]);
  });
});
