import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/mcp-clients.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/mcp-clients")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["mcp-clients"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "MCP client setup — LoopOver docs" },
      {
        name: "description",
        content:
          "Wire the LoopOver MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:title", content: "MCP client setup — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Wire the LoopOver MCP into Codex, Claude Desktop, Cursor, or any MCP-aware client over stdio or remote.",
      },
      { property: "og:url", content: "/docs/mcp-clients" },
    ],
    links: [{ rel: "canonical", href: "/docs/mcp-clients" }],
  }),
  component: McpClients,
});

function McpClients() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Get started" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
