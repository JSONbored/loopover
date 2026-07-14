import { createFileRoute } from "@tanstack/react-router";

import { CommandsPanel } from "@/components/site/app-panels/commands-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/commands")({
  component: CommandsRoute,
});

function CommandsRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Commands"
        title="@loopover command catalog"
        description="Preview maintainer command behavior against live API contracts without rerouting through the workbench."
      />
      <CommandsPanel />
    </div>
  );
}
