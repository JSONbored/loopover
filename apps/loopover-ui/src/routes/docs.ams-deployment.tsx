import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ams-deployment.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-deployment")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ams-deployment"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "AMS deployment guide — LoopOver docs" },
      {
        name: "description",
        content:
          "Deploy @loopover/miner in laptop mode (single machine, zero Docker) or fleet mode (containerized workers) — both 100% client-side, credentials never baked into images.",
      },
      { property: "og:title", content: "AMS deployment guide — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Deploy @loopover/miner in laptop mode (single machine, zero Docker) or fleet mode (containerized workers) — both 100% client-side, credentials never baked into images.",
      },
      { property: "og:url", content: "/docs/ams-deployment" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-deployment" }],
  }),
  component: AmsDeployment,
});

function AmsDeployment() {
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
