import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-sizing.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-sizing")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-sizing"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Resource sizing — LoopOver docs" },
      {
        name: "description",
        content:
          "Real, measured CPU/RAM/disk numbers for laptop mode and fleet mode, so an operator can size a host or cluster from data instead of guessing.",
      },
      { property: "og:title", content: "Resource sizing — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Real, measured CPU/RAM/disk numbers for laptop mode and fleet mode, so an operator can size a host or cluster from data instead of guessing.",
      },
      { property: "og:url", content: "/docs/ams-sizing" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-sizing" }],
  }),
  component: AmsSizing,
});

function AmsSizing() {
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
