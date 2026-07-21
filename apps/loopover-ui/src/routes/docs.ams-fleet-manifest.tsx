import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-fleet-manifest.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-fleet-manifest")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-fleet-manifest"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Fleet run-manifest — LoopOver docs" },
      {
        name: "description",
        content:
          "The top-level config a fleet operator authors to run the miner across many repos at once -- which repos are in scope and how the worktree/concurrency budget is split.",
      },
      { property: "og:title", content: "Fleet run-manifest — LoopOver docs" },
      {
        property: "og:description",
        content:
          "The top-level config a fleet operator authors to run the miner across many repos at once -- which repos are in scope and how the worktree/concurrency budget is split.",
      },
      { property: "og:url", content: "/docs/ams-fleet-manifest" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-fleet-manifest" }],
  }),
  component: AmsFleetManifest,
});

function AmsFleetManifest() {
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
