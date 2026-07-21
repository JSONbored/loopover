import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-operations.mdx via fumadocs-mdx's browser
// entry (docsClientLoader), through the existing DocsPage/Callout/CodeBlock
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-operations")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-operations"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host operations — LoopOver docs" },
      {
        name: "description",
        content:
          "Operate the self-hosted LoopOver review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, safe updates/rollback, and clean uninstall/decommissioning.",
      },
      { property: "og:title", content: "Self-host operations — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Operate the self-hosted LoopOver review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, safe updates/rollback, and clean uninstall/decommissioning.",
      },
      { property: "og:url", content: "/docs/self-hosting-operations" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-operations" }],
  }),
  component: SelfHostingOperations,
});

export function SelfHostingOperations() {
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
