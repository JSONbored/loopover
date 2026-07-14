import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/site/app-shell";

export const Route = createFileRoute("/app")({
  head: () => ({
    meta: [
      { title: "LoopOver app — control panels" },
      {
        name: "description",
        content:
          "LoopOver control panels: miner command center, maintainer console, agent run history, and operator dashboard.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AppShell,
});
