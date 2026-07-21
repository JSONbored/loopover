import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/maintainer-workflow.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/WorkflowMirror
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment for
// why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/maintainer-workflow")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["maintainer-workflow"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Maintainer workflow — LoopOver docs" },
      {
        name: "description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
      },
      { property: "og:title", content: "Maintainer workflow — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
      },
      { property: "og:url", content: "/docs/maintainer-workflow" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-workflow" }],
  }),
  component: MaintainerWorkflow,
});

function MaintainerWorkflow() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Workflows" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
