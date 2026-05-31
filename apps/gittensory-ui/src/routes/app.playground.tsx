import { createFileRoute } from "@tanstack/react-router";

import { PlaygroundPanel } from "@/components/site/app-panels/playground-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/playground")({
  component: PlaygroundRoute,
});

function PlaygroundRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Playground"
        title="Agent tool playground"
        description="Run preflight, planning, and blocker-explanation tools directly from the playground route."
      />
      <PlaygroundPanel />
    </div>
  );
}
