import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-config-precedence.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-config-precedence")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-config-precedence"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Miner config precedence — LoopOver docs" },
      {
        name: "description",
        content:
          "How AMS layers configuration across per-repo goal spec, operator env, CLI flags, and operator policy files -- the order each concern actually implements today.",
      },
      { property: "og:title", content: "Miner config precedence — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How AMS layers configuration across per-repo goal spec, operator env, CLI flags, and operator policy files -- the order each concern actually implements today.",
      },
      { property: "og:url", content: "/docs/ams-config-precedence" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-config-precedence" }],
  }),
  component: AmsConfigPrecedence,
});

function AmsConfigPrecedence() {
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
