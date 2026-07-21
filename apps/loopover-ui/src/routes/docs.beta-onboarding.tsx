import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/beta-onboarding.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/beta-onboarding")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["beta-onboarding"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Beta onboarding — LoopOver docs" },
      {
        name: "description",
        content:
          "Role-based beta paths for miners, maintainers, repo owners, and operators — first useful action, not just API reference.",
      },
      { property: "og:title", content: "Beta onboarding — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Role-based beta paths for miners, maintainers, repo owners, and operators — first useful action, not just API reference.",
      },
      { property: "og:url", content: "/docs/beta-onboarding" },
    ],
    links: [{ rel: "canonical", href: "/docs/beta-onboarding" }],
  }),
  component: BetaOnboarding,
});

function BetaOnboarding() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Get started" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
