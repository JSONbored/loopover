import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { PageHeader } from "@/components/site/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaintainerPanel } from "@/components/site/app-panels/maintainer-panel";
import { OwnerPanel } from "@/components/site/app-panels/owner-panel";

const TABS = ["maintainer", "owner"] as const;
type Tab = (typeof TABS)[number];

const searchSchema = z.object({ tab: z.enum(TABS).optional() });

export const Route = createFileRoute("/app/repos")({
  validateSearch: (s) => searchSchema.parse(s),
  component: Repos,
});

const LABELS: Record<Tab, string> = {
  maintainer: "Maintainer console",
  owner: "Repo owner",
};

function Repos() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const value: Tab = tab ?? "maintainer";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Repositories"
        title="Maintainer & owner surfaces"
        description="Install health, public-surface previews, registration readiness, and Gittensor config recommendations — quiet by default."
      />
      <Tabs
        value={value}
        onValueChange={(v) => navigate({ search: { tab: v as Tab } })}
        className="w-full"
      >
        <TabsList className="h-auto flex-wrap gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="maintainer" className="mt-6">
          <MaintainerPanel />
        </TabsContent>
        <TabsContent value="owner" className="mt-6">
          <OwnerPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
