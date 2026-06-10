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
        title="Registration workspace"
        description="Guided owner workflow for policy, data quality, queue health, onboarding docs, maintainer capacity, and suggested Gittensor config."
      />
      <OwnerPanel />
    </div>
  );
}
