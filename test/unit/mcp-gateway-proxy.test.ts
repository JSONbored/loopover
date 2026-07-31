// REGRESSION (#10036): registerProxiedTool's handler used to hand a remote JSON-RPC error envelope
// back to the caller AS IF it were the tool's own result. `apiPost` only throws on a non-2xx HTTP
// status, and the remote runs with `enableJsonResponse: true`, so a request-level failure -- an
// unknown tool, bad arguments, whatever -- comes back as HTTP 200 with `{ jsonrpc, id, error }` and no
// `result` key. `result ?? payload` returned that raw envelope verbatim: no `content`, no `isError`, not
// a CallToolResult at all.
//
// Drives the real `registerProxiedTool` in-process (mounted through `mountRemoteTools`, connected over
// an in-memory transport) rather than unit-testing a helper pulled out for the occasion: the bug lived
// in the handler closure itself, and `packages/loopover-mcp/bin/loopover-mcp.ts` reports zero coverage
// under subprocess spawn, so only an in-process call attributes these lines to the patch (mirrors
// test/contract/validate-mcp.test.ts, which imports this same module the same way).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MCP_TELEMETRY_ERROR_CODES } from "@loopover/contract";
import type { GatewayFetch, RemoteToolDescriptor } from "../../packages/loopover-mcp/lib/gateway";

type ToolCallResult = { isError?: boolean; content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };

const REMOTE_TOOL: RemoteToolDescriptor = {
  name: "loopover_gateway_proxy_probe",
  title: "Gateway proxy probe",
  description: "A remote-only tool this package does not model, mounted purely to exercise the proxy handler.",
  inputSchema: { type: "object" },
};

/** Answers the gateway's OWN discovery call (`mountRemoteTools`'s `fetchImpl`) with one remote tool. */
const discoveryFetch: GatewayFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ result: { tools: [REMOTE_TOOL] } }),
});

/** What the proxied tool's own `tools/call` (routed through `apiPost`, i.e. the real global `fetch`) answers. */
let nextCallResponse: unknown;

let client: Client;

beforeAll(async () => {
  vi.stubEnv("LOOPOVER_API_TOKEN", "test-session-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify(nextCallResponse),
    })),
  );

  const { server, mountRemoteTools } = await import("../../packages/loopover-mcp/bin/loopover-mcp");
  const mounted = await mountRemoteTools({ argv: [], fetchImpl: discoveryFetch });
  if (mounted.status !== "mounted" || !mounted.tools.some((tool) => tool.name === REMOTE_TOOL.name)) {
    throw new Error(`expected ${REMOTE_TOOL.name} to mount, got: ${JSON.stringify(mounted)}`);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "mcp-gateway-proxy-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close().catch(() => undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("registerProxiedTool's handler translates the remote's JSON-RPC envelope (#10036)", () => {
  it("REGRESSION: a remote JSON-RPC error must not be returned as the tool's result", async () => {
    nextCallResponse = { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool loopover_x not found" } };

    const result = (await client.callTool({ name: REMOTE_TOOL.name, arguments: {} })) as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content?.length).toBeGreaterThan(0);
    expect(result.content?.[0]?.text).toContain("Tool loopover_x not found");
    const structured = result.structuredContent as { error?: { code?: unknown; message?: unknown } };
    expect(structured.error?.message).toBe("Tool loopover_x not found");
    expect(MCP_TELEMETRY_ERROR_CODES).toContain(structured.error?.code);
    // The JSON-RPC numeric code is not part of the closed telemetry vocabulary and must never leak through.
    expect(structured.error?.code).not.toBe(-32602);
  });

  it("a payload carrying neither result nor error also becomes an isError:true result", async () => {
    nextCallResponse = { jsonrpc: "2.0", id: 1 };

    const result = (await client.callTool({ name: REMOTE_TOOL.name, arguments: {} })) as ToolCallResult;
    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { error?: { code?: unknown; message?: unknown } };
    expect(MCP_TELEMETRY_ERROR_CODES).toContain(structured.error?.code);
  });

  it("a payload carrying a result is still returned verbatim, unwrapped, with no added isError", async () => {
    nextCallResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "hello from the remote" }], structuredContent: { ok: true } },
    };

    const result = (await client.callTool({ name: REMOTE_TOOL.name, arguments: {} })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]?.text).toBe("hello from the remote");
    expect(result.structuredContent).toEqual({ ok: true });
  });
});
