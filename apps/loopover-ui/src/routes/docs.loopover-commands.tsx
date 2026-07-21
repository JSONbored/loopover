import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/loopover-commands.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/CommandTable
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/loopover-commands")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["loopover-commands"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "@loopover command reference — LoopOver docs" },
      {
        name: "description",
        content:
          "Every @loopover PR and issue comment command: syntax, default authorization roles, and the hard boundary between auto-review and the one-shot gate.",
      },
      { property: "og:title", content: "@loopover command reference — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Every @loopover PR and issue comment command: syntax, default authorization roles, and the hard boundary between auto-review and the one-shot gate.",
      },
      { property: "og:url", content: "/docs/loopover-commands" },
    ],
    links: [{ rel: "canonical", href: "/docs/loopover-commands" }],
  }),
  component: LoopOverCommandsReference,
});

function LoopOverCommandsReference() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Commands" title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
