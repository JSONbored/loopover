import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { MethodPill } from "@/components/site/control-primitives";
import { openapi } from "@/lib/openapi";
import { cn } from "@/lib/utils";

export function ApiSidebar() {
  const [q, setQ] = useState("");
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  // Active op id (when on /api/$op)
  const params = useParams({ strict: false }) as { op?: string };
  const activeId = params?.op;

  const groups = useMemo(() => {
    if (!q.trim()) return openapi.tags;
    const needle = q.toLowerCase();
    return openapi.tags
      .map((g) => ({
        ...g,
        operations: g.operations.filter(
          (o) =>
            o.path.toLowerCase().includes(needle) ||
            o.summary.toLowerCase().includes(needle) ||
            o.method.includes(needle) ||
            o.tag.toLowerCase().includes(needle),
        ),
      }))
      .filter((g) => g.operations.length);
  }, [q]);

  const overviewActive = currentPath === "/api" || currentPath === "/api/";

  return (
    <aside className="sticky top-14 h-[calc(100vh-3.5rem)] w-full overflow-y-auto border-r border-border bg-background/40 scrollbar-none lg:w-72">
      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search endpoints"
            className="w-full rounded-token border border-border bg-transparent py-1.5 pl-7 pr-2 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-mint/40 focus:outline-none"
          />
        </div>
      </div>
      <nav className="px-1 py-2 pb-12">
        <Link
          to="/api"
          className={cn(
            "flex items-center justify-between rounded-token px-3 py-1.5 text-token-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground",
            overviewActive && "bg-accent/60 text-foreground",
          )}
        >
          <span>Overview</span>
        </Link>
        {groups.map((g) => (
          <div key={g.name} className="mt-3">
            <div className="px-3 pb-1 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground/70">
              {g.name}
            </div>
            <ul>
              {g.operations.map((op) => {
                const active = activeId === op.id;
                return (
                  <li key={op.id}>
                    <Link
                      to="/api/$op"
                      params={{ op: op.id }}
                      className={cn(
                        "group flex items-center gap-2 rounded-token px-3 py-1 text-token-xs text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground",
                        active && "bg-accent/60 text-foreground",
                      )}
                    >
                      <MethodPill method={op.method} className="shrink-0" />
                      <span className="truncate font-mono text-[11.5px]">{op.path}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
