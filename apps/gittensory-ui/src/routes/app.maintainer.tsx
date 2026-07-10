import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";
import { PageHeader } from "@/components/site/primitives";

const searchSchema = z.object({
  repo: z.string().optional(),
});

export const Route = createFileRoute("/app/maintainer")({
  validateSearch: (search) => searchSchema.parse(search),
  component: MaintainerRoute,
});

function MaintainerRoute() {
  const { repo } = Route.useSearch();

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Maintainer"
        title="Maintainer console"
        description="Inspect install health, public-surface previews, and quiet-by-default maintainer controls directly."
      />
      <MaintainerPanel initialRepoFullName={repo} />
    </div>
  );
}
