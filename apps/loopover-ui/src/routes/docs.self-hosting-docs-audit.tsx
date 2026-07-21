import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-docs-audit.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-docs-audit")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-docs-audit"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host docs accuracy audit — LoopOver docs" },
      {
        name: "description",
        content:
          "Checklist mapping self-host website docs to runtime sources of truth — compose defaults, env vars, releases, observability, backup, and drift guards.",
      },
      { property: "og:title", content: "Self-host docs accuracy audit — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Checklist mapping self-host website docs to runtime sources of truth — compose defaults, env vars, releases, observability, backup, and drift guards.",
      },
      { property: "og:url", content: "/docs/self-hosting-docs-audit" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-docs-audit" }],
  }),
  component: SelfHostingDocsAudit,
});

function SelfHostingDocsAudit() {
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
