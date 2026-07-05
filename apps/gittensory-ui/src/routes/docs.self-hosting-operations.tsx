import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-operations")({
  head: () => ({
    meta: [
      { title: "Self-host operations — Gittensory docs" },
      {
        name: "description",
        content:
          "Operate the self-hosted Gittensory review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, and safe updates/rollback.",
      },
      { property: "og:title", content: "Self-host operations — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Operate the self-hosted Gittensory review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, and safe updates/rollback.",
      },
      { property: "og:url", content: "/docs/self-hosting-operations" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-operations" }],
  }),
  component: SelfHostingOperations,
});

function SelfHostingOperations() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Operations"
      description="Daily operating checks for the review service: health, queue, logs, metrics, dashboards, and context services."
    >
      <h2>Health endpoints</h2>
      <FeatureRow
        items={[
          {
            title: "/health",
            description: "Liveness. Use for simple process checks.",
          },
          {
            title: "/ready",
            description: "Readiness. Use for orchestration because it waits for DB and migrations.",
          },
          {
            title: "/metrics",
            description:
              "Prometheus metrics for queues, jobs, HTTP requests, uptime, and AI usage.",
          },
        ]}
      />

      <h2>Useful commands</h2>
      <CodeBlock
        lang="bash"
        code={`docker compose ps
docker compose logs -f gittensory
curl http://localhost:8787/ready
curl http://localhost:8787/metrics`}
      />

      <h2>Important log events</h2>
      <CodeBlock
        code={`selfhost_listening
selfhost_migrations_applied
selfhost_ai_provider
selfhost_ai_review_plan
selfhost_embed_provider
selfhost_vectorize
selfhost_job_dead
selfhost_cron_error
review_context_fetch_failed
selfhost_webhook_enqueue_failed
selfhost_webhook_enqueue_binding_missing`}
      />

      <h2>Observability profile</h2>
      <p>
        The observability profile starts Prometheus, Alertmanager, Loki, Promtail, and Grafana with
        dashboards for infra, review activity, and AI usage.
      </p>
      <p>
        Postgres installs also expose database internals through the bundled Postgres exporter:
        connection pressure, lock waits, long transactions, deadlocks, database/table growth, dead
        tuples, autovacuum activity, and backup freshness. Backup freshness appears when the{" "}
        <code>backup</code> profile is active.
      </p>
      <p>
        When OpenTelemetry and Sentry are enabled, job audit logs and Sentry events include
        trace_id/span_id fields so an operator can jump from a failed job or issue to the matching
        trace in Grafana or Tempo.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile postgres --profile observability up -d
