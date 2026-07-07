import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, Bot, Building2, Compass, Gauge, Shield } from "lucide-react";
import type { ReactNode } from "react";

import { DocsPage } from "@/components/site/docs-page";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: [
      { title: "Documentation — Gittensory" },
      {
        name: "description",
        content:
          "Start with the quickstart, set up your MCP client, and learn how Gittensory keeps maintainer surfaces quiet.",
      },
      { property: "og:title", content: "Documentation — Gittensory" },
      {
        property: "og:description",
        content:
          "Start with the quickstart, set up your MCP client, and learn how Gittensory keeps maintainer surfaces quiet.",
      },
      { property: "og:url", content: "/docs" },
    ],
    links: [{ rel: "canonical", href: "/docs" }],
  }),
  component: DocsIndex,
});

function DocsIndex() {
  return (
    <DocsPage
      eyebrow="Documentation"
      title="Pick your path."
      description="Docs are grouped by who you are. Start with beta onboarding for a role-first path, then dip into core concepts when you need depth."
    >
      <div className="not-prose grid gap-4 sm:grid-cols-2">
        {AUDIENCES.map((a) => (
          <AudienceCard key={a.title} {...a} />
        ))}
      </div>
    </DocsPage>
  );
}

interface Audience {
  icon: ReactNode;
  title: string;
  description: string;
  primary: { to: string; label: string };
  links: Array<{ to: string; label: string }>;
}

const AUDIENCES: Audience[] = [
  {
    icon: <Compass className="size-4" />,
    title: "Miners",
    description: "Plan better work, preflight branches, prepare PR packets.",
    primary: { to: "/docs/beta-onboarding", label: "Beta onboarding" },
    links: [
      { to: "/docs/quickstart", label: "Quickstart" },
      { to: "/docs/miner-quickstart", label: "Quickstart by lane" },
      { to: "/docs/miner-workflow", label: "Miner workflow" },
      { to: "/docs/branch-analysis", label: "Branch analysis" },
      { to: "/docs/scoreability", label: "Scoreability" },
    ],
  },
  {
    icon: <Shield className="size-4" />,
    title: "Maintainers",
    description: "Install, tune, or self-host the review system for your repos.",
    primary: { to: "/docs/beta-onboarding", label: "Beta onboarding" },
    links: [
      { to: "/docs/maintainer-self-hosting", label: "Self-host reviews" },
      { to: "/docs/self-hosting-docs-audit", label: "Self-host docs audit" },
      { to: "/docs/maintainer-install-trust", label: "Install & trust guide" },
      { to: "/docs/github-app", label: "GitHub App configuration" },
      { to: "/docs/maintainer-workflow", label: "Maintainer workflow" },
      { to: "/docs/gittensory-commands", label: "@gittensory commands" },
      { to: "/docs/self-hosting-rees-analyzers", label: "REES analyzers" },
      { to: "/docs/upstream-drift", label: "Upstream drift" },
      { to: "/docs/ai-summaries", label: "AI summaries policy" },
    ],
  },
  {
    icon: <Building2 className="size-4" />,
    title: "Repo owners",
    description: "Registration readiness, label policy, repo settings preview.",
    primary: { to: "/docs/beta-onboarding", label: "Beta onboarding" },
    links: [
      { to: "/docs/owner-checklist", label: "Onboarding checklist" },
      { to: "/app/owner", label: "Owner console" },
      { to: "/docs/privacy-security", label: "Privacy & security" },
      { to: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    icon: <Gauge className="size-4" />,
    title: "Operators",
    description: "Usage rollups, weekly value report, upstream drift across deployments.",
    primary: { to: "/docs/beta-onboarding", label: "Beta onboarding" },
    links: [
      { to: "/app/operator", label: "Operator dashboard" },
      { to: "/docs/upstream-drift", label: "Upstream drift" },
      { to: "/docs/troubleshooting", label: "Troubleshooting" },
    ],
  },
  {
    icon: <Bot className="size-4" />,
    title: "Agent authors",
    description: "Deterministic MCP tools for Codex, Claude Desktop, Cursor.",
    primary: { to: "/docs/mcp-clients", label: "MCP client setup" },
    links: [
      { to: "/docs/branch-analysis", label: "Branch analysis schema" },
      { to: "/docs/ai-summaries", label: "AI summary boundaries" },
    ],
  },
];

function AudienceCard({ icon, title, description, primary, links }: Audience) {
  return (
    <div className="group flex flex-col rounded-token border border-border bg-transparent p-5 transition-colors hover:border-foreground/30">
      <div className="mb-3 inline-flex size-9 items-center justify-center rounded-token border border-mint/30 bg-mint/10 text-mint">
        {icon}
      </div>
      <h2 className="font-display text-token-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-token-sm text-muted-foreground">{description}</p>
      <Link
        to={primary.to as "/docs"}
        className="mt-4 inline-flex items-center gap-1.5 self-start rounded-token bg-mint px-3 py-1.5 text-token-xs font-medium text-primary-foreground transition-[filter,transform] duration-150 hover:brightness-110 active:scale-[0.98] focus-ring motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        {primary.label}
        <ArrowRight className="size-3.5" />
      </Link>
      <ul className="mt-4 space-y-1.5 border-t border-border pt-3 text-token-sm">
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to as "/docs"}
              className="inline-flex items-center gap-1.5 text-foreground/80 transition-colors hover:text-mint"
            >
              <ArrowRight className="size-3 opacity-60" />
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
