import { Outlet, createRootRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { GrafanaFooterLink } from "@/components/grafana-footer-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { ChatRail } from "@/components/chat-rail";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootShell>
      <Outlet />
    </RootShell>
  );
}

/**
 * The persistent app shell (#6513). Exported for unit testing. It owns the chat-rail open/collapsed state, and
 * because it's rendered by the root route, TanStack Router keeps it — and that state — mounted across
 * client-side navigation between the four routes, so the rail never resets on a route change. The routed page
 * is `children` (the `<Outlet/>` content), which is what swaps on navigation while this shell stays mounted.
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const [railOpen, setRailOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b-hairline px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-token-xs uppercase tracking-[0.2em] text-primary font-mono">LoopOver Miner</p>
            <h1 className="text-token-lg font-display font-semibold">Local dashboard</h1>
          </div>
          <nav className="flex gap-4 text-token-sm text-muted-foreground">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
            >
              Overview
            </Link>
            <Link
              to="/run-history"
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
            >
              Run history
            </Link>
            <Link
              to="/portfolio"
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
            >
              Portfolio
            </Link>
            <Link
              to="/ledgers"
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
            >
              Ledgers
            </Link>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      {/* Row: routed content + the persistent rail docked beside it (never overlapping) on wide viewports. */}
      <div className="mx-auto flex w-full max-w-[calc(64rem+380px)] items-stretch">
        <main className="min-w-0 flex-1 px-6 py-8">
          <div className="mx-auto max-w-5xl">{children}</div>
        </main>
        <ChatRail open={railOpen} onOpenChange={setRailOpen} />
      </div>
      <GrafanaFooterLink />
    </div>
  );
}
