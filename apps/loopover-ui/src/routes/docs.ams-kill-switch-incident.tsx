import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-kill-switch-incident.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-kill-switch-incident")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-kill-switch-incident"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Kill-switch incident runbook — LoopOver docs" },
      {
        name: "description",
        content:
          "Detect, activate, and audit a misbehaving Rent-a-Loop miner after the kill-switch stops it.",
      },
      { property: "og:title", content: "Kill-switch incident runbook — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Detect, activate, and audit a misbehaving Rent-a-Loop miner after the kill-switch stops it.",
      },
      { property: "og:url", content: "/docs/ams-kill-switch-incident" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-kill-switch-incident" }],
  }),
  component: AmsKillSwitchIncident,
});

function AmsKillSwitchIncident() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Maintainers" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
