import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/miner-quickstart.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/AmsObservabilityCallout
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/miner-quickstart")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["miner-quickstart"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Miner quickstart by lane — LoopOver docs" },
      {
        name: "description",
        content:
          "Pick a contribution lane, install @loopover/mcp, sign in, and run plan → preflight → packet. Lane-by-lane commands with JSON output and redaction notes.",
      },
      { property: "og:title", content: "Miner quickstart by lane — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Pick a contribution lane, install @loopover/mcp, sign in, and run plan → preflight → packet. Lane-by-lane commands with JSON output and redaction notes.",
      },
      { property: "og:url", content: "/docs/miner-quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/miner-quickstart" }],
  }),
  component: MinerQuickstart,
});

export function MinerQuickstart() {
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
