import { createFileRoute, Outlet } from "@tanstack/react-router";

import { ApiSidebar } from "@/components/site/api/api-sidebar";

export const Route = createFileRoute("/api")({
  head: () => ({
    meta: [
      { title: "API reference — Gittensory" },
      {
        name: "description",
        content:
          "Browse the Gittensory private API. Bring your own session token to try requests — tokens stay in your browser.",
      },
      { property: "og:url", content: "/api" },
    ],
    links: [{ rel: "canonical", href: "/api" }],
  }),
  component: ApiLayout,
});

function ApiLayout() {
  return (
    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <ApiSidebar />
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
}
