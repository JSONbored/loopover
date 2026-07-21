import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// SPIKE (#6037): rendered from content/docs/self-hosting-quickstart.mdx via fumadocs-mdx's
// browser entry (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. The `loader` below runs server-only and
// resolves nothing but a plain, serializable path string via docs-source.ts's collections/server
// -- never the live MDX component -- which is what avoids the client-bundle crash that a direct
// collections/server import from route-module scope hits (see docs-source.server.ts's comment). Kept at
// the same route/URL as the pre-migration hand-built page to prove visual output is unchanged.
export const Route = createFileRoute("/docs/self-hosting-quickstart")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-quickstart"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-hosting quickstart — LoopOver docs" },
      {
        name: "description",
        content:
          "Bring up the LoopOver self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:title", content: "Self-hosting quickstart — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Bring up the LoopOver self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:url", content: "/docs/self-hosting-quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-quickstart" }],
  }),
  component: SelfHostingQuickstart,
});

function SelfHostingQuickstart() {
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