docker compose --profile postgres --profile observability --profile backup up -d`}
      />

      <h2>Alerting — required for a 24/7 deployment</h2>
      <p>
        Alertmanager ships with a valid but <strong>silent</strong> default: every alert routes to a
        name-only receiver that discards it, so{" "}
        <code>docker compose --profile observability up -d</code> always starts clean even before
        you've configured anywhere to send notifications. This is intentional — the shipped config
        can&apos;t bake in a Slack/Discord/email destination that works for everyone — but it means
        nothing pages anyone until you edit <code>alertmanager/alertmanager.yml</code> yourself.
        Treat this as a required step, not an optional one, for any deployment you expect to run
        unattended.
      </p>
      <p>
        The fastest verified path: create a Discord channel webhook (channel settings → Integrations
        → Webhooks → New Webhook), then uncomment the <code>discord</code> receiver block in{" "}
        <code>alertmanager/alertmanager.yml</code> and point the root route at it. Slack, email, and
        a generic webhook receiver (for PagerDuty or a custom handler) are also ready to uncomment
        in the same file.
      </p>
      <p>
        Until you do, alerts are still visible without any extra setup: open Grafana and check the{" "}
        <strong>Alerts</strong> row on the main dashboard, which lists every currently-firing alert
        directly from Prometheus, independent of Alertmanager routing. Use this as your fallback
        check if you haven&apos;t wired up push notifications yet — it&apos;s exactly what the{" "}
        <code>Dead jobs stay at zero</code> routine check below is watching for.
      </p>
      <p>
        Dead-lettered jobs also get one automatic revival attempt every 30 minutes (
        <code>QUEUE_DEAD_LETTER_REVIVE_INTERVAL_MS</code>), as long as the job hasn't already been
        revived more than a small, bounded number of extra times (
        <code>QUEUE_DEAD_LETTER_AUTO_RETRY_MAX_EXTRA_ATTEMPTS</code>, default 3) — so a job that
        died from a bug that's since been fixed and redeployed recovers on its own within the next
        cycle, without needing direct database access. A job that keeps failing the same way
        eventually exhausts this budget and stays dead, which is exactly what the alert above is
        watching for.
      </p>

      <h2>Resource profiles</h2>
      <p>
        <strong>Measured</strong> rows below come from a real production instance running the full
        profile set (<code>qdrant</code> + <code>redis</code> + <code>observability</code> +{" "}
        <code>backup</code> + <code>postgres</code> + <code>ollama</code>) at steady state —
        <code>docker stats</code> and <code>docker system df</code> snapshots, not a lab benchmark.
        <strong> Estimated</strong> rows are reasoned from that same baseline plus each
        service&apos;s declared <code>deploy.resources.limits</code> and image size in{" "}
        <code>docker-compose.yml</code> — they have not been measured directly and could be off,
        especially for CPU under real load. Treat estimates as a starting point for capacity
        planning, not a guarantee.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-token-sm">
          <thead>
            <tr className="border-hairline text-left text-token-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Profile</th>
              <th className="py-2 pr-4 font-medium">CPU (steady state)</th>
              <th className="py-2 pr-4 font-medium">Memory (steady state)</th>
              <th className="py-2 font-medium">Basis</th>
            </tr>
          </thead>
          <tbody className="divide-hairline">
            <tr>
              <td className="py-2 pr-4 align-top">
                Minimal — app + <code>redis</code> only (no profile flags)
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">~3% of one core</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">~400–600MiB</td>
              <td className="py-2 align-top text-muted-foreground">
                Estimated: app + redis measured in isolation from the full-profile snapshot (app
                2.6% CPU / 365MiB; redis is idle-light and its 512MiB limit is never approached in
                the full-profile run either).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile postgres</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                +14% of one core (highest single-service CPU consumer)
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">+~200MiB</td>
              <td className="py-2 align-top text-muted-foreground">
                Measured: 14.24% CPU / 196MiB of its 2GiB limit — comfortable headroom on memory,
                but the largest CPU line item in the whole stack.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile qdrant</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">Low single-digit %</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Well under its 2GiB limit
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Measured (part of the full-profile snapshot's "everything else" low-CPU, under-limit
                group). Grows with RAG corpus size — expect this to climb on installs with many
                indexed repos.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile observability</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Low single-digit % per service, except Grafana/Tempo below
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Grafana ~305MiB (60% of 512MiB); Tempo ~209MiB (20% of 1GiB); Prometheus/Loki/
                Alertmanager/Promtail/otel-collector each well under their limits
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Measured. Grafana is the closest any service comes to its ceiling in production —
                worth watching if you add many custom dashboards or panels, but not currently a
                problem (40% headroom remains).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile ollama</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Near-zero idle; spikes hard during inference
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Model-dependent, up to its 8GiB limit
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Estimated. Not part of the live production profile mix (that instance uses{" "}
                <code>AI_PROVIDER=codex</code>, not Ollama) — the 8GiB default limit is sized for a
                single loaded 7–8B quantized model per the compose comment, not measured against a
                running model. Idle Ollama with no model pulled is cheap; a loaded model can
                legitimately approach the limit, which is why it has the largest default ceiling in
                the file.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile backup</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Near-zero except during runs
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Low, bursts during dump/restore
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Measured as part of the full-profile snapshot (no dedicated resource limit is set
                for <code>backup</code>/<code>backup-exporter</code> — both are short-lived or
                idle-polling processes, not sustained consumers).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                + <code>--profile runners</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Unbounded by default — can starve the app under CI load
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">Unbounded by default</td>
              <td className="py-2 align-top text-muted-foreground">
                Estimated, and explicitly a known risk, not a guess about typical usage: the{" "}
                <code>runner</code> service ships with no CPU/memory limit at all. Production
                experience already documented in <code>docker-compose.override.yml.example</code>{" "}
                found 3 uncapped runner containers starving the app for CPU on an 8-vCPU box under
                real CI load — see that file for the <code>cpu_shares</code>/<code>cpus</code>{" "}
                mitigation before co-locating runners with the review stack.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">
                Full profile set (<code>qdrant</code> + <code>redis</code> +{" "}
                <code>observability</code> + <code>backup</code> + <code>postgres</code> +{" "}
                <code>ollama</code>, no active inference, no runners)
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Postgres (~14%) dominates; everything else low single-digit %
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                No service near its limit except Grafana (~60%)
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Measured, in full, on a real production instance.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>Disk</h3>
      <p>
        Measured on the same production instance: 48GB of 151GB used on the host root volume (32%)
        at steady state. <code>docker system df</code> breakdown:
      </p>
      <FeatureRow
        items={[
          {
            title: "Images",
            description: "22.59GB total, 19.24GB (85%) reclaimable via prune.",
          },
          {
            title: "Volumes",
            description:
              "20.57GB total, 5.4GB (26%) reclaimable — this is real application state (databases, vector index, backups), so most of it is never pruned.",
          },
          {
            title: "Build cache",
            description: "6.39GB total, 3.55GB (56%) reclaimable.",
          },
        ]}
      />
      <p>
        The reclaimable image and build-cache space here is{" "}
        <strong>expected steady state, not a leak</strong> — this instance runs{" "}
        <code>scripts/deploy-selfhost-prebuilt.sh</code>, which rebuilds the image from the current
        git checkout on every deploy and intentionally keeps prior layers around in the build cache
        for faster rebuilds. The <code>gittensory-docker-safe-prune</code> systemd timer (below)
        already runs daily against this exact instance and reclaims it on a schedule, so this is not
        a number to chase down manually.
      </p>

      <h3>When a compose default might need to change</h3>
      <p>
        Every <code>deploy.resources.limits.memory</code> in <code>docker-compose.yml</code> is
        operator-overridable via <code>.env</code> (see the <code>*_MEM_LIMIT</code> variables in{" "}
        <code>.env.example</code>). Against the measured full-profile data above, none of the
        current defaults look miscalibrated enough to change: nothing sits consistently near its
        limit in a way that risks an OOM kill under normal load (Grafana&apos;s ~60% is the closest
        and still has real headroom), and nothing is so oversized relative to plausible usage that
        it should be lowered — including Ollama&apos;s comparatively large 8GiB ceiling, which is
        sized for holding one quantized model in memory, not idle overhead. The one real gap is{" "}
        <code>--profile runners</code>, which ships with no limit at all; that is a known,
        documented tradeoff (see the table above and{" "}
        <code>docker-compose.override.yml.example</code>) rather than an oversight, since the right
        ceiling depends entirely on the host's core count and how many runner replicas you run.
      </p>

      <h3>Capacity planning: how much disk for N repos at M PRs/month</h3>
      <p>
        The 151GB host above is one measured point, not a formula. It says nothing about how disk
        use grows as you register more repos or review more pull requests — for that you have to
        reason about which tables and volumes actually grow with activity, versus which are fixed
        overhead. Treat every number below as an order-of-magnitude estimate to plan around, not a
        guarantee.
      </p>
      <FeatureRow
        items={[
          {
            title: "review_audit (fixed overhead per PR, unbounded)",
            description:
              "Roughly 2 rows per PR — one finalized gate decision plus one realized merge/close outcome — each a few small text columns (well under 1KB/row). It has no retention policy in src/db/retention.ts, so it grows forever. Don't trust a blanket MB-per-thousand-PRs estimate here; measure your own instance's actual growth with pg_total_relation_size('review_audit') (or the equivalent SQLite page count) after a known number of PRs, then extrapolate from that.",
          },
          {
            title: "webhook_events (fixed overhead per delivery, unbounded)",
            description:
              "One row per inbound GitHub webhook delivery — every push, comment, check-run update, and review event, not just PR opens — so it accrues considerably faster than review_audit for the same PR volume (commonly 5-15x, depending on how chatty a repo's CI and review activity are). Also absent from RETENTION_POLICY, so it also grows without bound. Still small per row; the growth to watch is row count over months, not any single row's size.",
          },
          {
            title: "audit_events (bounded — 90-day retention)",
            description:
              "One row per privileged/security-relevant action (recordAuditEvent in src/db/repositories.ts), pruned automatically: RETENTION_POLICY in src/db/retention.ts keeps 90 days and the prune-retention job runs daily at 03:00 UTC (src/index.ts), so this table's steady-state size is capped regardless of how long the instance has been running — it will not be a long-term capacity driver the way the two tables above are.",
          },
          {
            title: "Postgres/SQLite backup dumps (scales with live DB size x retained copies)",
            description:
              "scripts/backup.sh keeps the newest BACKUP_RETAIN copies per target (default 7 — see the backup and scaling doc's retention section), so total backup-volume usage is roughly (live database size) x (retained count), independent of repo count except through the database-size term. A growing, unpruned review_audit/webhook_events pair feeds directly into this multiplier: whatever they add to the live database, the backup volume carries N times over.",
          },
        ]}
      />
      <p>
        Putting it together: for a small install (a handful of repos, tens of PRs/month), all of
        this is noise against the ~20GB of fixed Docker/image/volume overhead measured above — you
        will not notice review_audit or webhook_events growth for a long time. The estimate gets
        real at higher volume: an install running hundreds of PRs/month across dozens of repos, left
        unattended for a year or more, is a plausible case where the unbounded tables above (and the
        backups that multiply them) become the dominant long-term disk driver rather than Docker
        images and build cache. There is no first-party tool yet to prune review_audit or
        webhook_events — if you operate at that scale, monitor their row counts directly (
        <code>SELECT count(*) FROM review_audit</code>,{" "}
        <code>SELECT count(*) FROM webhook_events</code>) rather than assuming steady state.
      </p>

      <h2>Docker resource hygiene</h2>
      <p>
        Every service in <code>docker-compose.yml</code> caps its own container logs (10MB × 3
        rotated files) out of the box, so log growth alone won&apos;t fill your disk. Unused Docker
        images and build cache are a separate, larger disk-growth vector on a host that rebuilds or
        pulls images repeatedly over months — Docker does not reclaim either automatically.
      </p>
      <p>
        Install the provided host-level timer to reclaim both on a schedule (anything unused for
        less than 7 days is left alone, so a recent deploy is never at risk):
      </p>
      <CodeBlock
        lang="bash"
        code={`sudo cp systemd/gittensory-docker-prune.service.example /etc/systemd/system/gittensory-docker-prune.service
