import { createFileRoute } from "@tanstack/react-router";

import { ConfigGeneratorPanel } from "@/components/site/app-panels/config-generator-panel";
import { PageHeader } from "@/components/site/primitives";

export const Route = createFileRoute("/app/config-generator")({
  component: ConfigGeneratorRoute,
});

function ConfigGeneratorRoute() {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Maintainer"
        title="Config generator"
        description="Build a typed .loopover.yml from field groups. Secrets never enter generated config — only public-safe keys and model names."
      />
      <ConfigGeneratorPanel />
    </div>
  );
}
