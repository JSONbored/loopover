import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-release-checklist.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-release-checklist")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-release-checklist"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "First release checklist — LoopOver docs" },
      {
        name: "description",
        content:
          "Versioning and trigger for the first stable self-host image, the smoke-test matrix (direct App, brokered, air-gapped, each AI provider, SQLite/Postgres, Redis/Qdrant), an image-contents audit, the full-vs-minimal variant decision, and the GitHub Release notes template.",
      },
      { property: "og:title", content: "First release checklist — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Versioning, the smoke-test matrix, an image-contents audit, the image-variant decision, and the GitHub Release notes template for the first stable self-host image.",
      },
      { property: "og:url", content: "/docs/self-hosting-release-checklist" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-release-checklist" }],
  }),
  component: SelfHostingReleaseChecklist,
});

function SelfHostingReleaseChecklist() {
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
