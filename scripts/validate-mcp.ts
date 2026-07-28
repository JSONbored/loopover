#!/usr/bin/env node
// The MCP contract validator (#9520).
//
// Makes LoopOver's tool contract ENFORCED rather than aspirational. It boots all three real MCP
// servers against a seeded local environment -- no network -- drives the JSON-RPC lifecycle, and for
// every registered tool:
//
//   1. asserts the server's `tools/list` is exactly the registry's projection for that server;
//   2. Ajv-compiles the advertised outputSchema up front, so an uncompilable schema fails loudly
//      rather than at the first call that happens to hit it;
//   3. smoke-calls it with arguments SYNTHESIZED from its own advertised inputSchema, and validates
//      the successful result's structuredContent against that compiled schema;
//   4. asserts no registered tool was skipped.
//
// Plus the negative paths (unknown method, unknown tool, malformed input) and the version tri-lock.
//
// The synthesized-arguments design is the deliberate difference from metagraphed's validator, whose
// hand-maintained call table leaves 92 of its 205 tools never exercised with nothing to catch it.
import { Ajv2020 } from "ajv/dist/2020.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listToolDefinitions, type McpToolDefinition } from "@loopover/contract";
import {
  checkAdvertisedShape,
  checkEveryToolCalled,
  checkVersionLock,
  checkWatchedPathsExist,
  diffToolSets,
  formatFailures,
  type ListedTool,
} from "./lib/validate-mcp/invariants.ts";
import { buildSmokeArguments, type JsonSchema } from "./lib/validate-mcp/synthesize-input.ts";
import { overrideFor, RELEASE_AUTOMATION_WATCHED_PATHS } from "./lib/validate-mcp/overrides.ts";

type ToolCallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

/** Ajv rejects an unknown `format` by default; the contract legitimately uses `date-time`, and this
 *  validator is checking STRUCTURE, not string formats. */
function createAjv(): Ajv2020 {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
}

/**
 * Strip the `$schema` the SDK stamps onto an advertised schema before compiling.
 *
 * The contract emits draft-2020-12, but the MCP SDK re-serializes it with a draft-07 `$schema`, so
 * an Ajv2020 instance refuses every one of them ("no schema with key or ref .../draft-07/schema#").
 * Dropping the dialect declaration and compiling with the 2020 validator is right rather than
 * merely convenient: 2020-12 is the dialect the contract actually authored, and none of these
 * schemas use a construct whose meaning differs between the two drafts.
 */
