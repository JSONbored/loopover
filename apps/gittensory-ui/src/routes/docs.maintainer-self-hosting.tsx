import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/maintainer-self-hosting")({
  head: () => ({
    meta: [
      { title: "Self-hosted reviews — Gittensory docs" },
      {
        name: "description",
        content:
          "A maintainer guide to self-hosting the Gittensory review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
      },
      { property: "og:title", content: "Self-hosted reviews — Gittensory docs" },
      {
        property: "og:description",
        content:
          "A maintainer guide to self-hosting the Gittensory review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
      },
      { property: "og:url", content: "/docs/maintainer-self-hosting" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-self-hosting" }],
  }),
  component: MaintainerSelfHosting,
});

const SECTION_LINKS = [
  {
    title: "Quickstart",
    description:
      "Bring up the container, smoke-test readiness, and confirm the GitHub webhook path.",
    to: "/docs/self-hosting-quickstart",
  },
  {
    title: "Configuration",
    description:
      "Understand env vars, private repo config, feature flags, and safe baseline defaults.",
    to: "/docs/self-hosting-configuration",
  },
  {
    title: "GitHub App and Orb",
    description:
      "Choose a direct GitHub App or brokered Orb enrollment and set the right permissions.",
    to: "/docs/self-hosting-github-app",
  },
  {
    title: "AI providers",
    description: "Wire Anthropic, OpenAI-compatible, Ollama, Claude Code, or Codex safely.",
    to: "/docs/self-hosting-ai-providers",
  },
  {
    title: "REES enrichment",
    description:
      "Run external analyzers, configure REES_ANALYZERS, and understand where results show up.",
    to: "/docs/self-hosting-rees",
  },
  {
    title: "REES analyzer reference",
    description:
      "Review every analyzer name, input, finding shape, network call, and token requirement.",
    to: "/docs/self-hosting-rees-analyzers",
  },
  {
    title: "RAG indexing",
    description: "Configure embeddings, Qdrant, indexing jobs, and cold-index behavior.",
    to: "/docs/self-hosting-rag",
  },
  {
    title: "Operations",
    description:
      "Health checks, logs, metrics, dashboards, jobs, queues, and daily operator routines.",
    to: "/docs/self-hosting-operations",
  },
  {
    title: "Backup and scaling",
    description: "SQLite, Litestream, Postgres, Redis, restores, and multi-instance tradeoffs.",
    to: "/docs/self-hosting-backup-scaling",
  },
  {
    title: "Releases and images",
    description: "Official images, tags, source maps, upgrade cadence, and local custom builds.",
    to: "/docs/self-hosting-releases",
  },
  {
    title: "Beta release checklist",
    description:
      "The smoke matrix to run against a candidate image before tagging an orb-vX.Y.Z release.",
    to: "/docs/self-hosting-release-checklist",
  },
  {
    title: "Security",
    description:
      "Secret handling, private policy, public output boundaries, network exposure, and auth.",
    to: "/docs/self-hosting-security",
  },
  {
    title: "Troubleshooting",
    description:
      "Review not firing, REES silent, AI unavailable, RAG empty, queue stuck, and webhook failures.",
    to: "/docs/self-hosting-troubleshooting",
  },
] as const;

function MaintainerSelfHosting() {
  return (
    <DocsPage
      eyebrow="Maintainers"
      title="Self-hosted reviews"
      description="Run the Gittensory review service on your own infrastructure, with your own data store, GitHub App, AI provider, enrichment service, observability, and private repo policy."
    >
      <Callout variant="safety" title="Self-hosting is a maintainer surface">
        Treat the self-host stack like production infrastructure. Keep secrets out of images and
        public repos, start in advisory or dry-run mode, and only enable write autonomy after you
        have watched real reviews, logs, metrics, and failure paths.
      </Callout>

      <h2>What this section covers</h2>
      <p>
        Self-hosting is a major product path, not a single install command. The service can run as a
        quiet advisory reviewer, a private maintainer copilot, or a full review operator. The docs
        are split by operating concern so you can onboard gradually.
      </p>
      <FeatureRow
        items={[
          {
            title: "Core service",
            description:
              "The same review engine as the hosted Worker, served from a Node container with self-host adapters for data, queue, cron, metrics, and webhooks.",
          },
          {
            title: "Private policy",
            description:
              "A mounted GITTENSORY_REPO_CONFIG_DIR lets maintainers keep review thresholds, autonomy, and notes out of public repos.",
          },
          {
            title: "Optional intelligence",
            description:
              "AI, RAG, and REES are additive. Each has its own enablement switch, prerequisites, and fail-safe behavior.",
          },
          {
            title: "Operator control",
            description:
              "Dry-run, advisory, and live modes let you phase in behavior without exposing contributors to unfinished automation.",
          },
        ]}
      />

      <h2>Recommended reading order</h2>
      <ol>
        <li>
          Start with <Link to="/docs/self-hosting-quickstart">Quickstart</Link> to get a local
          instance healthy.
        </li>
        <li>
          Read <Link to="/docs/self-hosting-configuration">Configuration</Link> before enabling repo
          review features.
        </li>
        <li>
          Set up <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link> so webhooks and
          installation tokens are correct.
        </li>
        <li>
          Add <Link to="/docs/self-hosting-ai-providers">AI providers</Link>,{" "}
          <Link to="/docs/self-hosting-rees">REES enrichment</Link>, the{" "}
          <Link to="/docs/self-hosting-rees-analyzers">REES analyzer reference</Link>, and{" "}
          <Link to="/docs/self-hosting-rag">RAG indexing</Link> only after the deterministic path is
          stable.
        </li>
        <li>
          Use <Link to="/docs/self-hosting-operations">Operations</Link>,{" "}
          <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link>, and{" "}
          <Link to="/docs/self-hosting-security">Security</Link> before exposing the service to
          production traffic.
        </li>
        <li>
          Run the <Link to="/docs/self-hosting-release-checklist">beta release checklist</Link>{" "}
          before tagging or promoting a candidate image.
        </li>
      </ol>

      <h2>Pages</h2>
      <div className="not-prose grid gap-3 sm:grid-cols-2">
        {SECTION_LINKS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="rounded-token border border-border p-4 transition-colors hover:border-foreground/30 focus-ring"
          >
            <div className="text-token-sm font-medium text-foreground">{item.title}</div>
            <p className="mt-1 text-token-xs leading-token-relaxed text-muted-foreground">
              {item.description}
            </p>
          </Link>
        ))}
      </div>

      <h2>How self-hosting fits with hosted docs</h2>
      <p>
        The hosted maintainer workflow still applies: review modes, gate settings, safety rules, and
        privacy boundaries are the same concepts. Self-hosting adds infrastructure choices,
        deployment secrets, private config, and local operating responsibility. Use{" "}
        <Link to="/docs/tuning">Tuning your reviews</Link> for gate semantics and this section for
        running the service yourself.
      </p>
    </DocsPage>
  );
}
