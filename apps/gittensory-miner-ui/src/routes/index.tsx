import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent, CardHeader } from "@jsonbored/gittensory-ui-kit/components/card";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

export function IndexPage() {
  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Dashboard shell ready</h2>
      </CardHeader>
      <CardContent>
        <p className="max-w-2xl text-token-sm leading-token-relaxed text-muted-foreground">
          This package is the empty Phase 6 scaffold for a local, read-only miner dashboard. Run-history and portfolio
          views will mount here in follow-up issues once the local data-access layer is wired.
        </p>
      </CardContent>
    </Card>
  );
}
