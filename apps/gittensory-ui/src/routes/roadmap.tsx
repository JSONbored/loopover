import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Section, Eyebrow, Callout } from "@/components/site/primitives";
import { Reveal } from "@/components/site/reveal";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/roadmap")({
  head: () => ({
    meta: [
      { title: "Roadmap — Gittensory" },
      {
        name: "description",
        content: "What Gittensory is shipping next, and what we're still exploring.",
      },
      { property: "og:title", content: "Gittensory roadmap" },
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
  { key: "shipping-soon", title: "Now", hint: "Shipping in the current cycle." },
  { key: "planned", title: "Next", hint: "Designed, queued for the next cycle." },
  { key: "exploring", title: "Later", hint: "Open questions, no commit date." },
] as const;

const LAST_UPDATED = "2026-05-30";
const LAST_UPDATED_LABEL = "May 30, 2026";

const ROADMAP_ITEMS: Array<{
  title: string;
  status: (typeof COLUMNS)[number]["key"];
  description: string;
}> = [
  {
    title: "@gittensory GitHub command agent",
    status: "shipping-soon",
    description: "Quiet, opt-in @-commands maintainers can use inside PR threads.",
  },
  {
    title: "Product usage analytics",
    status: "shipping-soon",
    description: "Weekly value report and operator dashboard.",
  },
  {
    title: "Browser extension PR overlays",
    status: "planned",
    description: "Private maintainer overlays on github.com, never shown to PR authors.",
  },
  {
    title: "PWA maintainer digest",
    status: "planned",
    description: "Mobile-friendly daily digest of reviewability and install health.",
  },
  {
    title: "Optional AI summaries",
    status: "exploring",
    description: "Strictly over deterministic signals; never replaces evidence.",
  },
];

// Titles with live or self-hosted surfaces in the imported frontend.
const BUILT_TITLES = new Set<string>([
  "@gittensory GitHub command agent",
  "Product usage analytics",
  "Browser extension PR overlays",
  "PWA maintainer digest",
  "Optional AI summaries",
]);

const LINK_MAP: Record<string, { to: string; label: string }> = {
  "@gittensory GitHub command agent": { to: "/app/commands", label: "Open command simulator" },
  "Product usage analytics": { to: "/app/analytics", label: "Open analytics" },
  "Browser extension PR overlays": { to: "/extension", label: "Open extension page" },
  "PWA maintainer digest": { to: "/app/digest", label: "Preview the digest" },
  "Optional AI summaries": { to: "/docs/ai-summaries", label: "Read the policy" },
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
          What&apos;s next for Gittensory
        </h1>
        <p className="mt-3 text-muted-foreground">
          Each surface below maps to either live API-backed app wiring, a self-hosted package, or a
          clearly scoped future lane.
        </p>
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
                          Preview
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-token-xs text-muted-foreground">{item.description}</p>
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