sudo cp systemd/gittensory-docker-prune.timer.example /etc/systemd/system/gittensory-docker-prune.timer
sudo $EDITOR /etc/systemd/system/gittensory-docker-prune.service   # set WorkingDirectory / ExecStart to your path
sudo systemctl daemon-reload
sudo systemctl enable --now gittensory-docker-prune.timer`}
      />
      <p>
        Run it manually at any time with <code>docker system df</code> before and after to see what
        it reclaimed: <code>sh scripts/selfhost-docker-prune.sh</code>.
      </p>
      <p>
        This should always prune <strong>containers, images, and build cache</strong> — never
        volumes. Pruning a volume deletes real application state (the database, backups, vector
        index, or a runner&apos;s registration and job data), not disposable build output, so it is
        never part of routine cleanup unless you intentionally want to delete that state.
      </p>

      <h2>Self-hosted runner temp storage</h2>
      <p>
        If you run <code>--profile runners</code>, keep every runner job&apos;s scratch/temp writes
        on the mounted <code>runner-work</code> volume, never the container&apos;s plain{" "}
        <code>/tmp</code>. A container&apos;s own <code>/tmp</code> lives in Docker&apos;s
        overlay/containerd snapshot storage — a CI job that writes high-volume temp data there
        (language toolchain caches, build artifacts, ad hoc <code>mktemp</code> calls) grows the
        host&apos;s Docker root storage directly, not the volume, so it is invisible to
        volume-scoped cleanup and can fill the disk out from under the whole stack. The shipped{" "}
        <code>runner</code> service points <code>TMPDIR</code>, <code>TMP</code>, and{" "}
        <code>TEMP</code> at <code>/tmp/runner/tmp</code> (a subdirectory of the mounted{" "}
        <code>runner-work</code> volume) and keeps <code>RUNNER_WORKDIR</code> at{" "}
        <code>/tmp/runner</code> on the same volume. A one-shot <code>runner-tmp-init</code> service
        creates that directory on the volume (and makes it world-writable, matching real{" "}
        <code>/tmp</code> permissions) before the runner container starts, so this works out of the
        box on a fresh volume with no manual steps.
      </p>
      <p>
        Adding a second or third runner service in <code>docker-compose.override.yml</code> for
        higher CI throughput? Each one needs its own <code>runner-work</code>-style volume, its own
        init step, and the same temp env — YAML anchors don&apos;t cross separate compose files, so
        repeat the extension block in your override file:
      </p>
      <CodeBlock
        lang="yaml"
        code={`x-runner-tmp-env: &runner-tmp-env
  TMPDIR: /tmp/runner/tmp
  TMP: /tmp/runner/tmp
  TEMP: /tmp/runner/tmp

