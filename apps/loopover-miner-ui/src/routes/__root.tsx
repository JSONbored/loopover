import { Outlet, createRootRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { GrafanaFooterLink } from "@/components/grafana-footer-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { ChatRail } from "@/components/chat-rail";
import { isDemoMode } from "@/lib/demo-data";

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

const NAV_ITEMS = [
  { to: "/", label: "Overview", exact: true },
  { to: "/run-history", label: "Run history" },
  { to: "/ranked-candidates", label: "Ranked candidates" },
  { to: "/portfolio", label: "Portfolio" },
  { to: "/ledgers", label: "Ledgers" },
  // #7673: layout reservation only — the route is an empty placeholder until settlement data exists.
  { to: "/earnings", label: "Earnings — not yet available" },
] as const;

/** Shared nav-link chrome (#6828) — mint underline active cue mirrors loopover-ui's site-header. */
const NAV_LINK_CLASS =
  "relative shrink-0 px-1 py-1 text-token-sm transition-colors duration-150 motion-reduce:transition-none hover:text-foreground after:content-[''] after:absolute after:left-0 after:right-0 after:-bottom-1 after:h-[2px] after:rounded-full after:bg-transparent after:scale-x-0 after:origin-left after:transition-transform after:duration-200 motion-reduce:after:transition-none focus-ring rounded-token-sm";

/**
 * The persistent app shell (#6513). Exported for unit testing. It owns the chat-rail open/collapsed state, and
 * because it's rendered by the root route, TanStack Router keeps it — and that state — mounted across
 * client-side navigation between the dashboard routes, so the rail never resets on a route change. The routed
 * page is `children` (the `<Outlet/>` content), which is what swaps on navigation while this shell stays mounted.
 *
 * Header chrome (#6828): sticky translucent bar + mint-underline active routes (site-header language), without
 * adopting sidebar.tsx as primary nav (reserved for the chat rail's mobile sheet).
 */
export function RootShell({ children }: { children: React.ReactNode }) {
  const [railOpen, setRailOpen] = React.useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b-hairline bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <p className="text-token-xs uppercase tracking-[0.2em] text-primary font-mono">LoopOver Miner</p>
              {isDemoMode() ? (
                <span className="rounded-token-sm border border-mint/40 bg-mint/10 px-1.5 py-0.5 text-token-2xs font-mono uppercase tracking-wider text-mint">
                  Demo — sample data, no live backend
                </span>
              ) : null}
            </div>
            <h1 className="text-token-lg font-display font-semibold">Local dashboard</h1>
          </div>
          <nav
            aria-label="Primary"
            className="flex max-w-full flex-1 basis-full items-center gap-3 overflow-x-auto text-muted-foreground sm:basis-auto sm:justify-center md:gap-4"
          >
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                {...("exact" in item && item.exact ? { activeOptions: { exact: true } } : {})}
                className={NAV_LINK_CLASS}
                activeProps={{
                  className: "text-foreground font-medium after:scale-x-100 after:bg-mint",
                  "aria-current": "page",
                }}
                inactiveProps={{
                  className: "text-muted-foreground hover:after:scale-x-100 hover:after:bg-foreground/40",
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto shrink-0 sm:ml-0">
            <ThemeToggle />
          </div>
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
