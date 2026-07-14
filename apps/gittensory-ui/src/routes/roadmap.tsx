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
        content: "Upcoming control-plane surfaces for Gittensor OSS contribution mining.",
      },
      { property: "og:url", content: "/roadmap" },
    ],
    links: [{ rel: "canonical", href: "/roadmap" }],
  }),
  component: RoadmapPage,
});

const COLUMNS = [
  { key: "shipping-soon", title: "Now", hint: "Phase 0/1: stabilize and ship the miner loop." },
  { key: "planned", title: "Next", hint: "Phase 2/3: maintainer trust and repo-owner intake." },
  { key: "exploring", title: "Later", hint: "Phase 4/5: analytics, launch system, distribution." },
] as const;

const LAST_UPDATED = "2026-06-01";
const LAST_UPDATED_LABEL = "June 1, 2026";

const ROADMAP_ITEMS: Array<{
  title: string;
  status: (typeof COLUMNS)[number]["key"];
  description: string;
  issue: number;
}> = [
  {
    title: "Phase 0: stabilize while shipping",
    status: "shipping-soon",
    issue: 233,
    description:
      "Current-version MCP display, stale PR queue triage, install/docs cleanup, and high-confidence polish before broader launch work.",
  },
  {
    title: "Phase 1: miner command center",
    status: "shipping-soon",
    issue: 234,
    description:
      "MCP doctor/status/init-client clarity, last-good decision packs, recommendation-change explanations, and command-copy flows for miners.",
  },
  {
    title: "Phase 2: maintainer trust and browser extension",
    status: "planned",
    issue: 235,
    description:
      "Maintainer trust checklist, install health next actions, screenshot-backed extension states, and private/public rendering checks.",
  },
  {
    title: "Phase 3: repo owner intake console",
    status: "planned",
    issue: 236,
    description:
      "Guided registration readiness, config recommendations, repo onboarding packs, and source-quality next actions.",
  },
  {
    title: "Phase 4: adoption analytics and launch system",
    status: "exploring",
    issue: 237,
    description:
      "Privacy-safe product events, role activation/retention metrics, weekly value reports, and operator export paths.",
  },
  {
    title: "Phase 5: ecosystem distribution",
    status: "exploring",
    issue: 238,
    description:
      "PWA/digest delivery, documentation distribution, launch loops, and ecosystem packaging once the core surfaces are durable.",
  },
];

// Titles with live or self-hosted surfaces in the imported frontend.
const BUILT_TITLES = new Set<string>([
  "Phase 0: stabilize while shipping",
  "Phase 1: miner command center",
  "Phase 2: maintainer trust and browser extension",
  "Phase 3: repo owner intake console",
  "Phase 4: adoption analytics and launch system",
  "Phase 5: ecosystem distribution",
]);

const LINK_MAP: Record<string, { to: string; label: string }> = {
  "Phase 1: miner command center": { to: "/app/miner", label: "Open miner dashboard" },
  "Phase 2: maintainer trust and browser extension": {
    to: "/extension",
    label: "Open extension page",
  },
  "Phase 3: repo owner intake console": { to: "/app/repos", label: "Open repos console" },
  "Phase 4: adoption analytics and launch system": {
    to: "/app/analytics",
    label: "Open analytics",
  },
  "Phase 5: ecosystem distribution": { to: "/app/digest", label: "Preview the digest" },
};

function RoadmapPage() {
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
          This reflects the live roadmap issue #127 and phase epics #233-#238. Project-board linkage
          waits until the GitHub project scope is available.
        </p>
        <a
          href="https://github.com/JSONbored/gittensory/issues/127"
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex rounded-token border-hairline px-2.5 py-1 font-mono text-token-2xs text-muted-foreground transition-colors duration-150 hover:border-strong hover:text-mint focus-ring"
        >
          Roadmap #127 →
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
                      href={`https://github.com/JSONbored/gittensory/issues/${item.issue}`}
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
