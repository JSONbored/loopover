import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";
import { SELFHOST_ENV_REFERENCE_MARKDOWN } from "@/lib/selfhost-env-reference";

export const Route = createFileRoute("/docs/self-hosting-configuration")({
  head: () => ({
    meta: [
      { title: "Self-host configuration — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:title", content: "Self-host configuration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:url", content: "/docs/self-hosting-configuration" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-configuration" }],
  }),
  component: SelfHostingConfiguration,
});

function SelfHostingConfiguration() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Configuration"
      description="The self-host configuration model: deployment env, private per-repo policy, feature flags, and review modes."
    >
      <p>
        This page is the exhaustive reference. For the short path — the required secrets plus a
        conservative first-boot config — start with <code>.env.selfhost.example</code> in{" "}
        <Link to="/docs/self-hosting-quickstart">Quickstart</Link> instead.
      </p>

      <h2>Config layers</h2>
      <FeatureRow
        items={[
          {
            title: "Environment",
            description:
              "Deployment-wide infrastructure, secrets, feature kill switches, and service URLs. Requires restart or recreate when changed.",
          },
          {
            title: "Private repo config",
            description:
              "Mounted GITTENSORY_REPO_CONFIG_DIR files for private per-repo policy. Read fresh each review.",
          },
          {
            title: "Public repo config",
            description:
              "The repo .loopover.yml (legacy .gittensory.yml still works, #4773). Useful for transparent policy, but not for thresholds or rules you need to keep private.",
          },
          {
            title: "Built-in defaults",
            description:
              "Safe fallback when nothing is configured. Gate off, AI off, and no repo runs per-PR features until allowlisted.",
          },
        ]}
      />

      <h2>Precedence</h2>
      <p>
        Where policy for a given repo can live is one question; which layer wins when more than one
        is set is another. Most specific wins, in this order:
      </p>
      <ul>
        <li>
          the repo&apos;s <code>.loopover.yml</code> (public repo config, or the mounted private
          per-repo config file below if <code>GITTENSORY_REPO_CONFIG_DIR</code> is set — the legacy{" "}
          <code>.gittensory.yml</code> name still works everywhere, indefinitely, #4773), then
        </li>
        <li>the per-repo database settings (the dashboard), then</li>
        <li>built-in safe defaults.</li>
      </ul>
      <p>
        Within <code>.loopover.yml</code> itself, the typed <code>gate:</code> block is an alias for
        the gate-related fields and wins over the generic <code>settings:</code> block for those
        same fields — so a value written under both <code>gate.duplicates</code> and{" "}
        <code>settings.duplicates</code> resolves to whatever <code>gate.duplicates</code> says. One
        exception to the whole precedence chain: hard path guardrails (
        <code>settings.hardGuardrailGlobs</code>) are config-as-code only — a configured list ADDS
        repo-specific globs on top of a fixed set of built-in invariant guardrails (config-as-code
        files, CI workflows/scripts, and core engine-decision paths) that always apply and can never
        be disabled. Omitted or empty means only those built-in invariants hold, regardless of what
        the database row or defaults would otherwise imply.
      </p>
      <p>
        This page covers the environment layer and the shape of the config file. For the full field
        list — every <code>gate:</code> and <code>settings:</code> key, its default, and what it
        does — see <Link to="/docs/tuning">Tuning your reviews</Link>, and for copy-paste templates
        see the table below (also shipped inside the self-host image at{" "}
        <code>config/examples/</code>).
      </p>

      <h2>Config templates</h2>
      <p>
        Start from a template instead of reverse-engineering env flags, private-config precedence,
        and the parser. Every template uses the same schema for a public repo-root{" "}
        <code>.loopover.yml</code> (or the legacy <code>.gittensory.yml</code>, still fully
        supported, #4773) or a container-private <code>GITTENSORY_REPO_CONFIG_DIR</code> mount —
        only what you put in each file differs.
      </p>
      <FeatureRow
        items={[
          {
            title: "gittensory.minimal.yml",
            description:
              "Smallest safe starter — gate off, observe-only autonomy, no accidental merge/close/label writes. Copy to the repo root or a private mount.",
          },
          {
            title: "gittensory.full.yml",
            description:
              "Exhaustive commented reference — every gate:, settings:, review:, and features: field with defaults and allowed values. Body kept in sync with .gittensory.yml.example.",
          },
          {
            title: "global.gittensory.yml + repo-override.gittensory.yml",
            description:
              "Private self-host only — illustrative fleet global default and per-repo overlay (deep-merge). Never commit real policy into these example paths.",
          },
          {
            title: "shared.gittensory.yml",
            description:
              "Private self-host only — lowest-priority cross-repo house policy for an operator running many repos (#1959). Write a default once instead of copy-pasting it into every repo's file.",
          },
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`# Public repo (contributor-visible)
cp config/examples/gittensory.minimal.yml .loopover.yml
# (an existing .gittensory.yml at repo root also still works -- #4773 -- no need to rename it)

# Self-host private mount (operator-only policy)
mkdir -p gittensory-config
cp config/examples/global.gittensory.yml gittensory-config/.loopover.yml`}
      />
      <Callout variant="note">
        Keep anti-abuse thresholds, maintainer allowlists, and autonomy dials in the{" "}
        <strong>private</strong> mount — not in a public <code>.loopover.yml</code> contributors can
        read. <code>config/examples/TEMPLATES.md</code> documents the public-vs-private split and
        how to apply the templates to <code>gittensory</code>, <code>awesome-claude</code>, and{" "}
        <code>metagraphed</code> without committing private policy. Lint before deploy:{" "}
        <code>npx tsx scripts/gittensory-config-lint.ts path/to/.loopover.yml</code> (or the legacy{" "}
        <code>.gittensory.yml</code>, #4773).
      </Callout>
      <p>Authoritative copies in git:</p>
      <ul>
        <li>
          <a href="https://github.com/JSONbored/gittensory/blob/main/config/examples/gittensory.minimal.yml">
            <code>config/examples/gittensory.minimal.yml</code>
          </a>
        </li>
        <li>
          <a href="https://github.com/JSONbored/gittensory/blob/main/config/examples/gittensory.full.yml">
            <code>config/examples/gittensory.full.yml</code>
          </a>{" "}
          (same body as{" "}
          <a href="https://github.com/JSONbored/gittensory/blob/main/.gittensory.yml.example">
            <code>.gittensory.yml.example</code>
          </a>
          )
        </li>
        <li>
          <a href="https://github.com/JSONbored/gittensory/blob/main/config/examples/TEMPLATES.md">
            <code>config/examples/TEMPLATES.md</code>
          </a>{" "}
          — catalog + fleet usage notes
        </li>
        <li>
          <a href="https://github.com/JSONbored/gittensory/blob/main/config/examples/README.md">
            <code>config/examples/README.md</code>
          </a>{" "}
          — the full private-config layout, precedence chain, and deep-merge semantics, including
          the shared base layer
        </li>
      </ul>
      <p>
        Several gate-only fields are documented only in the full template comments — see below for
        the config-as-code blocks with no dashboard equivalent.
      </p>

      <h2>Required baseline env</h2>
      <CodeBlock
        filename=".env"
        code={`PUBLIC_API_ORIGIN=https://reviews.example.com
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-gittensory-app
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=<random-webhook-secret>

GITTENSOR_REGISTRY_URL=https://example.invalid/registry.json
GITTENSORY_API_TOKEN=<random-32-byte-token>
GITTENSORY_MCP_TOKEN=<random-32-byte-token>
INTERNAL_JOB_TOKEN=<random-32-byte-token>`}
      />
      <p>
        Any <code>FOO_FILE</code> is loaded into <code>FOO</code> at startup. Explicit{" "}
        <code>FOO</code> wins over the file variant.
      </p>
      <p>
        Every command example on these docs pages hardcodes <code>:8787</code> — that&apos;s the
        default, not a fixed port. Set <code>PORT</code> to listen on something else; update your
        compose port mapping and any <code>curl</code>/health-check commands to match.
      </p>
      <Callout variant="warn" title="MCP_ACTUATION_REPO_ALLOWLIST">
        <code>GITTENSORY_MCP_TOKEN</code> is a shared, end-user-obtainable CLI credential (the
        normal alternative to <code>gittensory-mcp login</code>), so it must not implicitly stage
        actions (merges, closes, approvals) on every repo the App happens to be installed on.{" "}
        <code>MCP_ACTUATION_REPO_ALLOWLIST</code> scopes it to an explicit,
        comma/whitespace-separated <code>owner/repo</code> list —{" "}
        <strong>unset denies all actuation</strong> for this token. Set it to <code>*</code> or{" "}
        <code>all</code> to opt back into the pre-scoping, any-repo behavior. If you already rely on{" "}
        <code>GITTENSORY_MCP_TOKEN</code> for approval-queue actuation, set this variable after
        upgrading or MCP actuation stops working.
      </Callout>
      <CodeBlock
        filename=".env"
        code={`# Deny-by-default: unset means the static MCP token cannot stage or decide any action.
MCP_ACTUATION_REPO_ALLOWLIST=owner/repo-one, owner/repo-two
# Restore pre-upgrade any-repo behavior:
# MCP_ACTUATION_REPO_ALLOWLIST=*`}
      />
      <p>
        <code>MCP_READ_REPO_ALLOWLIST</code> is the same fail-closed/wildcard model, kept as a{" "}
        <strong>separate</strong> allowlist so read-only MCP tools (repo context, issue quality,
        watch subscriptions) can be granted independently of actuation trust. The full{" "}
        <code>*</code>/<code>all</code> wildcard additionally unlocks the non-repo-scoped
        contributor/operator tools.
      </p>

      <h2>Data paths</h2>
      <ul>
        <li>
          <code>MIGRATIONS_DIR</code> (default <code>migrations</code>) — where the self-host
          runtime looks for SQL migration files to auto-apply at boot. Only relevant for a custom
          build that ships migrations somewhere other than the default in-image location.
        </li>
        <li>
          <code>REVIEW_AUDIT_DIR</code> — when set, persists visual-review screenshot PNGs to this
          filesystem path so they're served from cache instead of re-rendered on every request.
          Unset means each screenshot is re-rendered on demand. Only relevant when{" "}
          <code>BROWSER_WS_ENDPOINT</code> (see{" "}
          <Link to="/docs/self-hosting-rees">REES enrichment</Link>) is also set — visual review is
          fully inert without it.
        </li>
        <li>
          <code>REVIEW_AUDIT_S3_BUCKET</code> / <code>_ENDPOINT</code> / <code>_ACCESS_KEY_ID</code>{" "}
          / <code>_SECRET_ACCESS_KEY</code> — an alternative to <code>REVIEW_AUDIT_DIR</code>:
          persist screenshots in an S3-compatible bucket (your own Cloudflare R2 bucket, or any
          other S3-compatible provider) instead of the local filesystem, and set{" "}
          <code>REVIEW_AUDIT_S3_PUBLIC_URL</code> to that bucket&rsquo;s own public base URL so
          screenshots link directly at the bucket instead of proxying through this instance. This
          matters if your instance sits behind a private network (a VPN, a firewall, no public DNS)
          — without a public bucket, screenshots embedded in a public PR comment are unreachable by
          GitHub and by anyone viewing the PR who isn&rsquo;t on that same private network. Takes
          priority over <code>REVIEW_AUDIT_DIR</code> when both are set.
        </li>
        <li>
          <code>CODEX_HOME</code> — do not set this for the app container. The Codex provider
          rejects a container-set <code>CODEX_HOME</code> outright (fails closed with{" "}
          <code>codex_credential_isolation_required</code>) because <code>codex exec</code> reads
          attacker-controlled PR title/body/diff text, and a mounted OAuth home on the same
          filesystem could otherwise leak into review output via prompt injection. This is why the
          Codex subscription path additionally requires the explicit{" "}
          <code>GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1</code> opt-in — see{" "}
          <Link to="/docs/self-hosting-ai-providers">AI providers</Link>.
        </li>
      </ul>

      <h2>GitHub API cache</h2>
      <p>
        Redis backs shared caching for stable GitHub GET responses, including repeated installation,
        repo/user metadata, and branch-protection required-status reads. Keys include the caller
        identity and response-shaping headers, and cold misses are single-flighted so concurrent
        jobs do not stampede GitHub.
      </p>
      <CodeBlock
        filename=".env"
        code={`GITHUB_CACHE_TTL_SECONDS=20
GITHUB_BRANCH_PROTECTION_CACHE_TTL_SECONDS=1200
GITHUB_METADATA_CACHE_TTL_SECONDS=600`}
      />
      <Callout variant="note">
        <code>GITHUB_CACHE_TTL_SECONDS</code> is the short default for repeated safe GitHub GETs.
        Stable repo/user metadata and branch-protection required-status reads use the per-class TTLs
        above so operators can keep repeated policy reads hot without broadening stale cache risk.
        Live CI status, check-run, check-suite, pull/issue subresources, pull mergeability, token
        minting, rate-limit, and collaborator-permission endpoints are never served from this cache.
        Prometheus exports <code>loopover_github_response_cache_total</code>, and the bundled
        self-host Grafana dashboard includes the hit/miss/coalesced/error breakdown.
      </Callout>

      <h2>Queue cadence and startup</h2>
      <p>
        <code>CRON_INTERVAL_MS</code> (default <code>120000</code>, ~2 minutes) is the tick that
        drives the maintain/sweep and sync cadence — contributor evidence, burden forecasts, RAG
        re-indexing, drift scans, and notifications all fan out from it.{" "}
        <code>QUEUE_BACKGROUND_CONCURRENCY</code> (default <code>1</code>) caps how many
        low-priority background jobs may occupy a <code>QUEUE_CONCURRENCY</code> slot at once,
        independent of live webhook/review work.
      </p>
      <p>
        <code>QUEUE_STARTUP_JITTER_MIN_JOBS</code> (default <code>8</code>) sets the pending-job
        count below which the queue skips its startup jitter delay — useful on a small instance
        where you'd rather a handful of jobs start processing immediately after boot than wait out a
        jitter window meant to stagger many instances restarting at once.
      </p>

      <h2>Maintenance and installation backpressure</h2>
      <p>
        Two independent, opt-out admission checks run at queue-claim time, on top of GitHub
        rate-limit deferral, so background work never starves live PR review or overloads the host.
        Both grew out of real production incidents — an un-jittered cron enqueue and an unbounded
        per-installation background fan-out — and every value below is optional with a sane default.
      </p>
      <FeatureRow
        items={[
          {
            title: "MAINTENANCE_ADMISSION_* — host/lane pressure",
            description:
              "Defers a periodic maintenance job (contributor evidence, burden forecasts, RAG re-index, drift scans, notifications) when live jobs are backed up or host load is high, so maintenance never competes with live webhook/review work for CPU or DB time. A denied job is deferred with jitter, never dropped.",
          },
          {
            title: "GITHUB_INSTALLATION_CONCURRENCY_* — per-install fan-out",
            description:
              "Caps how many GitHub-fetching background jobs one installation may run at once, so one installation's sweep or backfill can't claim every background slot and starve every other installation, even when neither is near GitHub's own rate limit.",
          },
        ]}
      />
      <p>
        Tune <code>MAINTENANCE_ADMISSION_MAX_LIVE_PENDING</code> (default <code>5</code>),{" "}
        <code>MAINTENANCE_ADMISSION_MAX_LIVE_AGE_MS</code> (default <code>120000</code>),{" "}
        <code>MAINTENANCE_ADMISSION_MAX_PENDING</code> (default <code>15</code>),{" "}
        <code>MAINTENANCE_ADMISSION_MAX_HOST_LOAD</code> (default <code>1.5</code>, a 1-minute
        load-average-per-core ceiling), and{" "}
        <code>MAINTENANCE_ADMISSION_MAX_BACKLOG_CONVERGENCE_PENDING</code> (default <code>10</code>)
        if you register many repos or run a busy instance and see maintenance sweeps lagging behind
        where you'd like. A denial backs off by <code>MAINTENANCE_ADMISSION_DEFER_MS</code> (default{" "}
        <code>180000</code>, 3 minutes) before jitter, but two escape hatches stop a deferral from
        becoming a starve: <code>MAINTENANCE_ADMISSION_MAX_DEFER_AGE_MS</code> (default{" "}
        <code>14400000</code>, 4 hours) force-admits any maintenance job that has waited this long
        regardless of pressure, and the shorter <code>MAINTENANCE_ADMISSION_DRAIN_AGE_MS</code>{" "}
        (default <code>600000</code>, 10 minutes, clamped to the 4-hour ceiling) specifically drains
        the oldest jobs in a backed-up <code>maintenance_pending_high</code> lane so it can actually
        shrink instead of denying every claim for hours. Set{" "}
        <code>MAINTENANCE_ADMISSION_ENABLED=false</code> to fully disable the policy and return to
        the old always-run behavior.
      </p>
      <p>
        <code>GITHUB_INSTALLATION_CONCURRENCY_LIMIT</code> (default <code>2</code>) is the per-
        installation ceiling; <code>GITHUB_INSTALLATION_CONCURRENCY_DEFER_MS</code> (default{" "}
        <code>15000</code>, 15 seconds) is its base backoff before jitter. Raise the limit if a
        single large installation's background work is being throttled and you have GitHub
        rate-limit and host headroom to spare; set{" "}
        <code>GITHUB_INSTALLATION_CONCURRENCY_ENABLED=false</code> to disable the check entirely.
        This check only applies to background jobs that call GitHub — live PR review (
        <code>github-webhook</code>/<code>agent-regate-pr</code>) is never subject to it.
      </p>
      <Callout variant="note" title="FOREGROUND_LIVENESS_* — the other direction">
        Where the two backpressure checks above defer background work, foreground liveness protects
        live PR-review work FROM unbounded rate-limit deferral (its own worst case is up to ~65
        minutes per defer under sustained pressure, e.g. right after a deploy floods a shared REST
        budget). A periodic sweep force-releases any foreground-priority job that has genuinely
        waited past <code>FOREGROUND_LIVENESS_MAX_DEFER_MS</code> (default <code>600000</code>, 10
        minutes), checked every <code>FOREGROUND_LIVENESS_CHECK_INTERVAL_MS</code> (default{" "}
        <code>60000</code>, 1 minute — deliberately not the 1-second poll tick, so a job that is
        still genuinely rate-limited waits for the next sweep instead of busy-looping), releasing at
        most <code>FOREGROUND_LIVENESS_MAX_RELEASE_PER_SWEEP</code> jobs per tick (default{" "}
        <code>25</code>, oldest first, so a large inherited backlog ramps up gradually instead of
        every released job re-tripping the same rate-limit bucket at once). It also runs once at
        boot, so a restart self-heals inherited over-deferral. Set{" "}
        <code>FOREGROUND_LIVENESS_ENABLED=false</code> to disable the sweep.
      </Callout>

      <h2>Tracing and telemetry env</h2>
      <p>
        <code>OTEL_EXPORTER_OTLP_ENDPOINT</code> overrides the OpenTelemetry collector target only
        if you're routing to an external collector instead of the bundled one (default{" "}
        <code>http://otel-collector:4318</code> under the <code>observability</code> profile).{" "}
        <code>OTEL_SERVICE_NAME</code> (default <code>gittensory-selfhost</code>) is the service
        name traces and metrics are tagged with — set a distinct value per instance if you run more
        than one and want to tell them apart in Grafana/Tempo. <code>OTEL_TRACES_SAMPLER</code>{" "}
        (default <code>parentbased_traceidratio</code>) picks the sampling strategy for app
        job/provider traces; pair it with <code>OTEL_TRACES_SAMPLER_ARG</code> (for example{" "}
        <code>0.05</code> to sample 5% of root traces).
      </p>

      <h2>Generated env reference</h2>
      <p>
        This table is generated from <code>process.env.NAME</code> reads in{" "}
        <code>src/selfhost/**</code> and <code>src/server.ts</code>. It intentionally includes names
        and first source references only, never example values.
      </p>
      <CodeBlock filename="self-host env vars" code={SELFHOST_ENV_REFERENCE_MARKDOWN} />

      <h2>Repo activation — three layers</h2>
      <p>
        Self-host docs and logs use &quot;activation&quot; for more than one mechanism. They stack
        independently:
      </p>
      <FeatureRow
        items={[
          {
            title: "Feature allowlist (env)",
            description:
              "GITTENSORY_REVIEW_REPOS lists which repos run the converged per-PR path (safety, unified comment, grounding, RAG, reputation, …). Empty/unset ⇒ no repo runs those features, regardless of individual GITTENSORY_REVIEW_* flags. Per-repo features: overrides in a private or public .loopover.yml (or legacy .gittensory.yml, #4773) features: block can force on/off per repo (subject to env kill-switches).",
          },
          {
            title: "Gate activation (DB or private config)",
            description:
              "The one-click POST …/activation endpoint bundles two independent axes into one advisory-first default: the review-check publish mode (reviewCheckMode: required, checkRunMode: enabled) and the actual per-dimension gate rules (linkedIssueGateMode, duplicatePrGateMode, qualityGateMode: all advisory; AI review still off). .loopover.yml's (or legacy .gittensory.yml's, #4773) gate.checkMode / gate.enabled only ever set the first axis (the check-run publish mode) — the dimension rules themselves are configured separately via gate.linkedIssue, gate.duplicates, gate.readiness.mode, etc. (see Tuning your reviews). Gate rule evaluation itself is never gated by checkMode/enabled/checkRunMode; those only control whether/how the check-run publishes on GitHub.",
          },
          {
            title: "Gittensor registration (is_registered)",
            description:
              "The registry sync (GITTENSOR_REGISTRY_URL) marks repos present in the upstream snapshot with is_registered=1. That flag gates Gittensor-scored mining, evidence graphs, and several maintainer analytics — not basic webhook review. Brokered Orb installs may keep is_registered=0; listConvergenceRepos still pre-indexes GITTENSORY_REVIEW_REPOS for RAG.",
          },
        ]}
      />
      <p>
        Preview before flipping: <code>GET /v1/repos/:owner/:repo/activation-preview</code> runs the
        deterministic advisory engine over recent cached PRs (no AI cost) and returns a{" "}
        <code>recommendedAction</code> of <code>enable_advisory</code> when the gate is still off.
      </p>

      <h2>Per-PR feature flags</h2>
      <p>
        Most review capabilities need both their own flag and the repo in{" "}
        <code>GITTENSORY_REVIEW_REPOS</code> (unless a per-repo <code>features:</code> override says
        otherwise). This gives you a global kill switch and a per-repo rollout switch.
      </p>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_REPOS=owner/repo,owner/another
GITTENSORY_REVIEW_UNIFIED_COMMENT=true
GITTENSORY_REVIEW_INLINE_COMMENTS=false
GITTENSORY_REVIEW_SAFETY=true
GITTENSORY_REVIEW_GROUNDING=true
GITTENSORY_REVIEW_RAG=false
GITTENSORY_REVIEW_ENRICHMENT=false
GITTENSORY_REVIEW_REPUTATION=false`}
      />
      <Callout variant="safety">
        Empty <code>GITTENSORY_REVIEW_REPOS</code> means no repos run the per-PR feature path,
        regardless of the individual flags.
      </Callout>

      <h2>Private per-repo config</h2>
      <p>
        Mount a gitignored directory and point <code>GITTENSORY_REPO_CONFIG_DIR</code> at it. If
        either a per-repo file or the dir-root global default (<code>.loopover.yml</code> at the
        mount root) exists, the public repo <code>.loopover.yml</code> is never fetched for that
        review. With only one of the two present, its contents are used as-is; with both present,
        they are deep-merged — the per-repo file overlaid onto the global default, nested mappings
        merging key by key and arrays replacing wholesale. The legacy <code>.gittensory.yml</code>{" "}
        name is accepted everywhere <code>.loopover.yml</code> is (#4773) — when both names exist at
        the same location, the new-brand file wins outright rather than being merged with the legacy
        one.
      </p>
      <CodeBlock
        filename="config directory"
        code={`gittensory-config/
  owner__repo/.loopover.yml           # new-brand -- also accepts .gittensory.yml (#4773)
  repo-name/.loopover.yml
  owner__repo.yml
  .loopover.yml`}
      />
      <CodeBlock
        filename="owner__repo/.loopover.yml"
        code={`gate:
  checkMode: visible
  aiReview:
    mode: advisory
    allAuthors: true
settings:
  commentMode: all_prs
  includeMaintainerAuthors: true
  autonomy:
    merge: observe
    close: observe
  agentDryRun: false
features:
  safety: true
  unifiedComment: true
  rag: false
  reputation: false`}
      />
      <p>
        The <code>features:</code> block above overrides a deployment-wide{" "}
        <code>GITTENSORY_REVIEW_*</code> flag (rag, reputation, unifiedComment, safety) for this one
        repo, with three states per key: <code>true</code> forces the capability on for this repo
        (still subject to the env flag itself being enabled — it can never turn on a capability the
        operator has fully disabled at the deployment level); <code>false</code> forces it off for
        this repo regardless of the env flag; and omitting the key entirely falls back to the{" "}
        <code>GITTENSORY_REVIEW_REPOS</code> allowlist default, i.e. today's behavior for an
        operator who hasn't set anything here. See{" "}
        <Link to="/docs/tuning">Tuning your reviews</Link> for the full{" "}
        <code>GITTENSORY_REVIEW_*</code> flag list this overrides.
      </p>

      <h2>Config-as-code blocks with no dashboard equivalent</h2>
      <p>
        Everything above has a dashboard row it mirrors. The fields below exist{" "}
        <strong>only</strong> in <code>.loopover.yml</code> (or the legacy{" "}
        <code>.gittensory.yml</code>, #4773) — there is no DB column or dashboard toggle for them,
        so a self-host operator who never reads the example file may not know they exist.
      </p>
      <h3>gate.checkMode</h3>
      <p>
        Controls only whether/how the required <code>Gittensory Orb Review Agent</code> check-run is
        published — it never affects gate evaluation, comments, labels, audit records, or autonomous
        merge/close, all of which run identically in every mode. Takes precedence over the legacy{" "}
        <code>gate.enabled</code> boolean when both are set.
      </p>
      <FeatureRow
        items={[
          {
            title: "required",
            description:
              "Publish/update the check exactly as before. Use if you keep it as a required branch-protection status check.",
          },
          {
            title: "visible",
            description:
              "Publish/update the same check-run for UI visibility only. Never add it to branch protection as required.",
          },
          {
            title: "disabled",
            description:
              "Never create/update the check-run. Recommended for high-volume autonomous self-hosting — avoids a perpetually-pending status and cuts GitHub API calls.",
          },
        ]}
      />
      <Callout variant="warn" title="Remove the branch-protection requirement first">
        Before switching to <code>disabled</code>, remove <code>Gittensory Orb Review Agent</code>{" "}
        from this repo&apos;s branch-protection or ruleset required-status-checks list — LoopOver
        cannot do this on your behalf, and leaving it required with nothing to satisfy it means
        GitHub shows a pending status forever. Keep your real CI/Codecov/security checks required;
        this setting only ever affects LoopOver&apos;s own check-run.
      </Callout>
      <p>
        For a repo that has never been configured, the default is <code>disabled</code>; an
        already-configured repo keeps its current effective behavior. Self-hosters running
        high-volume autonomous review should prefer <code>visible</code> or <code>disabled</code>{" "}
        over <code>required</code> — LoopOver&apos;s own merge/close decisions never depend on this
        check either way.
      </p>

      <h3>Other gate-only fields</h3>
      <ul>
        <li>
          <code>gate.cla</code> — sub-object for the CLA gate (<code>gate.claMode</code>, documented
          on <Link to="/docs/tuning">Tuning your reviews</Link>): <code>consentPhrase</code> (a
          case-insensitive substring LoopOver looks for in the PR description),{" "}
          <code>checkRunName</code> (an existing CLA-bot check-run name that also satisfies
          consent), and <code>checkRunAppSlug</code> (the trusted App slug required to have produced
          that check-run, so a contributor-controlled same-name check can&apos;t satisfy a blocking
          legal gate). Either detection method is enough; both may be set. All default to{" "}
          <code>null</code> (not configured).
        </li>
        <li>
          <code>gate.expectedCiContexts</code> — CI check/status context names to treat as required
          when GitHub branch protection returns no readable required-status-checks (unconfigured, or
          a 403 from a token lacking <code>administration:read</code> — common for GitHub App
          installations, especially self-host). Merged with branch-protection contexts when both are
          readable; used alone when branch protection is null/empty. Default: not configured, which
          keeps the fold-all fail-closed behavior when branch protection is also unreadable.
        </li>
        <li>
          <code>gate.premergeContentRecheck</code> — when <code>true</code>, a PR touching{" "}
          <code>migrations/**</code> gets a fresh GitHub read of the base branch&apos;s current
          migration filenames immediately before an agent-driven merge, catching a different PR that
          merged a same-numbered migration in the meantime. A live collision holds the PR instead of
          merging blind. Default <code>false</code> — costs one extra GitHub API call per
          migrations-touching PR.
        </li>
        <li>
          <code>gate.requireFreshRebaseWindow</code> — when the base branch has advanced within this
          many minutes of the actual merge decision, forces an <code>update_branch</code> + fresh CI
          recheck before merging, instead of trusting a possibly-stale{" "}
          <code>mergeable_state: clean</code> read. A bounded retry cap prevents a fast-moving base
          from live-locking the PR. Default <code>null</code> (never force).
        </li>
        <li>
          <code>gate.dryRun</code> — when <code>true</code>, the posted check conclusion remains the
          real non-enforcing verdict while comments/check text may also show the would-be stricter
          verdict for AI-review blocker mode. It does not disable downstream merge/close planning
          for failures from already-enforced gates. Default <code>false</code>.
        </li>
        <li>
          <code>gate.firstTimeContributorGrace</code> — reserved and currently inert: parsed and
          stored, but the gate does not read it. A first-time contributor with a real blocker is
          one-shot closed the same as a repeat contributor. Kept for potential future use.
        </li>
      </ul>

      <h3>settings.closeOwnerAuthors and blockedPaths</h3>
      <p>
        <code>settings.closeOwnerAuthors</code> — by default, the repo owner&apos;s own PRs (and{" "}
        <code>ADMIN_GITHUB_LOGINS</code> fleet-operator PRs) are never auto-closed; they may still
        auto-merge when clean and passing, or fall to a manual hold. Set <code>true</code> to make
        owner/admin-authored PRs eligible for auto-close like a contributor&apos;s, still gated by
        the close autonomy class and adverse-signal conditions. Automation-bot PRs stay exempt
        regardless of this setting. Default <code>false</code>.
      </p>
      <p>
        <code>blockedPaths</code> (top-level, alongside <code>wantedPaths</code>) is{" "}
        <strong>fully retired</strong> (#2974) — the FocusManifest parser no longer reads this key
        at all, it produces zero findings, and it is not enforceable under any{" "}
        <code>gate.manifestPolicy</code> mode. Setting it in a config produces only a migration
        warning from <code>npm run selfhost:config-lint</code>, nothing else.{" "}
        <strong>The only mechanism that actually holds a PR for a touched path</strong> is{" "}
        <code>settings.hardGuardrailGlobs</code> (config-as-code only, described above) — a
        would-merge PR that touches a configured guardrail glob is held for manual review.
      </p>

      <h3>settings anti-abuse block</h3>
      <p>
        A cluster of contributor-abuse guardrails, all config-as-code only, all off/unset by
        default:
      </p>
      <ul>
        <li>
          <strong>Open-item caps</strong> — <code>contributorOpenPrCap</code> and{" "}
          <code>contributorOpenIssueCap</code> bound how many PRs/issues a single non-owner/
          non-admin/non-bot contributor may have open at once; a contributor&apos;s newest item
          above the cap is closed with a clear reason, their oldest items up to the cap stay open.
          Both are unset (no cap) by default. <code>contributorCapLabel</code> (default{" "}
          <code>over-contributor-limit</code>) is the label applied on close — set it to explicit{" "}
          <code>null</code> to close silently. <code>contributorCapCancelCi</code> cancels in-flight
          CI runs on a cap-triggered close (requires the <code>actions: write</code> App permission;
          degrades gracefully without it) and falls back to the{" "}
          <code>CONTRIBUTOR_CAP_CANCEL_CI_DEFAULT</code> env var when unset.
        </li>
        <li>
          <strong>Review-nag cooldown</strong> — <code>reviewNagPolicy</code> (<code>off</code>/
          <code>hold</code>/<code>close</code>, default <code>off</code>) throttles a contributor
          who repeatedly pings <code>@gittensory</code> for review on the same PR/issue, once they
          exceed <code>reviewNagMaxPings</code> (default <code>3</code>) within{" "}
          <code>reviewNagCooldownDays</code> (default <code>5</code>). <code>reviewNagLabel</code>{" "}
          (default <code>review-nag-cooldown</code>) is applied alongside the hold/close action.{" "}
          <code>reviewNagMonitoredMentions</code> extends the same cooldown to specific maintainer
          logins a contributor keeps tagging directly instead of (or in addition to){" "}
          <code>@gittensory</code>.
        </li>
        <li>
          <strong>Exemptions and account age</strong> — <code>autoCloseExemptLogins</code> is a
          shared, repo-scoped list of logins never throttled or closed by these deterministic
          mechanisms, on top of the standing owner/admin/bot exemption.{" "}
          <code>accountAgeThresholdDays</code> (default <code>null</code>, off) applies{" "}
          <code>newAccountLabel</code> (default <code>new-account</code>) to a PR from a
          below-threshold-age account — friction/visibility only, never an automatic close on
          account age alone, and never for the owner, admins, or bots.
        </li>
        <li>
          <strong>Command rate limit</strong> — <code>commandRateLimitPolicy</code> (
          <code>off</code>/<code>hold</code>, default <code>off</code>) generalizes the review-nag
          pattern to every <code>@gittensory</code> command, not just review-request pings.{" "}
          <code>commandRateLimitMaxPerWindow</code> (default <code>20</code>) bounds cheap,
          cache-only commands; <code>commandRateLimitAiMaxPerWindow</code> (default <code>5</code>)
          is the tighter limit for AI-cost-bearing commands (ask/blockers/preflight/etc.);{" "}
          <code>commandRateLimitWindowHours</code> (default <code>24</code>) is the rolling window
          both limits count against.
        </li>
      </ul>

      <h3>contentLane</h3>
      <p>
        Lets a self-hosted maintainer point LoopOver at their own structured registry (a
        subnet/plugin/package catalog, for example) without a LoopOver code change — reviewing
        additions to a data file the same way it reviews code. Unconfigured by default; uncomment
        and set at least <code>entryFileGlob</code> and <code>collectionField</code> (both required
        — the whole block is ignored with a warning if either is missing).
      </p>
      <CodeBlock
        filename=".loopover.yml"
        lang="yaml"
        code={`contentLane:
  entryFileGlob: registry/*.json      # Glob for the structured entry files this lane reviews. Required.
  collectionField: entries            # The JSON field holding the collection this lane diffs. Required.
  providerFileGlob: providers/*.ts    # Optional glob for source files the entries are validated against.
  artifactGlob: dist/registry.json    # Optional glob for a generated/build artifact to cross-check.
  maxAppendedEntries: 1               # Positive integer cap on new entries per PR. Default: unbounded.
  duplicateKeyFields: [slug]          # Field name(s) used to detect a duplicate entry. Default: [] (no dedup check).
  validatorId: my-registry-validator  # Optional identifier for a custom per-entry validator. Default: none.`}
      />

      <h3>repoDocGeneration</h3>
      <p>
        Lets LoopOver open a pull request that refreshes this repo&apos;s own <code>AGENTS.md</code>
        /<code>CLAUDE.md</code> (and, additively, a skill file) on a schedule — never a direct
        commit. Disabled by default: an unconfigured repo, or an explicit{" "}
        <code>enabled: false</code>, means no repo-doc refresh ever runs for it.
      </p>
      <CodeBlock
        filename=".loopover.yml"
        lang="yaml"
        code={`repoDocGeneration:
  enabled: true                       # Opt in. Default: false (fully disabled).
  scope: [agents]                     # "agents" (AGENTS.md/CLAUDE.md) and/or "skills". Default: [agents].
  allowOverwriteExisting: false       # Refresh a file that needs manual review to change. Default: false.
  refreshIntervalDays: 7              # Minimum days between refreshes. Default: 7.`}
      />

      <h2>Instance-wide write switches (SELFHOST_DEPLOYMENT_MODE)</h2>
      <p>
        <code>SELFHOST_DEPLOYMENT_MODE</code> forces write suppression for the whole instance,
        regardless of per-repo autonomy — useful for running a self-host in parallel with the live
        cloud App on the same webhooks, provably posting nothing until an explicit cutover.
      </p>
      <FeatureRow
        items={[
          {
            title: "Unset (default)",
            description:
              "Normal mode. Per-repo autonomy and GitHub permissions decide what can be written.",
          },
          {
            title: "dry-run",
            description:
              "Compute reviews and audit as shadow, but suppress comments, checks, labels, merges, and closes.",
          },
          {
            title: "disabled",
            description: "Suppress writes as denied. Use when you need a hard instance-wide stop.",
          },
        ]}
      />

      <h2>Next steps</h2>
      <p>
        Configure the GitHub integration in{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>, then add optional
        context through <Link to="/docs/self-hosting-ai-providers">AI providers</Link>,{" "}
        <Link to="/docs/self-hosting-rees">REES</Link>, or{" "}
        <Link to="/docs/self-hosting-rag">RAG</Link>. For the full gate-mode and per-repo settings
        reference — including the AI-review combine modes and a complete worked manifest — see{" "}
        <Link to="/docs/tuning">Tuning your reviews</Link>.
      </p>
    </DocsPage>
  );
}
