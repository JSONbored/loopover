import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/site/primitives";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MinerPanel } from "@/components/site/app-panels/miner-panel";
import { PlaygroundPanel } from "@/components/site/app-panels/playground-panel";
import { CommandsPanel } from "@/components/site/app-panels/commands-panel";
import { DigestPanel } from "@/components/site/app-panels/digest-panel";
import { useLocalStorage } from "@/lib/use-local-storage";

const TABS = ["miner", "playground", "commands", "digest"] as const;
type Tab = (typeof TABS)[number];

const searchSchema = z.object({ tab: z.enum(TABS).optional() });

export const Route = createFileRoute("/app/workbench")({
  validateSearch: (s) => searchSchema.parse(s),
  component: Workbench,
});

const LABELS: Record<Tab, string> = {
  miner: "Miner",
  playground: "Playground",
  commands: "@loopover",
  digest: "Digest",
};

function Workbench() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [lastTab, setLastTab, hydrated] = useLocalStorage<Tab>(
    "loopover.workbench.tab",
    "miner",
    "gittensory.workbench.tab",
  );
  const value: Tab = tab ?? lastTab;

  // Restore last tab into URL when no explicit ?tab= is present.
  useEffect(() => {
    if (hydrated && !tab && lastTab !== "miner") {
      navigate({ search: { tab: lastTab }, replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workbench"
        title="Plan, preflight, and explain"
        description="Drive ranked next actions, run agent tools, preview maintainer commands, and inspect digests from the live LoopOver API."
      />
      <Tabs
        value={value}
        onValueChange={(v) => {
          setLastTab(v as Tab);
          navigate({ search: { tab: v as Tab } });
        }}
        className="w-full"
      >
        <TabsList className="h-auto flex-wrap gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t}>
              {LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="miner" className="mt-6">
          <MinerPanel />
        </TabsContent>
        <TabsContent value="playground" className="mt-6">
          <PlaygroundPanel />
        </TabsContent>
        <TabsContent value="commands" className="mt-6">
          <CommandsPanel />
        </TabsContent>
        <TabsContent value="digest" className="mt-6">
          <DigestPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
