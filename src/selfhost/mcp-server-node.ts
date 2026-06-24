// Node-compatible MCP handler (#980). Replaces the Cloudflare Agents SDK `createMcpHandler` (Durable-Object-
// backed) with `WebStandardStreamableHTTPServerTransport` from the MCP SDK, which uses Web Standard APIs and
// runs on Node 18+. Stateless mode: no server-side session state; each HTTP request is self-contained.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

type FetchHandler = (req: Request, env?: unknown, ctx?: unknown) => Promise<Response>;

export function createMcpHandler(
  server: McpServer,
  opts: { route?: string; enableJsonResponse?: boolean } = {},
): FetchHandler {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": req.headers.get("origin") ?? "*",
          "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id",
        },
      });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      // sessionIdGenerator omitted → stateless mode (each request is self-contained)
      enableJsonResponse: opts.enableJsonResponse ?? true,
    });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(req);
      return response;
    } finally {
      /* v8 ignore next -- transport.close() only rejects on internal MCP SDK teardown errors */
      await transport.close().catch(() => undefined);
    }
  };
}
