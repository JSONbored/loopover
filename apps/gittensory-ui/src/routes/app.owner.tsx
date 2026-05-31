import { createFileRoute } from "@tanstack/react-router";

import { OwnerPanel } from "@/components/site/app-panels/owner-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/owner")({
  component: OwnerRoute,
});

function OwnerRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Owner"
        title="Repository owner surface"
        description="Review registration readiness, config recommendations, and repo-owner signals directly."
      />
      <OwnerPanel />
    </div>
  );
}
