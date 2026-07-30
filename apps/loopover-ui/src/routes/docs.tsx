import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsNav } from "@/components/site/docs-nav";
import { DocsTocFromMdx } from "@/components/site/docs-toc";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — LoopOver" },
      {
        name: "description",
        content:
          "Documentation for LoopOver: install, MCP client setup, miner/maintainer workflows, GitHub App, branch analysis, scoreability, drift, privacy.",
      },
      { property: "og:title", content: "Docs — LoopOver" },
      {
        property: "og:description",
        content:
          "Documentation for LoopOver: install, MCP client setup, miner/maintainer workflows, GitHub App, branch analysis, scoreability, drift, privacy.",
      },
    ],
  }),
  component: DocsLayout,
});

function DocsLayout() {
  return (
    <div className="mx-auto max-w-7xl px-4 pb-24 pt-10 sm:px-6 lg:px-8">
      <div className="grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_200px]">
        <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-auto lg:pr-4">
          <DocsNav />
        </aside>
        <div className="min-w-0">
          <Outlet />
        </div>
        <aside className="hidden xl:block xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-auto">
          {/* #9872: the rail is built from the page's COMPILED toc, not from the rendered article, so it
              needs the MDX module -- which resolves in the child route. Suspense because that read shares
              the content's own cached promise and may not have settled yet; the rail is decorative, so a
              null fallback (no flash of an empty rail) is the right degradation. Docs routes with no
              compiled page -- the index and the API-reference spike -- render no rail: the index's only
              headings are its card titles, which made a list of link names rather than a table of
              contents. */}
          <Suspense fallback={null}>
            <DocsTocFromMdx />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}
