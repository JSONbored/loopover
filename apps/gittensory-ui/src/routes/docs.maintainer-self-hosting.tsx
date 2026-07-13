import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/maintainer-self-hosting")({
  head: () => ({
    meta: [
      { title: "Self-hosted reviews — LoopOver docs" },
      {
        name: "description",
        content:
          "A maintainer guide to self-hosting the LoopOver review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
      },
      { property: "og:title", content: "Self-hosted reviews — LoopOver docs" },
      {
        property: "og:description",
        content:
          "A maintainer guide to self-hosting the LoopOver review service, with dedicated pages for setup, configuration, AI, REES, RAG, operations, releases, security, and troubleshooting.",
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
      "Health checks, logs, metrics, safe update/rollback checklists, deploy scripts, and daily operator routines.",
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
    title: "Release checklist",
    description:
      "Versioning, the smoke matrix, an image-contents audit, and release notes for an orb-vX.Y.Z release.",
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
  {
    title: "Docs accuracy audit",
    description:
      "Checklist mapping website docs to docker-compose, env, release, observability, and backup sources of truth.",
    to: "/docs/self-hosting-docs-audit",
  },
] as const;

function MaintainerSelfHosting() {
  return (
    <DocsPage
      eyebrow="Maintainers"
      title="Self-hosted reviews"
      description="Run the LoopOver review service on your own infrastructure, with your own data store, GitHub App, AI provider, enrichment service, observability, and private repo policy."
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
          Run the <Link to="/docs/self-hosting-release-checklist">release checklist</Link> before
          tagging or promoting a candidate image.
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

      <h2>Onboarding simplification proposal (#1574)</h2>
      <p>
        This section records today&apos;s accurate setup path and the gaps worth closing next — the
        issue deliverable for making self-host onboarding as fast as CodeRabbit while keeping robust
        per-repo policy in container-private config.
      </p>

      <h3>Today&apos;s recommended path (verified)</h3>
      <ol>
        <li>
          <code>cp .env.selfhost.example .env</code> — conservative defaults (<code>dry-run</code>,
          small <code>GITTENSORY_REVIEW_REPOS</code>).
        </li>
        <li>
          Pull or build the image (<code>INSTALL_AI_CLIS=true</code> by default;{" "}
          <code>--build-arg INSTALL_AI_CLIS=false</code> for deterministic-only).
        </li>
        <li>
          One-click GitHub App via <code>/setup</code> + <code>SELFHOST_SETUP_TOKEN</code> (
          <code>Checks: write</code> included — re-approve on existing Apps after permission bumps).
        </li>
        <li>
          Mount <code>./gittensory-config</code> and copy{" "}
          <code>config/examples/global.gittensory.yml</code> →{" "}
          <code>gittensory-config/.loopover.yml</code> (the legacy{" "}
          <code>gittensory-config/.gittensory.yml</code> name still works too, #4773) for a
          centralized private default (per-repo files deep-merge on top).
        </li>
        <li>
          Add each pilot repo to <code>GITTENSORY_REVIEW_REPOS</code>, watch a PR in{" "}
          <code>dry-run</code>, then enable advisory gate mode from the control panel or{" "}
          <code>POST /v1/repos/:owner/:repo/activation</code>.
        </li>
        <li>
          Go live by unsetting <code>SELFHOST_DEPLOYMENT_MODE</code>; tune autonomy in private
          config when ready.
        </li>
      </ol>

      <h3>Gaps and proposed improvements</h3>
      <FeatureRow
        items={[
          {
            title: "Single-command repo onboarding",
            description:
              "Today: edit .env allowlist, copy YAML templates, sign into the panel, click activate. Proposed: one CLI/API command that adds owner/repo to GITTENSORY_REVIEW_REPOS, seeds gittensory-config/owner__repo/.loopover.yml (or legacy .gittensory.yml, #4773) from global.gittensory.yml, and POSTs activation — idempotent, dry-run aware.",
          },
          {
            title: "Centralized private default only",
            description:
              "Most fleets need one gittensory-config/.loopover.yml (legacy .gittensory.yml also still supported, #4773) with optional per-repo overrides — docs now treat that as the default story instead of implying every repo needs its own file.",
          },
          {
            title: "Advisory-by-default on first install",
            description:
              "The activation endpoint already applies CodeRabbit-style advisory ramp (gate on, deterministic rules advisory, AI off). Proposed: auto-call it on first webhook for a newly installed repo when a SELFHOST_AUTO_ACTIVATE_REPOS flag lists the repo — still overrideable via private config.",
          },
          {
            title: "Clearer activation vocabulary",
            description:
              "Docs now separate GITTENSORY_REVIEW_REPOS (feature allowlist), gate activation (check + rules), and is_registered (Gittensor registry). Proposed: surface all three in the control-panel repo workspace with plain labels instead of making operators infer from logs.",
          },
        ]}
      />
      <Callout variant="note">
        None of the proposals above require code changes to adopt today&apos;s path — they describe
        UX we can add without weakening the private-config model or env-level kill switches.
      </Callout>

      <h2>How self-hosting fits with hosted docs</h2>
      <p>
        The hosted maintainer workflow still applies: review modes, gate settings, safety rules, and
        privacy boundaries are the same concepts. Self-hosting adds infrastructure choices,
        deployment secrets, private config, and local operating responsibility. Use{" "}
        <Link to="/docs/tuning">Tuning your reviews</Link> for gate semantics and this section for
        running the service yourself.
      </p>

      <h2>Moving a repo between hosted and self-host</h2>
      <Callout variant="note" title="Hosted is currently paused">
        &quot;Hosted&quot; here means the private managed-beta shared <code>gittensory</code> App
        described in <Link to="/docs/github-app">GitHub App configuration</Link> — it previously
        accepted new installs and is currently paused while self-hosted Orb is the primary way to
        run LoopOver. A new centrally hosted offering is planned for the future. "Switching from
        hosted to self-host" below still applies to any repo already installed on the hosted App;
        "switching back to hosted" isn't possible until hosted installs reopen, but the steps are
        kept here for when they do.
      </Callout>
      <p>
        A repo installed on the hosted App is reviewed by LoopOver&apos;s own cloud Worker and its
        own database. &quot;Self-host&quot; means your own container from{" "}
        <Link to="/docs/self-hosting-quickstart">Quickstart</Link>, with its own GitHub App (or
        brokered Orb enrollment) and its own data store. There is{" "}
        <strong>no automated migration path between the two</strong> — moving a repo is a manual App
        swap plus re-creating whatever settings you had, not a toggle.
      </p>

      <h3>Switching a repo from hosted to self-host</h3>
      <ol>
        <li>
          Stand up your self-host instance first and confirm <code>/ready</code> is healthy — see{" "}
          <Link to="/docs/self-hosting-quickstart">Quickstart</Link> — before touching the hosted
          install, so the repo is never briefly reviewed by nothing.
        </li>
        <li>
          Create <strong>your own</strong> GitHub App via the self-host{" "}
          <Link to="/docs/self-hosting-github-app">setup wizard</Link> (or brokered Orb enrollment).
          You cannot repoint the existing shared hosted App at your self-host container — the shared
          App&apos;s credentials belong to LoopOver&apos;s cloud Worker, and{" "}
          <code>src/selfhost/setup-wizard.ts</code> always mints a distinct App tied to your
          instance&apos;s own webhook URL.
        </li>
        <li>
          Install your new self-host App on the repo, choosing only that repo (or the org, if you're
          migrating several at once).
        </li>
        <li>
          Uninstall the shared hosted App from that repo (repo Settings → Integrations → GitHub Apps
          → gittensory → Uninstall, or the equivalent org-level App settings page) once you&apos;ve
          confirmed the self-host App is reviewing PRs correctly. Leaving both installed means two
          reviewers post competing checks and comments on the same PRs.
        </li>
      </ol>

      <h3>What does not carry over automatically</h3>
      <p>
        Hosted-side settings live in LoopOver&apos;s own cloud database, keyed by repo full name —{" "}
        <code>resolveRepositorySettings</code> (<code>src/settings/repository-settings.ts</code>)
        reads them from <code>env.DB</code>, which is a completely different database instance than
        your self-host container&apos;s. A self-host instance has no access to, and no import path
        for, whatever thresholds, gate modes, or review-mode settings you configured on the hosted
        side through the control panel or API. If you want the same behavior, you have to
        re-configure it on the new instance from scratch — there is no export/import tool for this
        today.
      </p>
      <p>
        <strong>
          One thing genuinely does carry over: a repo&apos;s own <code>.loopover.yml</code> (or
          legacy <code>.gittensory.yml</code>, #4773)
        </strong>{" "}
        (config-as-code), because it lives in the repository&apos;s git history, not in either
        service&apos;s database. <code>resolveRepositorySettings</code> overlays it on top of
        whatever DB settings exist, on either hosted or self-host — so gate-mode overrides,
        thresholds, and other settings expressed in that file apply identically the moment the new
        App starts reviewing, with nothing to re-enter.
      </p>
      <Callout variant="warn" title="Review history does not move">
        Past review comments, check-run history, and any per-PR state LoopOver recorded while the
        hosted App was active stay wherever they were created — GitHub comments and check runs are
        never deleted or copied by an uninstall/install, but nothing in the self-host database is
        backfilled from the hosted side. A migrated repo starts its self-host review history from
        zero.
      </Callout>
      <p>
        What stays identical for contributors either way: the review still posts as a{" "}
        <code>gittensory[bot]</code>-style comment (under your own App&apos;s slug once you migrate,
        not literally <code>gittensory[bot]</code>) plus the same check-run shape, and the gate
        semantics in <Link to="/docs/tuning">Tuning your reviews</Link> and{" "}
        <Link to="/docs/how-reviews-work">How reviews work</Link> are unchanged — only the
        infrastructure and the settings storage location differ.
      </p>

      <h3>Switching a repo from self-host back to hosted</h3>
      <p>
        Hosted installs are currently paused — this direction isn't possible until the shared App
        reopens (see the callout above). Once it does, the reverse migration has the same shape and
        the same gap: uninstall your self-host App from the repo, install the shared hosted App (see{" "}
        <Link to="/docs/github-app">GitHub App configuration</Link>), and re-create any DB-backed
        settings on the hosted side. <code>.loopover.yml</code> (or legacy{" "}
        <code>.gittensory.yml</code>, #4773) again carries over for free since it travels with the
        repo; nothing else does. Your self-host instance&apos;s data volumes are untouched by this —
        see <Link to="/docs/self-hosting-operations">Uninstalling and decommissioning</Link> if you
        also intend to shut the instance down rather than keep it idle or reuse it for other repos.
      </p>
    </DocsPage>
  );
}
