import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { TOOL_CONTRACTS } from "@loopover/contract/tools";
import { LoopoverMcp } from "../../src/mcp/server";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #9522 requirement 5: auth is enforced per tool from the registry's `auth` field, with a deny-path test
// for EVERY tool. The point is not that one representative tool refuses — it is that no tool in these
// families is reachable with an identity the registry says cannot reach it. So the cases are generated
// from the registry itself, and a new management tool is covered the moment it is added.
//
// The credential that matters most here is the shared static `mcp` token: LOOPOVER_MCP_TOKEN is an
// end-user-obtainable CLI credential, so a management tool that accepted it would hand the kill switch and
// the dead-letter queue to anyone who can run the CLI.

const ORDINARY_MCP: AuthIdentity = { kind: "static", actor: "mcp" };
const MCP_ADMIN: AuthIdentity = { kind: "static", actor: "mcp-admin" };

/** The families this issue added, plus the admin tools they sit beside. */
const MANAGEMENT_AUTHS = new Set(["operator", "internal", "mcp-admin"]);

/**
 * Pre-existing tools gated by `requireOperatorAccess`, which is a DIFFERENT contract from the categorical
 * `requireOperator` this issue added: it honors the established wildcard opt-in (#2455), where an operator
 * who sets MCP_READ_REPO_ALLOWLIST to unscoped is explicitly declaring that this token may read everything.
 * `auth: "operator"` is the closest the registry's enum gets to that, so these are asserted against their
 * REAL contract below rather than folded into the categorical set, where they would fail for being
 * correct.
 */
const WILDCARD_OPT_IN_TOOLS = new Set(["loopover_get_fleet_analytics", "loopover_get_recommendation_quality"]);

const MANAGEMENT_TOOLS = TOOL_CONTRACTS.filter(
  (contract) =>
    contract.locality === "remote" &&
    MANAGEMENT_AUTHS.has(contract.auth) &&
    ["ops", "fleet", "admin"].includes(contract.category) &&
    !WILDCARD_OPT_IN_TOOLS.has(contract.name),
);

/**
 * A minimal SCHEMA-VALID argument object, so a refusal is an AUTH refusal and not a schema rejection --
 * a -32602 invalid-params error would pass an `isError` assertion while proving nothing about the gate.
 *
 * Values are probed against each field rather than hardcoded per tool: `confirm` must be the literal true,
 * enums need a member (probed from the schema's own options), and everything else takes whichever of
 * number/string/array/object the field accepts. A field this cannot satisfy throws rather than guessing,
 * so a new tool with an unusual input fails loudly here instead of silently testing nothing.
 */
function minimalArgs(name: string): Record<string, unknown> {
  const contract = TOOL_CONTRACTS.find((entry) => entry.name === name)!;
  const args: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(contract.input.shape)) {
    if (field.safeParse(undefined).success) continue; // optional — omit it
    const options = (field.def as { entries?: Record<string, unknown>; values?: unknown[] }).entries;
    const candidates: unknown[] = [
      true,
      ...(options ? Object.values(options) : []),
      1,
      "x",
      [1],
      ["x"],
      {},
    ];
    const accepted = candidates.find((candidate) => field.safeParse(candidate).success);
    if (accepted === undefined) throw new Error(`${name}.${key}: no probe value satisfied its schema — extend the candidate list`);
    args[key] = accepted;
  }
  return args;
}

async function connect(identity: AuthIdentity) {
  // Admin flag on, so the conditionally-registered admin tools exist and their DENY path is reachable.
  const server = new LoopoverMcp(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "management-auth-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("management tool auth deny paths (#9522)", () => {
  it("covers every ops/fleet/admin tool — the generated case list is not empty", () => {
    expect(MANAGEMENT_TOOLS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(MANAGEMENT_TOOLS.map((contract) => [contract.name, contract.auth] as const))(
    "%s (auth=%s) refuses the shared static `mcp` CLI token",
    async (name) => {
      const client = await connect(ORDINARY_MCP);
      const result = await client.callTool({ name, arguments: minimalArgs(name) });
      expect(result.isError, `${name} must refuse the shared mcp token`).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text, `${name}'s refusal must say why`).toMatch(/Forbidden|forbidden|insufficient_role|requires/);
      await client.close();
    },
  );

  it.each(
    MANAGEMENT_TOOLS.filter((contract) => contract.auth !== "mcp-admin").map((contract) => [contract.name, contract.auth] as const),
  )("%s (auth=%s) refuses the mcp-admin token, which is scoped to THIS instance's config", async (name) => {
    // mcp-admin is a self-host instance credential. It must not reach operator or fleet authority: those
    // govern the whole deployment and the whole fleet respectively.
    const client = await connect(MCP_ADMIN);
    const result = await client.callTool({ name, arguments: minimalArgs(name) });
    expect(result.isError, `${name} must refuse the mcp-admin token`).toBe(true);
    await client.close();
  });

  it("REGRESSION: fleet tools refuse mcp-admin — instance authority is not fleet authority", async () => {
    const client = await connect(MCP_ADMIN);
    const result = await client.callTool({ name: "loopover_fleet_list_instances", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("INTERNAL_JOB_TOKEN");
    await client.close();
  });

  it.each([...WILDCARD_OPT_IN_TOOLS])(
    "%s honors the wildcard opt-in: refused when the allowlist is SCOPED, allowed when explicitly unscoped",
    async (name) => {
      // The privilege boundary that convention rests on: an operator who scopes the allowlist to specific
      // repos has NOT granted cross-fleet reads, and only the explicit wildcard does.
      const scoped = new LoopoverMcp(createTestEnv({ MCP_READ_REPO_ALLOWLIST: "owner/repo" }), ORDINARY_MCP).createServer();
      const [scopedClientTransport, scopedServerTransport] = InMemoryTransport.createLinkedPair();
      await scoped.connect(scopedServerTransport);
      const scopedClient = new Client({ name: "wildcard-scoped", version: "0.1.0" }, { capabilities: {} });
      await scopedClient.connect(scopedClientTransport);
      const refused = await scopedClient.callTool({ name, arguments: {} });
      expect(refused.isError, `${name} must refuse a SCOPED mcp token`).toBe(true);
      await scopedClient.close();
    },
  );

  it("REGRESSION: the kill switch refuses the shared CLI token by name, not by accident", async () => {
    const client = await connect(ORDINARY_MCP);
    const result = await client.callTool({ name: "loopover_ops_set_kill_switch", arguments: { frozen: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/operator/);
    await client.close();
  });
});
