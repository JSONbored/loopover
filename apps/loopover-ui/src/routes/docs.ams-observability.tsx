import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-observability.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-observability")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-observability"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Observing your miner — LoopOver docs" },
      {
        name: "description",
        content:
          "Point Grafana at redacted AMS reporting exports to see attempt and prediction history without exposing the miner's live local ledgers.",
      },
      { property: "og:title", content: "Observing your miner — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Point Grafana at redacted AMS reporting exports to see attempt and prediction history without exposing the miner's live local ledgers.",
      },
      { property: "og:url", content: "/docs/ams-observability" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-observability" }],
  }),
  component: AmsObservability,
});

function AmsObservability() {
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
