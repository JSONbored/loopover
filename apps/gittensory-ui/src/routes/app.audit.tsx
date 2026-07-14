import { createFileRoute } from "@tanstack/react-router";

import { AuditFeed } from "@/components/site/audit-feed";
import { PageHeader } from "@/components/site/primitives";
import { EmptyState } from "@/components/site/state-views";
import { type AppRole, useSession } from "@/lib/api/session";

export const Route = createFileRoute("/app/audit")({
  component: AuditRoute,
});

const AUDIT_ROLES: AppRole[] = ["maintainer", "owner", "operator"];

function AuditRoute() {
  const { session, hydrated } = useSession();
  const canAccess = session?.roles.some((role) => AUDIT_ROLES.includes(role)) ?? false;

  if (!hydrated) {
    return null;
  }

  if (!canAccess) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Audit"
          title="Skipped PR audit feed"
          description="Review why LoopOver kept public GitHub App output quiet for specific pull requests."
        />
        <EmptyState
          title="Maintainer access required"
          description="Sign in with a maintainer, owner, or operator role to inspect skipped PR audit events."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Audit"
        title="Skipped PR audit feed"
        description="Filterable trail of public-surface skip decisions — reason, repository, pull request, and remediation guidance. No wallet, hotkey, or private source data."
      />
      <AuditFeed enabled={canAccess} />
    </div>
  );
}
