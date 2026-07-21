import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/scoreability.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/scoreability")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["scoreability"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Scoreability — LoopOver docs" },
      {
        name: "description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:title", content: "Scoreability — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:url", content: "/docs/scoreability" },
    ],
    links: [{ rel: "canonical", href: "/docs/scoreability" }],
  }),
  component: Scoreability,
});

function Scoreability() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Core concepts" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