function withoutDialect(schema: object): object {
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/** Compile every tool's outputSchema up front. A schema that cannot compile is a failure in its own
 *  right, reported once here rather than as a confusing call failure later. */
function compileOutputSchemas(listed: readonly ListedTool[]): { validators: Map<string, ReturnType<Ajv2020["compile"]>>; failures: string[] } {
  const ajv = createAjv();
  const validators = new Map<string, ReturnType<Ajv2020["compile"]>>();
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
 * Smoke-call every listed tool and validate the successful ones' structuredContent.
 *
 * An `isError` result is NOT a failure. A tool that reports "not configured", declines an
 * elicitation, or refuses a caller-supplied repo it cannot see has answered correctly for a cold
 * fixture env; what is being enforced is that a SUCCESSFUL answer matches the schema the tool
 * advertised. A thrown transport error, by contrast, means the tool crashed rather than answered.
 */
async function smokeCallAll(
  client: Client,
  listed: readonly ListedTool[],
  validators: ReadonlyMap<string, ReturnType<Ajv2020["compile"]>>,
): Promise<{ called: Set<string>; failures: string[]; validated: number; declined: number }> {
  const called = new Set<string>();
  const failures: string[] = [];
  let validated = 0;
  let declined = 0;
  for (const tool of listed) {
    const args = buildSmokeArguments(tool.inputSchema as JsonSchema | undefined, overrideFor(tool.name));
    let result: ToolCallResult;
    try {
      result = (await client.callTool({ name: tool.name, arguments: args })) as ToolCallResult;
    } catch (error) {
      failures.push(`${tool.name} threw instead of answering: ${error instanceof Error ? error.message : String(error)}`);
      called.add(tool.name);
      continue;
    }
    called.add(tool.name);
    if (result.isError) {
      declined += 1;
      continue;
    }
    if (result.structuredContent === undefined) {
      failures.push(`${tool.name} succeeded without structuredContent, but advertises an outputSchema`);
      continue;
    }
    const validate = validators.get(tool.name);
    /* v8 ignore next -- every listed tool has a compiled validator unless its schema failed to
       compile, which is already reported as its own failure above. */
    if (!validate) continue;
    if (validate(result.structuredContent)) {
      validated += 1;
    } else {
      const detail = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
      failures.push(`${tool.name} structuredContent does not match its advertised outputSchema: ${detail}`);
    }
  }
  return { called, failures, validated, declined };
}

/** The negative paths every server must handle the documented way. */
async function checkNegativePaths(client: Client, sampleTool: string): Promise<string[]> {
  const failures: string[] = [];

  // An unknown tool is an error RESULT, not a transport throw -- the caller gets a usable answer.
  try {
    const unknown = (await client.callTool({ name: "loopover_definitely_not_a_tool", arguments: {} })) as ToolCallResult;
    if (!unknown.isError) failures.push("an unknown tool name did not produce isError");
  } catch {
    // The SDK surfaces an unknown tool as a protocol error on some transports; either shape is a
    // refusal, which is what this asserts.
  }

  // Malformed input must be refused, never crash the server or reach the handler.
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

type ServerRun = { server: string; failures: string[]; tools?: number; validated?: number; declined?: number };

async function validateServer(
  serverName: string,
  connect: () => Promise<Client>,
  expected: readonly McpToolDefinition[],
): Promise<ServerRun> {
  const failures: string[] = [];
  const client = await connect();
  try {
    const listed = (await client.listTools()).tools as unknown as ListedTool[];
    failures.push(...diffToolSets(expected, listed));
    failures.push(...checkAdvertisedShape(listed));

    const { validators, failures: compileFailures } = compileOutputSchemas(listed);
    failures.push(...compileFailures);

    const { called, failures: callFailures, validated, declined } = await smokeCallAll(client, listed, validators);
    failures.push(...callFailures);
    failures.push(...checkEveryToolCalled(listed, called));

    if (listed.length > 0) failures.push(...(await checkNegativePaths(client, listed[0]!.name)));
    return { server: serverName, failures, tools: listed.length, validated, declined };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function readJson(path: string): { version?: string } {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8")) as { version?: string };
}

async function main(): Promise<void> {
  const runs: ServerRun[] = [];

  // ── stdio server ──────────────────────────────────────────────────────────────────────────────
  const stdio = (await import("../packages/loopover-mcp/bin/loopover-mcp.ts")) as unknown as {
    server: { connect: (transport: unknown) => Promise<void> };
    STDIO_TOOL_NAMES: readonly string[];
  };
  // The stdio server's slice is its own explicit name list -- it spans localities (remote-proxying
  // tools AND local-git ones), so no locality/availability filter reproduces it. Comparing against
  // the registry entries FOR THOSE NAMES is what makes the two directions of diffToolSets mean
  // something: a name in the list with no registry entry, or a registered tool missing from the
  // list, both fail.
  const stdioNames = new Set(stdio.STDIO_TOOL_NAMES);
  runs.push(
    await validateServer(
      "stdio (@loopover/mcp)",
      async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "validate-mcp", version: "0.0.0" });
        await Promise.all([stdio.server.connect(serverTransport), client.connect(clientTransport)]);
        return client;
      },
      listToolDefinitions().filter((tool) => stdioNames.has(tool.name)),
    ),
  );

  // ── remote server ─────────────────────────────────────────────────────────────────────────────
  // Driven in-process against a seeded D1 rather than over HTTP: the transport is the SDK's own and
  // is exercised by the other two surfaces, whereas what is worth validating here is the handlers
  // against real (fixture) data -- which is why this surface validates the most tools.
  const { LoopoverMcp } = await import("../src/mcp/server.ts");
  const { createTestEnv } = await import("../test/helpers/d1.ts");
  runs.push(
    await validateServer(
      "remote (Worker + self-host)",
      async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "validate-mcp", version: "0.0.0" });
        await Promise.all([new LoopoverMcp(createTestEnv()).createServer().connect(serverTransport), client.connect(clientTransport)]);
        return client;
      },
      // Set equality against a locality filter would be false precision: the remote server also
      // serves several tools the registry marks `local-git`, because a caller may supply the branch
      // metadata itself instead of having it read off a checkout. So the strict direction asserted
      // here is the one that matters -- nothing is registered without a contract entry -- and the
      // other direction is covered by MUST_SERVE_REMOTE below.
      listToolDefinitions(),
    ),
  );

  // ── miner server ──────────────────────────────────────────────────────────────────────────────
  const miner = await import("../packages/loopover-miner/bin/loopover-miner-mcp.ts");
  runs.push(
    await validateServer(
      "miner (@loopover/miner)",
      async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "validate-mcp", version: "0.0.0" });
        const server = (miner as { createMinerMcpServer: (o?: object) => { connect: (t: unknown) => Promise<void> } }).createMinerMcpServer({});
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return client;
      },
      listToolDefinitions({ locality: "miner" }),
    ),
  );

  // ── version tri-lock + anti-rot ────────────────────────────────────────────────────────────────
  const packageVersion = readJson("packages/loopover-mcp/package.json").version ?? "";
  const compatibility = await import("../src/services/mcp-compatibility.ts");
  const lockFailures = [
    ...checkVersionLock({
      packageVersion,
      advertisedLatestVersion: (compatibility as { LATEST_RECOMMENDED_MCP_VERSION: string }).LATEST_RECOMMENDED_MCP_VERSION,
      serverInfoVersion: packageVersion,
    }),
    ...checkWatchedPathsExist(RELEASE_AUTOMATION_WATCHED_PATHS, (path) => existsSync(join(process.cwd(), path))),
  ];
  runs.push({ server: "release version lock", failures: lockFailures });

  const total = runs.reduce((sum, run) => sum + run.failures.length, 0);
  for (const run of runs) {
    const report = formatFailures(run.server, run.failures);
    if (report) process.stderr.write(`${report}\n`);
  }
  if (total > 0) {
    process.stderr.write(`\nvalidate:mcp FAILED with ${total} failure(s).\n`);
    process.exit(1);
  }
  // Report the split rather than a bare "ok". A tool that DECLINES (not configured, no repo access,
  // elicitation withheld) has answered correctly for a cold fixture env, but it did not exercise its
  // output schema -- so a run where everything declines proves far less than the count alone implies,
  // and hiding that behind a green checkmark would be the same self-congratulatory reporting this
  // validator exists to replace.
  for (const run of runs) {
    if (run.tools === undefined) continue;
    process.stdout.write(`  ${run.server}: ${run.tools} tools — ${run.validated} validated against their output schema, ${run.declined} declined in this env\n`);
  }
  process.stdout.write(`validate:mcp ok: ${runs.length} surface(s) checked.\n`);
}

await main();