services:
  runner-2-tmp-init:
    image: alpine:3.20
    profiles: ["runners"]
    volumes:
      - runner-work-2:/tmp/runner
    command: ["sh", "-c", "mkdir -p /tmp/runner/tmp && chmod 1777 /tmp/runner/tmp"]

  runner-2:
    image: myoung34/github-runner:ubuntu-jammy
    profiles: ["runners"]
    depends_on:
      runner-2-tmp-init:
        condition: service_completed_successfully
    environment:
      <<: *runner-tmp-env
      RUNNER_NAME: gittensory-runner-2
      RUNNER_SCOPE: \${RUNNER_SCOPE:-repo}
      REPO_URL: \${RUNNER_REPO_URL:-}
      RUNNER_TOKEN: \${RUNNER_TOKEN:-}
      RUNNER_WORKDIR: /tmp/runner
    volumes:
      - runner-work-2:/tmp/runner

volumes:
  runner-work-2:`}
      />

      <h2>Sentry tracing</h2>
      <p>
        Leave <code>SENTRY_TRACES_SAMPLE_RATE</code> unset or blank to disable trace export, or set
        a positive sample rate such as <code>0.05</code> to send sampled review spans to Sentry. The
        custom OpenTelemetry provider installs Sentry hooks for review-stage spans carrying repo,
        PR, operation, outcome, and hashed installation tags.
      </p>
      <h2>Sentry cron monitors</h2>
      <p>
        When <code>SENTRY_DSN</code> is set, the self-host runtime emits Sentry monitor check-ins
        for the recurring loops where silent stoppage matters most. Leaving <code>SENTRY_DSN</code>{" "}
        unset keeps monitor reporting off.
      </p>
      <FeatureRow
        items={[
          {
            title: "scheduled loop",
            description:
              "The two-minute maintenance tick that fans out sweeps, backfills, and refresh jobs.",
          },
          {
            title: "Orb export",
            description: "The hourly outcome export loop used by brokered self-host deployments.",
          },
          {
            title: "Orb relay drain",
            description:
              "The pull-mode relay loop for installations that receive events outbound from Orb.",
          },
          {
            title: "Orb relay register",
            description:
              "The recurring retry loop that (re-)registers this instance with the relay broker.",
          },
          {
            title: "Queue dead-letter revive",
            description:
              "The 30-minute (by default) sweep that retries dead-lettered jobs still under the auto-retry ceiling.",
          },
        ]}
      />
      <p>
        A missed monitor means the process may still be alive but the recurring work is not checking
        in on schedule. Pair the monitor with queue depth, dead-job counts, and the structured error
        log for the same subsystem.
      </p>

      <h2>Routine checks</h2>
      <ul>
        <li>Queue pending count is not growing without processing.</li>
        <li>Dead jobs stay at zero or are investigated promptly.</li>
        <li>Webhook deliveries are recent and have 2xx responses, with no enqueue failures.</li>
        <li>AI usage matches expected review volume and model/effort choices.</li>
        <li>REES and RAG failures are visible and bounded.</li>
        <li>
          Postgres connections, lock waits, slow transactions, dead tuples, and table growth are
          stable.
        </li>
        <li>Backups are recent and restore-tested.</li>
      </ul>

      <h2>Updating and rolling back</h2>
      <p>
        Both update paths below only ever restart the <code>gittensory</code> app service (
        <code>--no-deps</code>) — they never touch other compose-profile services or their state
        (Postgres, Redis, Qdrant, and Grafana&apos;s own <code>grafana-data</code> volume), and they
        never touch <code>.env</code> keys other than the one they persist for next time. That means{" "}
        <code>.env</code>, the <code>gittensory-config/</code> mount, every data volume — including
        the app&apos;s own <code>/data</code> volume where Codex/Claude Code auth material lives —
        and any <code>docker-compose.override.yml</code> are preserved automatically across an
        update. You don&apos;t need to back those up or re-supply them just to run either script,
        and you only need to recreate a profile service yourself if you&apos;re deliberately
        upgrading that service (its own image tag in <code>docker-compose.yml</code>, or a
        Postgres/Redis/Qdrant major-version bump) rather than the app.
      </p>

      <h3>Path 1: pull a published image</h3>
      <p>
        <code>scripts/deploy-selfhost-image.sh</code> pulls a tag or digest, restarts only the{" "}
        <code>gittensory</code> service, waits for it to report <code>healthy</code> via{" "}
        <code>docker inspect</code>&apos;s health status (configurable timeout, default 180s), and
        then persists the resolved image reference back to <code>GITTENSORY_IMAGE</code> in{" "}
        <code>.env</code> so the next plain invocation reuses it.
      </p>
      <CodeBlock
        lang="bash"
        code={`# Re-pull whatever GITTENSORY_IMAGE already resolves to (safe no-op restart if the tag is unchanged
