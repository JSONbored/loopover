import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/troubleshooting.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/troubleshooting")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["troubleshooting"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Troubleshooting — LoopOver docs" },
      {
        name: "description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:title", content: "Troubleshooting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:url", content: "/docs/troubleshooting" },
    ],
    links: [{ rel: "canonical", href: "/docs/troubleshooting" }],
  }),
  component: Troubleshooting,
});

function Troubleshooting() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Operating" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
