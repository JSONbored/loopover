import { useState } from "react";
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  Inbox,
  Activity,
  GitPullRequestArrow,
} from "lucide-react";
import { toast } from "sonner";

import { StatusPill } from "@/components/site/control-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StateBoundary } from "@/components/site/state-views";
import { apiFetch } from "@/lib/api/request";
import { getApiOrigin } from "@/lib/api/origin";
import { useApiResource } from "@/lib/api/use-api-resource";
import { cn } from "@/lib/utils";

type DigestItem = {
  kind: "summary" | "review-now" | "queue" | "drift" | "install";
  title: string;
  detail: string;
  meta?: string;
};

type DigestResponse = {
  date: string;
  signal: "ready" | "warn";
  items: DigestItem[];
  subscriptions: Array<{ email: string; status: string }>;
  delivery: { mode: "store_only"; emailDeliveryEnabled: boolean };
};

const ICONS: Record<DigestItem["kind"], React.ReactNode> = {
  summary: <Activity className="size-4 text-mint" />,
  "review-now": <GitPullRequestArrow className="size-4 text-success" />,
  queue: <Inbox className="size-4 text-warning" />,
  drift: <AlertTriangle className="size-4 text-warning" />,
  install: <Bell className="size-4 text-foreground/70" />,
};

export function DigestPanel() {
  const digest = useApiResource<DigestResponse>("/v1/app/digest", "Maintainer digest");
  const data = digest.status === "ready" ? digest.data : null;

  return (
    <StateBoundary
      isLoading={digest.status === "loading"}
      isError={digest.status === "error"}
      isEmpty={digest.status === "ready" && digest.data.items.length === 0}
      onRetry={digest.reload}
      onRefresh={digest.reload}
      loadingTitle="Loading digest…"
      emptyTitle="No digest updates yet"
      emptyDescription="When there are reviewability, install, or drift updates, the digest will show them here."
      errorDescription={digest.status === "error" ? digest.error : undefined}
    >
      {data ? (
        <div className="grid gap-8 lg:grid-cols-[340px_1fr] lg:items-start">
          <div className="mx-auto w-full max-w-[320px]">
            <PhoneFrame>
              <DigestStream items={data.items.slice(0, 4)} compact date={data.date} />
            </PhoneFrame>
            <p className="mt-3 text-center text-token-2xs text-muted-foreground">
              Live in-app digest preview. Email delivery is not enabled.
            </p>
          </div>

          <div className="rounded-token border-hairline bg-card p-6">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                  Today · {data.date}
                </div>
                <h2 className="mt-1 font-display text-token-xl font-semibold">
                  {data.items.length} updates worth looking at
                </h2>
              </div>
              <StatusPill status={data.signal === "ready" ? "ready" : "warn"}>
                Signal · {data.signal}
              </StatusPill>
            </div>
            <ul className="mt-5 divide-hairline">
              {data.items.map((item, index) => (
                <li
                  key={`${item.kind}-${index}`}
                  className="flex gap-3 rounded-token px-2 py-3.5 transition-colors hover:bg-muted/30 -mx-2"
                >
                  <span className="mt-0.5 shrink-0">{ICONS[item.kind]}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="text-token-sm font-medium text-foreground">{item.title}</h3>
                      {item.meta && (
                        <span className="font-mono text-token-2xs text-muted-foreground">
                          {item.meta}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-token-sm text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>

            <SubscribeForm subscribed={data.subscriptions.length > 0} onStored={digest.reload} />
          </div>
        </div>
      ) : null}
    </StateBoundary>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[2.2rem] border-hairline bg-background p-2 shadow-2xl">
      <div className="overflow-hidden rounded-[1.7rem] border-hairline bg-card">
        <div className="flex items-center justify-between bg-background/60 px-5 py-1.5 text-token-2xs font-mono text-muted-foreground">
          <span>9:41</span>
          <span className="size-1.5 rounded-full bg-mint" />
        </div>
        <div className="max-h-[540px] overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function DigestStream({
  items,
  compact,
  date,
}: {
  items: DigestItem[];
  compact?: boolean;
  date: string;
}) {
  return (
    <div>
      <div className="mb-3">
        <div className="font-display text-token-base font-semibold">LoopOver</div>
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          digest · {date}
        </div>
      </div>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={`${item.kind}-${index}`}
            className={cn(
              "rounded-token border-hairline bg-background/40 p-2.5",
              compact && "text-token-xs",
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{ICONS[item.kind]}</span>
              <div className="min-w-0">
                <div className="truncate text-foreground">{item.title}</div>
                <div className="line-clamp-2 text-token-2xs text-muted-foreground">
                  {item.detail}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SubscribeForm({ subscribed, onStored }: { subscribed: boolean; onStored: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const origin = getApiOrigin().replace(/\/$/, "");
        const result = await apiFetch(`${origin}/v1/app/digest/subscriptions`, {
          method: "POST",
          label: "Digest subscription",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        setBusy(false);
        if (!result.ok) {
          toast.error("Subscription not stored", { description: result.message });
          return;
        }
        toast.success("Digest subscription stored", {
          description: "Stored in LoopOver. Email delivery is not enabled yet.",
        });
        onStored();
      }}
      className="mt-6 flex flex-col gap-3 rounded-token border-hairline bg-background/40 p-4 sm:flex-row sm:items-center"
    >
      <div className="flex-1">
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Store-only digest
        </div>
        <div className="mt-0.5 text-token-sm">
          Persist a subscription record without claiming email delivery.
        </div>
      </div>
      <Input
        type="email"
        required
        placeholder="you@maintainer.dev"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        disabled={subscribed || busy}
        className="flex-1"
      />
      {subscribed ? (
        <Button type="button" variant="outline" disabled className="border-success/40 text-success">
          <CheckCircle2 className="size-3.5" />
          Stored
        </Button>
      ) : (
        <Button type="submit" disabled={busy}>
          {busy ? "Storing…" : "Store"}
        </Button>
      )}
    </form>
  );
}
