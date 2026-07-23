import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { setRedeployTrigger } from "../../src/mcp/redeploy-companion-registry";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const MCP_ADMIN_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp-admin" };
const MCP_ORDINARY_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp" };

async function connect(env: Env, identity: AuthIdentity = MCP_ADMIN_IDENTITY) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-admin-redeploy-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  setRedeployTrigger(null);
});

describe("MCP admin redeploy tool: registration gating (#7723)", () => {
  it("is NOT registered when LOOPOVER_MCP_ADMIN_ENABLED is unset (default off)", async () => {
    const client = await connect(createTestEnv());
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "loopover_admin_trigger_redeploy")).toBe(false);
  });

  it("IS registered, with the admin category, when LOOPOVER_MCP_ADMIN_ENABLED is truthy", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_admin_trigger_redeploy");
    expect(tool).toBeDefined();
    expect((tool!._meta as { category?: string } | undefined)?.category).toBe("admin");
  });
});

describe("MCP admin redeploy tool: auth boundary (#7723)", () => {
  it("rejects the ordinary mcp actor even when the flag is on and a trigger is configured", async () => {
    setRedeployTrigger(vi.fn());
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), MCP_ORDINARY_IDENTITY);
    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Forbidden/i);
  });

  it("rejects a session identity too -- this is a static-credential-only surface", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), { kind: "session", actor: "some-login", session: {} as never });
    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/Forbidden/i);
  });
});

describe("MCP admin redeploy tool: not-configured behavior (#7723)", () => {
  it("reports configured=false when no trigger is registered (no companion, or REDEPLOY_COMPANION_TOKEN unset)", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { configured: boolean }).configured).toBe(false);
  });
});

describe("MCP admin redeploy tool: input validation (#7723)", () => {
  it("rejects an image value with shell/compose-interpolation metacharacters before ever calling the trigger", async () => {
    const trigger = vi.fn();
    setRedeployTrigger(trigger);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: { image: "not a valid $(image)" } });
    expect(result.isError).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
  });

  it.each(["has`a`backtick", "has;a;semicolon", "has|a|pipe", "has&an&ampersand", "has<a>anglebracket"])(
    "rejects shell metacharacters in image: %s",
    async (image) => {
      const trigger = vi.fn();
      setRedeployTrigger(trigger);
      const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
      const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: { image } });
      expect(result.isError).toBe(true);
      expect(trigger).not.toHaveBeenCalled();
    },
  );
});

describe("MCP admin redeploy tool: trigger call (#7723)", () => {
  it("calls the registered trigger with the given image and reports a successful result", async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, log: ["pulling...", "restarting..."] });
    setRedeployTrigger(trigger);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: { image: "ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0" } });

    expect(trigger).toHaveBeenCalledExactlyOnceWith("ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ configured: true, ok: true, exitCode: 0, log: ["pulling...", "restarting..."] });
  });

  it("calls the registered trigger with undefined when no image is given", async () => {
    const trigger = vi.fn().mockResolvedValue({ ok: true, exitCode: 0, log: [] });
    setRedeployTrigger(trigger);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    expect(trigger).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("reports a failed redeploy (ok:false result from a real run) as a normal, non-error tool result -- not an MCP-level error", async () => {
    setRedeployTrigger(vi.fn().mockResolvedValue({ ok: false, exitCode: 1, error: "health check timed out", log: ["pulling...", "restarting..."] }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ configured: true, ok: false, exitCode: 1, error: "health check timed out", log: ["pulling...", "restarting..."] });
  });

  it("catches a connection/protocol failure to the companion itself and reports it as a normal tool result, distinct from a ran-but-failed redeploy", async () => {
    setRedeployTrigger(vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED /run/loopover-redeploy.sock")));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { configured: boolean; ok: boolean; error: string };
    expect(data.configured).toBe(true);
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/ECONNREFUSED/);
  });

  it("handles a non-Error rejection from the trigger without crashing", async () => {
    setRedeployTrigger(vi.fn().mockRejectedValue("a plain string rejection"));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));

    const result = await client.callTool({ name: "loopover_admin_trigger_redeploy", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { error: string }).error).toBe("a plain string rejection");
  });
});
