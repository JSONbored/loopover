import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/tuning.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/tuning")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["tuning"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Tuning your reviews — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure LoopOver CI and LoopOver review: gate modes, score thresholds, guardrails, and feature flags via .loopover.yml and repo settings.",
      },
      { property: "og:title", content: "Tuning your reviews — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure LoopOver CI and LoopOver review: gate modes, score thresholds, guardrails, and feature flags via .loopover.yml and repo settings.",
      },
      { property: "og:url", content: "/docs/tuning" },
    ],
    links: [{ rel: "canonical", href: "/docs/tuning" }],
  }),
  component: Tuning,
});

function Tuning() {
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
