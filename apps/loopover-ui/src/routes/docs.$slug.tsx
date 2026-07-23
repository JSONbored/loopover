import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { LoadingState } from "@/components/site/state-views";
import { docsClientLoader } from "@/lib/docs-client-loader";
import { getDocPage } from "@/lib/docs-source.functions";

// One dynamic route for every docs page (#8151), replacing 49 near-identical per-page
// docs.<slug>.tsx files that each duplicated this exact loader/head/component shape by hand.
// title/description/eyebrow all come from the .mdx frontmatter (source.config.ts's schema),
// so adding a docs page is now just a new .mdx file + a nav entry -- no route file, no
// routeTree regen beyond what any new file already triggers, no test-count bump.
//
// docs.index.tsx (a real static page, not MDX-backed) and
// docs.fumadocs-spike-api-reference.tsx (a standalone Scalar widget, not DocsPage/MDX at all)
// stay as their own route files -- neither is boilerplate this route replaces.
export const Route = createFileRoute("/docs/$slug")({
  loader: async ({ params }) => {
    const page = await getDocPage({ data: { slugs: [params.slug] } });
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData, params }) => {
    if (!loaderData) return { meta: [{ title: "LoopOver docs" }] };
    const { title, description } = loaderData;
    const pageTitle = `${title} — LoopOver docs`;
    const url = `/docs/${params.slug}`;
    return {
      meta: [
        { title: pageTitle },
        { name: "description", content: description },
        { property: "og:title", content: pageTitle },
        { property: "og:description", content: description },
        { property: "og:url", content: url },
      ],
      links: [{ rel: "canonical", href: url }],
    };
  },
  component: DocsSlugPage,
});

function DocsSlugPage() {
  const { path, title, description, eyebrow } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow={eyebrow} title={title} description={description}>
      <Suspense fallback={<LoadingState />}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
