import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/self-hosting-backup-scaling.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-backup-scaling")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["self-hosting-backup-scaling"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Self-host backup and scaling — LoopOver docs" },
      {
        name: "description",
        content:
          "Back up and scale the self-hosted LoopOver review service with SQLite, Litestream, Postgres, Redis, and restore checks.",
      },
      { property: "og:title", content: "Self-host backup and scaling — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Back up and scale the self-hosted LoopOver review service with SQLite, Litestream, Postgres, Redis, and restore checks.",
      },
      { property: "og:url", content: "/docs/self-hosting-backup-scaling" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-backup-scaling" }],
  }),
  component: SelfHostingBackupScaling,
});

function SelfHostingBackupScaling() {
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
