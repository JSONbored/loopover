import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/privacy-security.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.server.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/privacy-security")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["privacy-security"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "Privacy & security — LoopOver docs" },
      {
        name: "description",
        content:
          "LoopOver's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:title", content: "Privacy & security — LoopOver docs" },
      {
        property: "og:description",
        content:
          "LoopOver's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:url", content: "/docs/privacy-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/privacy-security" }],
  }),
  component: PrivacySecurity,
});

function PrivacySecurity() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Operating" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