# and nothing new was pushed under it)
./scripts/deploy-selfhost-image.sh

# Pin an exact release tag or content digest
./scripts/deploy-selfhost-image.sh ghcr.io/jsonbored/gittensory-selfhost:orb-v0.1.0
GITTENSORY_IMAGE=ghcr.io/jsonbored/gittensory-selfhost@sha256:... ./scripts/deploy-selfhost-image.sh`}
      />
      <p>
        The pull always runs with <code>--policy always</code>, so re-running the script against an
        unchanged tag is safe: if the registry has nothing new, it just restarts the same image and
        the health-check wait passes immediately.
      </p>

      <h3>Path 2: build from the current git checkout</h3>
      <p>
        <code>scripts/deploy-selfhost-prebuilt.sh</code> is for a source-based deploy (this is how{" "}
        <code>GITTENSORY_VERSION</code> ends up as a short git SHA instead of an image tag). It
        builds the bundle inside a Dockerized Node container — the host itself never needs Node or
        npm installed — then restarts only the <code>gittensory</code> service the same way as the
        image path.
      </p>
      <CodeBlock
        lang="bash"
        code={`git pull
./scripts/deploy-selfhost-prebuilt.sh`}
      />
      <p>
        <code>SENTRY_RELEASE</code> defaults to{" "}
        <code>gittensory-selfhost@&lt;short git SHA of the current HEAD&gt;</code> unless you
        override it, so each deploy from a new commit gets a distinct release id automatically. When{" "}
        <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_ORG</code>, and <code>SENTRY_PROJECT</code> are
        all configured, the script also injects and uploads Sentry source maps for that release
        before restarting the service (set <code>SELFHOST_SKIP_SENTRY_UPLOAD=1</code> to skip this
        even when those three are present).
      </p>

      <h3>Rollback: no dedicated command today</h3>
      <p>
        There is no <code>rollback</code> script. Rolling back means re-running one of the two
        scripts above pointed at an older target:
      </p>
      <ul>
        <li>
          Image-based: re-run <code>deploy-selfhost-image.sh</code> with the prior tag or digest (
          <code>docker inspect</code> on the running container, or your own deploy log, has the
          digest you were on before the update).
        </li>
        <li>
          Source-based: <code>git checkout</code> the prior commit, then re-run{" "}
          <code>deploy-selfhost-prebuilt.sh</code>.
        </li>
      </ul>
      <Callout variant="warn" title="Migrations are forward-only">
        This repo has no down-migration convention — <code>scripts/check-migrations.mjs</code> only
        enforces a contiguous, non-colliding numbering, not a reverse path. If a migration has
        already run forward against the live database, rolling back the app code is{" "}
        <strong>not safe in general</strong>: older code can break against a newer schema (a
        dropped/renamed column, a NOT NULL column it never writes, a changed constraint), even
        though the migration itself succeeded. Before rolling back across a migration boundary,
        check whether everything the newer migration(s) did is purely additive (new nullable column,
        new table, new index) and, specifically, whether the code you're rolling back to actually
        still runs against that schema — additive is usually fine; anything the old code can't
        tolerate is not. Take a fresh backup first regardless — see{" "}
        <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link> — and if in doubt,
        restore that backup to a scratch database and boot the older code against it before doing
        the same on the live instance.
      </Callout>

      <h3>Before and after any update</h3>
      <p>Before updating:</p>
      <ul>
        <li>
          Source-based deploys: <code>git status</code> is clean (no uncommitted local changes the
          build would silently pick up or drop).
        </li>
        <li>
          A current, verified backup exists if the update includes schema changes — see{" "}
          <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link>.
        </li>
      </ul>
      <p>
        After updating, work through the same checks as any other health pass — see{" "}
        <strong>Health endpoints</strong> and <strong>Useful commands</strong> above: confirm{" "}
        <code>/ready</code> returns 200, <code>docker compose ps</code> shows the service{" "}
        <code>healthy</code>, and tail recent logs for startup errors or an unexpected absence of{" "}
        <code>selfhost_listening</code> / <code>selfhost_migrations_applied</code>.
      </p>
      <p>
        Neither <code>/health</code> nor <code>/ready</code> reports a version, so confirm the
        deployed release directly — <code>GITTENSORY_IMAGE</code> or <code>SENTRY_RELEASE</code> in{" "}
        <code>.env</code> records what the deploy script just resolved, and{" "}
        <code>docker inspect</code> confirms what the running container actually has:
      </p>
      <CodeBlock
        lang="bash"
        code={`grep -E '^(GITTENSORY_IMAGE|GITTENSORY_VERSION|SENTRY_RELEASE)=' .env
docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q gittensory)"`}
      />

      <p>
        If an operating check fails, go to{" "}
        <Link to="/docs/self-hosting-troubleshooting">Self-host troubleshooting</Link>.
      </p>
    </DocsPage>
  );
}
