import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/capacity.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/capacity")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["capacity"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Capacity and throughput — LoopOver docs" },
      {
        name: "description",
        content:
          "Real throughput and concurrency numbers for AMS's iterate-loop and the review-gate's PR-processing queue, so an operator can plan for load instead of guessing.",
      },
      { property: "og:title", content: "Capacity and throughput — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Real throughput and concurrency numbers for AMS's iterate-loop and the review-gate's PR-processing queue, so an operator can plan for load instead of guessing.",
      },
      { property: "og:url", content: "/docs/capacity" },
    ],
    links: [{ rel: "canonical", href: "/docs/capacity" }],
  }),
  component: Capacity,
});

function Capacity() {
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
