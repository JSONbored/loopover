import { createFileRoute } from "@tanstack/react-router";

import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/maintainer")({
  component: MaintainerRoute,
});

function MaintainerRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Maintainer"
        title="Maintainer console"
        description="Inspect install health, public-surface previews, and quiet-by-default maintainer controls directly."
      />
      <MaintainerPanel />
    </div>
  );
}
