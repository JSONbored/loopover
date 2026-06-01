import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/mcp-clients")({
  head: () => ({
    meta: [
      { title: "MCP client setup — Gittensory docs" },
      {
        name: "description",
        content:
          "Wire the Gittensory MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:title", content: "MCP client setup — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Wire the Gittensory MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:url", content: "/docs/mcp-clients" },
    ],
    links: [{ rel: "canonical", href: "/docs/mcp-clients" }],
  }),
  component: McpClients,
});

function McpClients() {
  return (
    <DocsPage
      eyebrow="Get started"
      title="MCP client setup"
      description="Configure your coding agent to talk to the Gittensory MCP. Pick stdio for local agents, remote for cloud agents."
    >
      <h2>Generate config</h2>
      <p>These commands print config only. They do not mutate your local client files.</p>
      <CodeBlock
        lang="bash"
        code={`gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
gittensory-mcp init-client --print mcp`}
      />
      <p>
        <code>--print mcp</code> uses the same JSON snippet as Claude Desktop and Cursor for other
        stdio MCP hosts that expect the <code>mcpServers</code> shape.
      </p>

      <h2>Codex (OpenAI)</h2>
      <CodeBlock
        filename="~/.codex/config.toml"
        lang="toml"
        code={`[mcp_servers.gittensory]
command = "npx"
args = ["-y", "@jsonbored/gittensory-mcp", "--stdio"]`}
      />

      <h2>Claude Desktop</h2>
      <CodeBlock
        filename="claude_desktop_config.json"
        lang="json"
        code={`{
  "mcpServers": {
    "gittensory": {
      "command": "npx",
      "args": ["-y", "@jsonbored/gittensory-mcp", "--stdio"]
    }
  }
}`}
      />

      <h2>Cursor</h2>
      <CodeBlock
        filename=".cursor/mcp.json"
        lang="json"
        code={`{
  "mcpServers": {
    "gittensory": {
      "command": "npx",
      "args": ["-y", "@jsonbored/gittensory-mcp", "--stdio"]
    }
  }
}`}
      />

      <h2>Remote MCP</h2>
      <p>
        The Worker also exposes a remote MCP endpoint. Use this when your agent runs in the cloud or
        you don't want a local Node process.
      </p>
      <CodeBlock lang="http" code={`https://gittensory-api.aethereal.dev/mcp`} />

      <Callout variant="safety">
        Local <code>--stdio</code> is the default recommendation. It keeps auth + analysis on your
        machine and is the easiest path to log into with GitHub Device Flow.
      </Callout>
    </DocsPage>
  );
}
