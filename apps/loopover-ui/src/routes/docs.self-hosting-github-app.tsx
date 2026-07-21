import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-github-app.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-github-app")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-github-app"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host GitHub App and Orb — LoopOver docs" },
      {
        name: "description",
        content:
          "Connect a self-hosted LoopOver review service to GitHub with your own direct GitHub App (the default, recommended path) or private managed-beta brokered Orb enrollment.",
      },
      { property: "og:title", content: "Self-host GitHub App and Orb — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Connect a self-hosted LoopOver review service to GitHub with your own direct GitHub App (the default, recommended path) or private managed-beta brokered Orb enrollment.",
      },
      { property: "og:url", content: "/docs/self-hosting-github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-github-app" }],
  }),
  component: SelfHostingGithubApp,
});

function SelfHostingGithubApp() {
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
