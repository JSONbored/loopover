import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { setSecretRotator } from "../../src/mcp/redeploy-companion-registry";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// The one-call rotation surface (#9543), on top of the same host companion the redeploy tool uses. Mirrors
// mcp-admin-redeploy-tool.test.ts, which covers the sibling tool's gating/auth/audit in the same shape.

const MCP_ADMIN_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp-admin" };
const MCP_ORDINARY_IDENTITY: AuthIdentity = { kind: "static", actor: "mcp" };
const VALID = { secret: "claude_code_oauth_token", value: "sk-ant-oat01-rotated" };

async function connect(env: Env, identity: AuthIdentity = MCP_ADMIN_IDENTITY) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-admin-rotate-secret-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

afterEach(() => {
  setSecretRotator(null);
});

describe("MCP admin rotate-secret tool: registration gating (#9543)", () => {
  it("is NOT registered when LOOPOVER_MCP_ADMIN_ENABLED is unset (default off)", async () => {
    const client = await connect(createTestEnv());
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === "loopover_admin_rotate_secret")).toBe(false);
  });

  it("IS registered, with the admin category, when the flag is truthy", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "loopover_admin_rotate_secret");
    expect(tool).toBeDefined();
    expect((tool!._meta as { category?: string } | undefined)?.category).toBe("admin");
  });
});

describe("MCP admin rotate-secret tool: auth boundary (#9543)", () => {
  it("rejects the ordinary mcp actor even when the flag is on and a rotator is configured", async () => {
    const rotator = vi.fn();
    setSecretRotator(rotator);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), MCP_ORDINARY_IDENTITY);
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.isError).toBe(true);
    expect(rotator).not.toHaveBeenCalled();
  });

  it("rejects a session identity too -- a static-credential-only surface", async () => {
    setSecretRotator(vi.fn());
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }), { kind: "session", actor: "some-login", session: {} as never });
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.isError).toBe(true);
  });
});

describe("MCP admin rotate-secret tool: behaviour (#9543)", () => {
  it("reports not-configured when no companion is installed", async () => {
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect((result.structuredContent as { configured: boolean }).configured).toBe(false);
  });

  it("rotates via the companion and reports that no restart is needed for the claude token", async () => {
    setSecretRotator(async () => ({ ok: true, backupPath: "/opt/loopover/.deploy-backups/x.bak" }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.structuredContent).toMatchObject({ configured: true, ok: true, secret: "claude_code_oauth_token", backupPath: "/opt/loopover/.deploy-backups/x.bak" });
    expect(JSON.stringify(result.content)).toMatch(/No restart needed/i);
  });

  it("tells the operator to restart for a secret that is only read at boot", async () => {
    setSecretRotator(async () => ({ ok: true }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: { secret: "github_webhook_secret", value: "whsec-rotated" } });
    expect(JSON.stringify(result.content)).toMatch(/Restart the loopover service/i);
  });

  it("surfaces a host-side refusal without claiming success", async () => {
    setSecretRotator(async () => ({ ok: false, error: "invalid_secret_value" }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.structuredContent).toMatchObject({ configured: true, ok: false, error: "invalid_secret_value" });
  });

  it("surfaces an unreachable companion as a failure, not a success", async () => {
    setSecretRotator(async () => {
      throw new Error("ENOENT: no such socket");
    });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.structuredContent).toMatchObject({ configured: true, ok: false });
    expect(JSON.stringify(result.content)).toMatch(/could not reach the host companion/i);
  });

  it("reports a refusal that carries no error message without printing 'undefined'", async () => {
    setSecretRotator(async () => ({ ok: false }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.structuredContent).toMatchObject({ configured: true, ok: false });
    expect(JSON.stringify(result.content)).toMatch(/unknown error/i);
    expect(JSON.stringify(result.content)).not.toMatch(/undefined/);
  });

  it("handles a non-Error rejection from the companion client", async () => {
    setSecretRotator(async () => {
      throw "socket exploded"; // eslint-disable-line no-throw-literal -- exercises the String(error) arm
    });
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    expect(result.structuredContent).toMatchObject({ configured: true, ok: false, error: "socket exploded" });
  });

  it("NEVER echoes the credential back in the result or the summary", async () => {
    setSecretRotator(async () => ({ ok: true }));
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: VALID });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(VALID.value);
    expect(serialized).toContain("claude_code_oauth_token"); // which secret IS reported
  });

  it("rejects a multi-line value at the schema boundary, before the companion is called", async () => {
    const rotator = vi.fn(async () => ({ ok: true }));
    setSecretRotator(rotator);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    const result = await client.callTool({ name: "loopover_admin_rotate_secret", arguments: { secret: "claude_code_oauth_token", value: "# label\nsk-ant-real" } });
    expect(result.isError).toBe(true);
    expect(rotator).not.toHaveBeenCalled();
  });

  it("rejects a padded value, a comment value, and an unknown secret name at the schema boundary", async () => {
    const rotator = vi.fn(async () => ({ ok: true }));
    setSecretRotator(rotator);
    const client = await connect(createTestEnv({ LOOPOVER_MCP_ADMIN_ENABLED: "true" }));
    for (const args of [
      { secret: "claude_code_oauth_token", value: "  sk-ant-x" },
      { secret: "claude_code_oauth_token", value: "#sk-ant-x" },
      { secret: "claude_code_oauth_token", value: "" },
      { secret: "etc_passwd", value: "sk-ant-x" },
    ]) {
      expect((await client.callTool({ name: "loopover_admin_rotate_secret", arguments: args })).isError).toBe(true);
    }
    expect(rotator).not.toHaveBeenCalled();
  });
});
