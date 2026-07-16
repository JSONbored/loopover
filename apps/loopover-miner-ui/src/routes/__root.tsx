import { Outlet, createRootRoute, Link } from "@tanstack/react-router";
import { GrafanaFooterLink } from "@/components/grafana-footer-link";
import { ThemeToggle } from "@/components/theme-toggle";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b-hairline px-6 py-4">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          <div>
            <p className="text-token-xs uppercase tracking-[0.2em] text-primary font-mono">LoopOver Miner</p>
            <h1 className="text-token-lg font-display font-semibold">Local dashboard</h1>
          </div>
          <nav className="flex gap-4 text-token-sm text-muted-foreground">
            {/* Active-route styling + aria-current via TanStack Router's activeProps (#6507): the current
                route's link reads as `text-primary` (the same token the "LoopOver Miner" kicker uses), so
                "where am I" is both visible and exposed to assistive tech. `/` needs exact matching or it would
                stay active on every nested route. No new colors -- only existing @loopover/ui-kit tokens. */}
            <Link
              to="/"
              activeOptions={{ exact: true }}
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
            >
              Overview
            </Link>
            <Link
              to="/run-history"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
            >
              Run history
            </Link>
            <Link
              to="/portfolio"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
            >
              Portfolio
            </Link>
            <Link
              to="/ledgers"
              activeProps={{ className: "text-primary font-medium", "aria-current": "page" }}
              className="hover-surface rounded-token-sm px-2 py-1 hover:text-foreground"
            >
              Ledgers
            </Link>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Outlet />
      </main>
      <GrafanaFooterLink />
    </div>
  );
}
