import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-configuration.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-configuration")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-configuration"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host configuration — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:title", content: "Self-host configuration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:url", content: "/docs/self-hosting-configuration" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-configuration" }],
  }),
  component: SelfHostingConfiguration,
});

function SelfHostingConfiguration() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Self-hosting" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
