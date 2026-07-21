import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/owner-checklist.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/owner-checklist")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["owner-checklist"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Repo-owner onboarding checklist — LoopOver docs" },
      {
        name: "description",
        content:
          "A pre-flight checklist for repo owners: registration, config quality, labels, issue quality, contribution lanes, validation, maintainer capacity, and the public/private boundary — with honest tradeoffs.",
      },
      { property: "og:title", content: "Repo-owner onboarding checklist — LoopOver docs" },
      {
        property: "og:description",
        content:
          "A pre-flight checklist for repo owners: registration, config quality, labels, issue quality, contribution lanes, validation, maintainer capacity, and the public/private boundary — with honest tradeoffs.",
      },
      { property: "og:url", content: "/docs/owner-checklist" },
    ],
    links: [{ rel: "canonical", href: "/docs/owner-checklist" }],
  }),
  component: OwnerChecklist,
});

function OwnerChecklist() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Repo owners" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
