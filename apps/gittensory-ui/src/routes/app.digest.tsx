import { createFileRoute } from "@tanstack/react-router";

import { DigestPanel } from "@/components/site/app-panels/digest-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/digest")({
  component: DigestRoute,
});

function DigestRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Digest"
        title="Contribution digest"
        description="Review live digest data and store subscription preferences directly on the digest route."
      />
      <DigestPanel />
    </div>
  );
}
