import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-rag.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-rag")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-rag"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host RAG indexing — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure retrieval-augmented review context for self-hosted LoopOver with embeddings, Qdrant, indexing jobs, and cold-index behavior.",
      },
      { property: "og:title", content: "Self-host RAG indexing — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure retrieval-augmented review context for self-hosted LoopOver with embeddings, Qdrant, indexing jobs, and cold-index behavior.",
      },
      { property: "og:url", content: "/docs/self-hosting-rag" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rag" }],
  }),
  component: SelfHostingRag,
});

function SelfHostingRag() {
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
