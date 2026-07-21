import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/maintainer-self-hosting.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/FeatureRow primitives -- not
// fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the loader below
// resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/maintainer-self-hosting")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["maintainer-self-hosting"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-hosted reviews — LoopOver docs" },
      {
        name: "description",
        content:
          "A maintainer guide to self-hosting the LoopOver review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
      },
      { property: "og:title", content: "Self-hosted reviews — LoopOver docs" },
      {
        property: "og:description",
        content:
          "A maintainer guide to self-hosting the LoopOver review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
      },
      { property: "og:url", content: "/docs/maintainer-self-hosting" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-self-hosting" }],
  }),
  component: MaintainerSelfHosting,
});

function MaintainerSelfHosting() {
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
