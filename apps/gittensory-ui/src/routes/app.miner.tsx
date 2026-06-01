import { createFileRoute } from "@tanstack/react-router";

import { MinerPanel } from "@/components/site/app-panels/miner-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/miner")({
  component: MinerRoute,
});

function MinerRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Miner"
        title="Miner dashboard"
        description="Plan next actions, inspect scoreability, and review live contributor context directly."
      />
      <MinerPanel />
    </div>
  );
}
