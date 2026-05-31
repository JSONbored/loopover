import { createFileRoute, Outlet } from "@tanstack/react-router";

import { DocsNav } from "@/components/site/docs-nav";
import { DocsToc } from "@/components/site/docs-toc";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs — Gittensory" },
      {
        name: "description",
        content:
          "Documentation for Gittensory: install, MCP client setup, miner/maintainer workflows, GitHub App, branch analysis, scoreability, drift, privacy.",
      },
      { property: "og:title", content: "Docs — Gittensory" },
      {
        property: "og:description",
        content:
          "Documentation for Gittensory: install, MCP client setup, miner/maintainer workflows, GitHub App, branch analysis, scoreability, drift, privacy.",
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
          <DocsToc />
        </aside>
      </div>
    </div>
  );
}
