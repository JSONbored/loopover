import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ams-unattended-scheduling.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-unattended-scheduling")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ams-unattended-scheduling"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Unattended scheduling & failure alerting — LoopOver docs" },
      {
        name: "description",
        content:
          "Run the miner's scheduled commands -- manage poll and discover -- unattended on cron or systemd, and alert reliably when a run fails.",
      },
      { property: "og:title", content: "Unattended scheduling & failure alerting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Run the miner's scheduled commands -- manage poll and discover -- unattended on cron or systemd, and alert reliably when a run fails.",
      },
      { property: "og:url", content: "/docs/ams-unattended-scheduling" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-unattended-scheduling" }],
  }),
  component: AmsUnattendedScheduling,
});

function AmsUnattendedScheduling() {
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
