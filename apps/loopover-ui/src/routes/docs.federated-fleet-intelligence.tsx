import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/federated-fleet-intelligence.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/federated-fleet-intelligence")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["federated-fleet-intelligence"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Federated fleet intelligence — LoopOver docs" },
      {
        name: "description",
        content:
          "Opt-in sharing of anonymized gate-calibration aggregates between self-hosted LoopOver instances: what is shared, how consent works, and how trust is gated.",
      },
      { property: "og:title", content: "Federated fleet intelligence — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Opt-in sharing of anonymized gate-calibration aggregates between self-hosted LoopOver instances: what is shared, how consent works, and how trust is gated.",
      },
      { property: "og:url", content: "/docs/federated-fleet-intelligence" },
    ],
    links: [{ rel: "canonical", href: "/docs/federated-fleet-intelligence" }],
  }),
  component: FederatedFleetIntelligence,
});

function FederatedFleetIntelligence() {
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
