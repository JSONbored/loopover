// Self-host replacement for agents/mcp. The Cloudflare Agents SDK transport is Durable-Object-backed
// (Workers-only); this re-exports the Node-compatible WebStandardStreamableHTTP implementation instead.
export { createMcpHandler } from "../mcp-server-node";
