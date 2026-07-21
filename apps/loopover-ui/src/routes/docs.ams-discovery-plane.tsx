import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-discovery-plane.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-discovery-plane")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-discovery-plane"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Hosted discovery plane — LoopOver docs" },
      {
        name: "description",
        content:
          "How a loopover-miner instance opts into the optional hosted discovery-index plane, what it may send, and what never leaves the operator's machine.",
      },
      { property: "og:title", content: "Hosted discovery plane — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How a loopover-miner instance opts into the optional hosted discovery-index plane, what it may send, and what never leaves the operator's machine.",
      },
      { property: "og:url", content: "/docs/ams-discovery-plane" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-discovery-plane" }],
  }),
  component: AmsDiscoveryPlane,
});

function AmsDiscoveryPlane() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Maintainers" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
