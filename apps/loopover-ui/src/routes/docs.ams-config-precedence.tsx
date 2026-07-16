import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ams-config-precedence.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-config-precedence")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ams-config-precedence"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
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
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
