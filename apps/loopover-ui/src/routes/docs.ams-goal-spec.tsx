import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// Rendered from content/docs/ams-goal-spec.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.server.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ams-goal-spec")({
  loader: async () => {
    const page = await getDocPage({ data: { slugs: ["ams-goal-spec"] } });
    if (!page) throw notFound();
    return page;
  },
  head: () => ({
    meta: [
      { title: "MinerGoalSpec (.loopover-miner.yml) — LoopOver docs" },
      {
        name: "description",
        content:
          "Per-repo configuration telling an autonomous LoopOver miner what to look for and how to behave when targeting a repo -- the full field reference.",
      },
      { property: "og:title", content: "MinerGoalSpec (.loopover-miner.yml) — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Per-repo configuration telling an autonomous LoopOver miner what to look for and how to behave when targeting a repo -- the full field reference.",
      },
      { property: "og:url", content: "/docs/ams-goal-spec" },
    ],
    links: [{ rel: "canonical", href: "/docs/ams-goal-spec" }],
  }),
  component: AmsGoalSpec,
});

function AmsGoalSpec() {
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
