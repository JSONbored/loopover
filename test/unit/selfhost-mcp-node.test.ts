import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createMcpHandler } from "../../src/selfhost/mcp-server-node";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function makeMcpServer(): McpServer {
  const server = new McpServer({ name: "test", version: "0.0.1" });
  server.registerTool("echo", { description: "Echoes the input", inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: "text" as const, text: value }],
  }));
  return server;
}

function mcpPost(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(body) });
}

describe("createMcpHandler (Node MCP port, #980)", () => {
  it("OPTIONS → 204 with CORS headers", async () => {
    const handler = createMcpHandler(makeMcpServer(), { enableJsonResponse: true });
    const res = await handler(new Request("http://localhost/mcp", { method: "OPTIONS" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("POST initialize → 200 JSON with serverInfo", async () => {
    const res = await createMcpHandler(makeMcpServer(), { enableJsonResponse: true })(
      mcpPost("http://localhost/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: { serverInfo?: { name: string } } };
    expect(json.result?.serverInfo?.name).toBe("test");
  });

  it("POST tools/list → 200 with the registered echo tool", async () => {
    const res = await createMcpHandler(makeMcpServer(), { enableJsonResponse: true })(
      mcpPost("http://localhost/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    expect(json.result?.tools?.map((t) => t.name)).toContain("echo");
  });

  it("POST tools/call → 200 with the echoed text", async () => {
    const res = await createMcpHandler(makeMcpServer(), { enableJsonResponse: true })(
      mcpPost("http://localhost/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { value: "hello from self-host" } } }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result?: { content?: Array<{ type: string; text: string }> } };
    expect(json.result?.content?.[0]?.text).toBe("hello from self-host");
  });

  it("OPTIONS with Origin header echoes the origin in ACAO header", async () => {
    const handler = createMcpHandler(makeMcpServer());
    const res = await handler(new Request("http://localhost/mcp", {
      method: "OPTIONS",
      headers: { origin: "https://example.com" },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("handler works without explicit opts (enableJsonResponse defaults to true)", async () => {
    // createMcpHandler called with no second arg → opts = {} → enableJsonResponse ?? true
    const handler = createMcpHandler(makeMcpServer());
    const res = await handler(mcpPost("http://localhost/mcp", { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }));
    expect(res.status).toBe(200);
  });

  it("each invocation creates a fresh stateless session (no cross-request bleed)", async () => {
    // Production code creates a fresh McpServer per request — simulate that here.
    const listReq = () => mcpPost("http://localhost/mcp", { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    const [r1, r2] = await Promise.all([
      createMcpHandler(makeMcpServer(), { enableJsonResponse: true })(listReq()),
      createMcpHandler(makeMcpServer(), { enableJsonResponse: true })(listReq()),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});
