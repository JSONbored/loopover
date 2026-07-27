import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Section, Eyebrow, Callout } from "@/components/site/primitives";
import { Reveal } from "@/components/site/reveal";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/roadmap")({
  head: () => ({
    meta: [
      { title: "Roadmap — LoopOver" },
      {
        name: "description",
        content: "What LoopOver is shipping next, and what we're still exploring.",
      },
      { property: "og:title", content: "LoopOver roadmap" },
      {
        property: "og:description",
        content:
          "What LoopOver is shipping next across the review agent, contributor stack, and hosted plane.",
      },
      { property: "og:url", content: "/roadmap" },
    ],
    links: [{ rel: "canonical", href: "/roadmap" }],
  }),
  component: RoadmapPage,
});

const COLUMNS = [
  {
    key: "shipping-soon",
    title: "Now",
    hint: "Hosted-platform foundations already underway.",
  },
  {
    key: "planned",
    title: "Next",
    hint: "Chat-first, hosted dashboards for maintainers and miners.",
  },
  {
    key: "exploring",
    title: "Later",
    hint: "Deeper execution infrastructure and observability consolidation.",
  },
] as const;

const LAST_UPDATED = "2026-07-27";
const LAST_UPDATED_LABEL = "July 27, 2026";

const ROADMAP_ITEMS: Array<{
  title: string;
  status: (typeof COLUMNS)[number]["key"];
  description: string;
  issue: number;
}> = [
  {
    title: "Rent-a-Loop: hosted development loops",
    status: "shipping-soon",
    issue: 4778,
    description:
      "Rent autonomous development-loop time against your own repository — a hosted product, settled on-chain via Bittensor or by conventional billing, built on the same review-gate authority model that already runs self-hosted.",
  },
  {
    title: "ORB cloud readiness",
    status: "shipping-soon",
    issue: 4877,
    description:
      "Multi-tenant infrastructure, fleet operations, billing, and incident-response readiness for a centrally hosted edition of the review gate. Self-hosting remains fully supported alongside it.",
  },
  {
    title: "Hosted AMS chat platform",
    status: "planned",
    issue: 9184,
    description:
      "Sign up, connect GitHub, and converse with your own autonomous miner through a hosted, chat-first dashboard — no local install or gittensor registration required to get started.",
  },
  {
    title: "ORB maintainer chat platform",
    status: "planned",
    issue: 9183,
    description:
      "A conversational, chat-first command center letting maintainers and repo owners drive the review agent through conversation — grounded read-only over maintainer data, with every action routed through the existing write-safety controls.",
  },
  {
    title: "Hosted bare-metal execution plane",
    status: "exploring",
    issue: 8534,
    description:
      "Dedicated, hardware-attested execution hosting, extending our reproducible-backtest trust guarantees to hosted reviews of private, non-public repositories.",
  },
  {
    title: "PostHog observability consolidation",
    status: "exploring",
    issue: 8286,
    description:
      "Consolidating error tracking, product analytics, and observability onto a single platform for clearer diagnostics and faster incident response across our hosted services.",
  },
];

// Titles with live or self-hosted surfaces in the imported frontend.
const BUILT_TITLES = new Set<string>([]);

const LINK_MAP: Record<string, { to: string; label: string }> = {};

export function RoadmapPage() {
  const grouped = COLUMNS.map((c) => ({
    ...c,
    items: ROADMAP_ITEMS.filter((r) => r.status === c.key),
  }));

  return (
    <Section className="py-16">
      <Reveal className="max-w-3xl">
        <Eyebrow>Roadmap</Eyebrow>
        <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
          What&apos;s next for LoopOver
        </h1>
        <p className="mt-3 text-muted-foreground">
          Each item below links to a real, open epic on GitHub — no invented phases. Project-board
          linkage waits until the GitHub project scope is available.
        </p>
        <p className="mt-2 text-muted-foreground">
          Recently shipped: the certified close guarantee, full decision replay,
          salvageability-aware closes, and opt-in federated fleet intelligence — all live in
          production today.
        </p>
        <a
          href="https://github.com/JSONbored/loopover/milestones"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex rounded-token border-hairline px-2.5 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:border-strong hover:text-mint focus-ring"
        >
          See all milestones →
        </a>
        <div className="mt-4 inline-flex items-center gap-2 font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          <span className="size-1.5 rounded-full bg-mint" aria-hidden />
          Last updated <time dateTime={LAST_UPDATED}>{LAST_UPDATED_LABEL}</time>
        </div>
      </Reveal>

      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {grouped.map((col) => (
          <div key={col.key} className="flex flex-col rounded-token border-hairline bg-card/30">
            <div className="flex items-center justify-between border-b-hairline px-4 py-3">
              <div>
                <div className="font-display text-token-md font-semibold text-foreground">
                  {col.title}
                </div>
                <div className="mt-0.5 text-token-2xs text-muted-foreground">{col.hint}</div>
              </div>
              <span className="font-mono text-token-2xs text-muted-foreground">
                {col.items.length}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-3 p-3">
              {col.items.length === 0 && (
                <div className="rounded-token border-hairline bg-background/50 p-4 text-center text-token-xs text-muted-foreground">
                  Nothing here yet.
                </div>
              )}
              {col.items.map((item) => {
                const link = LINK_MAP[item.title];
                const built = BUILT_TITLES.has(item.title);
                return (
                  <div
                    key={item.title}
                    className={cn(
                      "group rounded-token border-hairline bg-background p-4 transition-all duration-150 hover:border-strong",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-display text-token-sm font-semibold text-foreground">
                        {item.title}
                      </h3>
                      {built && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-mint/40 bg-mint/10 px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
                          <span className="size-1 rounded-full bg-mint" aria-hidden />
                          Tracked
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-token-xs text-muted-foreground">{item.description}</p>
                    <a
                      href={`https://github.com/JSONbored/loopover/issues/${item.issue}`}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-3 inline-flex items-center gap-1 rounded-token text-token-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-mint hover:underline focus-ring"
                    >
                      Issue #{item.issue} <ArrowRight className="size-3" aria-hidden />
                    </a>
                    {link && (
                      <Link
                        to={link.to}
                        className="mt-3 inline-flex items-center gap-1 rounded-token text-token-xs font-medium text-mint transition-colors duration-150 hover:underline focus-ring"
                      >
                        {link.label} <ArrowRight className="size-3" aria-hidden />
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 max-w-2xl">
        <Callout variant="safety">
          <strong>What we will never ship.</strong> Autonomous code edits / PR opens / merges,
          wallet or hotkey display, raw trust scores, public score estimates, payout guarantees, or
          any private reviewability/scoreability data leaking into public GitHub surfaces.
        </Callout>
      </div>
    </Section>
  );
}
