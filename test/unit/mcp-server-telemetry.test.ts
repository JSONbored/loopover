import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { listProductUsageEvents } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("MCP server telemetry", () => {
  afterEach(() => {
    vi.doUnmock("agents/mcp");
    vi.resetModules();
  });

  it("records sanitized error telemetry when the MCP transport handler throws", async () => {
    vi.resetModules();
    vi.doMock("agents/mcp", () => ({
      createMcpHandler: () => () => {
        throw new Error("transport_failed");
      },
    }));
    const { handleMcpRequest } = await import("../../src/mcp/server");
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "mcp-error-test-salt" });
    const request = new Request("https://api.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITTENSORY_MCP_TOKEN}`,
        "content-type": "application/json",
        "x-gittensory-mcp-package": "@jsonbored/gittensory-mcp",
        "x-gittensory-mcp-version": "0.4.0",
        "x-gittensory-mcp-client": "gittensory-mcp-cli",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "error-telemetry",
        method: "tools/call",
        params: { name: "gittensory_local_status" },
      }),
    });

    await expect(
      handleMcpRequest({
        env,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
        req: {
          method: "POST",
          raw: request,
          header: (name: string) => request.headers.get(name) ?? undefined,
        },
        json: (body: unknown, status?: number) => Response.json(body, status === undefined ? undefined : { status }),
      } as never),
    ).rejects.toThrow("transport_failed");

    await expect(listProductUsageEvents(env, { limit: 5 })).resolves.toEqual([
      expect.objectContaining({
        surface: "mcp",
        eventName: "mcp_tool_called",
        outcome: "error",
        clientName: "gittensory-mcp-cli",
        clientVersion: "0.4.0",
        metadata: expect.objectContaining({
          toolName: "gittensory_local_status",
          compatibilityStatus: "current",
        }),
      }),
    ]);
  });

  it("falls back when Hono does not expose an execution context", async () => {
    vi.resetModules();
    vi.doMock("agents/mcp", () => ({
      createMcpHandler: () => () => Response.json({ ok: true }),
    }));
    const { handleMcpRequest } = await import("../../src/mcp/server");
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "mcp-success-test-salt" });
    const request = new Request("https://api.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITTENSORY_MCP_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "ping", method: "ping" }),
    });
    const context = {
      env,
      req: {
        method: "POST",
        raw: request,
        header: (name: string) => request.headers.get(name) ?? undefined,
      },
      json: (body: unknown, status?: number) => Response.json(body, status === undefined ? undefined : { status }),
    };
    Object.defineProperty(context, "executionCtx", {
      get() {
        throw new Error("execution context unavailable");
      },
    });

    await expect(handleMcpRequest(context as never)).resolves.toMatchObject({ status: 200 });
    await expect(listProductUsageEvents(env, { limit: 5 })).resolves.toEqual([
      expect.objectContaining({
        surface: "mcp",
        eventName: "mcp_request",
        outcome: "success",
        clientName: "mcp",
        metadata: expect.objectContaining({ rpcMethod: "ping", compatibilityStatus: "unknown" }),
      }),
    ]);
  });

  it("records session-scoped MCP request errors without a tool name", async () => {
    vi.resetModules();
    vi.doMock("agents/mcp", () => ({
      createMcpHandler: () => () => {
        throw new Error("request_failed");
      },
    }));
    const { handleMcpRequest } = await import("../../src/mcp/server");
    const env = createTestEnv({ PRODUCT_USAGE_HASH_SALT: "mcp-session-error-salt", ADMIN_GITHUB_LOGINS: "oktofeesh1" });
    const { token } = await createSessionForGitHubUser(env, { login: "oktofeesh1", id: 12345 });
    const request = new Request("https://api.test/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "error-request", method: "ping" }),
    });

    await expect(
      handleMcpRequest({
        env,
        executionCtx: { waitUntil() {}, passThroughOnException() {} },
        req: {
          method: "POST",
          raw: request,
          header: (name: string) => request.headers.get(name) ?? undefined,
        },
        json: (body: unknown, status?: number) => Response.json(body, status === undefined ? undefined : { status }),
      } as never),
    ).rejects.toThrow("request_failed");

    await expect(listProductUsageEvents(env, { limit: 5 })).resolves.toEqual([
      expect.objectContaining({
        surface: "mcp",
        eventName: "mcp_request",
        outcome: "error",
        sessionHash: expect.any(String),
        metadata: expect.objectContaining({ rpcMethod: "ping" }),
      }),
    ]);
  });
});
