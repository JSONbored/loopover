import { Link, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

type DocsItem = { to: string; label: string };
type DocsGroup = { title: string; items: DocsItem[] };

export const docsNav: DocsGroup[] = [
  {
    title: "Get started",
    items: [
      { to: "/docs", label: "Overview" },
      { to: "/docs/beta-onboarding", label: "Beta onboarding" },
      { to: "/docs/quickstart", label: "Quickstart" },
      { to: "/docs/mcp-clients", label: "MCP client setup" },
    ],
  },
  {
    title: "Workflows",
    items: [{ to: "/docs/miner-workflow", label: "Miner workflow" }],
  },
  {
    title: "Maintainers",
    items: [
      { to: "/docs/maintainer-workflow", label: "Maintainer workflow" },
      { to: "/docs/github-app", label: "GitHub App" },
      { to: "/docs/maintainer-install-trust", label: "Maintainer install & trust" },
    ],
  },
  {
    title: "Self-hosting",
    items: [
      { to: "/docs/maintainer-self-hosting", label: "Overview" },
      { to: "/docs/self-hosting-quickstart", label: "Quickstart" },
      { to: "/docs/self-hosting-configuration", label: "Configuration" },
      { to: "/docs/self-hosting-github-app", label: "GitHub App & Orb" },
      { to: "/docs/self-hosting-ai-providers", label: "AI providers" },
      { to: "/docs/self-hosting-rees", label: "REES enrichment" },
      { to: "/docs/self-hosting-rees-analyzers", label: "REES analyzers" },
      { to: "/docs/self-hosting-rag", label: "RAG indexing" },
      { to: "/docs/self-hosting-operations", label: "Operations" },
      { to: "/docs/self-hosting-backup-scaling", label: "Backup & scaling" },
      { to: "/docs/self-hosting-releases", label: "Releases & images" },
      { to: "/docs/self-hosting-security", label: "Security" },
      { to: "/docs/self-hosting-troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    title: "Core concepts",
    items: [
      { to: "/docs/how-reviews-work", label: "How reviews work" },
      { to: "/docs/branch-analysis", label: "Branch analysis" },
      { to: "/docs/scoreability", label: "Scoreability" },
      { to: "/docs/upstream-drift", label: "Upstream drift" },
    ],
  },
  {
    title: "Operating",
    items: [
      { to: "/docs/tuning", label: "Tuning your reviews" },
      { to: "/docs/privacy-security", label: "Privacy & security" },
      { to: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
];

export function DocsNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="space-y-7 text-token-sm">
      {docsNav.map((group) => (
        <div key={group.title}>
          <div className="mb-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            {group.title}
          </div>
          <ul className="space-y-0.5">
            {group.items.map((it) => {
              const active = pathname === it.to;
              return (
                <li key={it.to}>
                  <Link
                    to={it.to as "/docs"}
                    className={cn(
                      "relative block rounded-token px-3 py-1.5 text-token-sm transition-colors",
                      active
                        ? "bg-mint/10 text-mint"
                        : "text-foreground/75 hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-4 w-px -translate-y-1/2 bg-mint" />
                    )}
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function DocsPrevNext() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const flat = docsNav.flatMap((g) => g.items);
  const idx = flat.findIndex((i) => i.to === pathname);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;
  if (!prev && !next) return null;
  return (
    <div className="mt-16 grid gap-3 border-t border-border pt-8 sm:grid-cols-2">
      {prev ? (
        <Link
          to={prev.to as "/docs"}
          className="group flex flex-col rounded-token border border-border bg-transparent p-4 transition-colors hover:border-foreground/30"
        >
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            ← Previous
          </span>
          <span className="mt-1 font-medium text-foreground group-hover:text-mint">
            {prev.label}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          to={next.to as "/docs"}
          className="group flex flex-col items-end rounded-token border border-border bg-transparent p-4 text-right transition-colors hover:border-foreground/30"
        >
          <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Next →
          </span>
          <span className="mt-1 font-medium text-foreground group-hover:text-mint">
            {next.label}
          </span>
        </Link>
      )}
    </div>
  );
}
