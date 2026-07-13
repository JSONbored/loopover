import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-operations")({
  head: () => ({
    meta: [
      { title: "Self-host operations — LoopOver docs" },
      {
        name: "description",
        content:
          "Operate the self-hosted LoopOver review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, safe updates/rollback, and clean uninstall/decommissioning.",
      },
      { property: "og:title", content: "Self-host operations — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Operate the self-hosted LoopOver review service: readiness, metrics, logs, dashboards, jobs, queues, routine checks, safe updates/rollback, and clean uninstall/decommissioning.",
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
docker compose logs -f loopover
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

      <h2>Host clock sync (NTP)</h2>
      <Callout variant="warn" title="A single NTP source is a silent single point of failure">
        GitHub App JWTs are signed with a timestamp from this process's clock, backdated 60 seconds
        for skew tolerance. If the host clock drifts past that margin, GitHub starts rejecting the
        JWT as not-yet-valid — <strong>every</strong> GitHub App request fails with a generic{" "}
        <code>Bad credentials</code> error, with no obvious link back to the clock. Configure at
        least two independent NTP sources on the host (not just in the container) so a single dead
        source can't silently take the whole clock out from under you.
      </Callout>
      <p>
        Check sync health with <code>chronyc sources</code> (or <code>ntpq -p</code> on an{" "}
        <code>ntpd</code> host) — every configured source should show a nonzero <code>Reach</code>{" "}
        value; <code>Reach: 0</code> means that source has never successfully synced. The{" "}
        <code>loopover_clock_skew_seconds</code> gauge on the <strong>Clock Sync (NTP)</strong>{" "}
        row of the main Grafana dashboard tracks the live drift between this process and GitHub's
        server time, sampled from the <code>Date</code> header of the GitHub App's own
        installation-token mint calls — no extra network probe required. The bundled Prometheus
        rules alert at 60s (warning) and 120s (critical) drift, both well under the margin that
        actually breaks JWT auth.
      </p>

      <h2>Alerting — required for a 24/7 deployment</h2>
      <p>
        Alertmanager ships with a valid but <strong>silent</strong> default: every alert routes to a
        name-only receiver that discards it, so{" "}
        <code>docker compose --profile observability up -d</code> always starts clean even before
        you've configured anywhere to send notifications. This is intentional — the shipped config
        can&apos;t bake in a Slack/Discord/email destination that works for everyone — but it means
        nothing pages anyone until you enable a real receiver. Treat this as a required step, not an
        optional one, for any deployment you expect to run unattended.
      </p>
      <p>
        Don&apos;t edit the committed <code>alertmanager/alertmanager.yml</code> in place — deploys
        <code>git pull</code> this repo, so a local edit to a tracked file either blocks the next
        pull or gets silently overwritten by it. Instead, copy it to a gitignored{" "}
        <code>alertmanager/alertmanager.local</code> (matches the existing <code>*.local</code>{" "}
        ignore rule) and make your receiver/route changes there — the fastest verified path is
        uncommenting the <code>discord</code> receiver block and pointing the root route at it,
        using <code>webhook_url_file: /etc/alertmanager/discord_url</code> so the webhook URL itself
        lives in its own gitignored file next to it, never in a file docker-compose.yml or git ever
        tracks. Slack, email, and a generic webhook receiver (for PagerDuty or a custom handler) are
        also ready to uncomment in the same template. Then point Alertmanager at your local copy via{" "}
        <code>docker-compose.override.yml</code>:
      </p>
      <CodeBlock
        lang="yaml"
        code={`services:
  alertmanager:
    command:
      - "--config.file=/etc/alertmanager/alertmanager.local"
      - "--storage.path=/alertmanager"`}
      />
      <p>
        Restart with <code>docker compose up -d --no-deps alertmanager</code> to pick up both files.
        The whole <code>alertmanager/</code> directory is mounted read-only into the container, so
        any gitignored file you add there (the local config, a secret file it references) shows up
        at the same path with no docker-compose.yml edit required.
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

      <h2>Two different Discord/Slack integrations</h2>
      <p>
        Don&apos;t confuse these — they're unrelated features that happen to share the same two chat
        platforms:
      </p>
      <FeatureRow
        items={[
          {
            title: "Alertmanager → Discord/Slack (infra alerts)",
            description:
              "Covered above. System/stack health: dead jobs, queue backlog, Postgres pressure, and similar operational alerts, routed by alertmanager/alertmanager.yml.",
          },
          {
            title: "DISCORD_WEBHOOK_URL / SLACK_WEBHOOK_URL (per-PR outcomes)",
            description:
              "A .env-configured webhook the review engine itself posts to whenever it publishes a review outcome (merged, closed, manual hold) on any repo you review — a product notification, not an infra alert.",
          },
        ]}
      />
      <p>
        <code>DISCORD_WEBHOOK_URL</code> is a global fallback Discord channel for any repo without
        its own webhook. <code>DISCORD_REPO_WEBHOOKS</code> is a per-repo override — a JSON map of{" "}
        <code>owner/repo</code> to a webhook URL — for routing different repos' notifications to
        different channels. Both are unset (no Discord notifications) by default.
      </p>
      <CodeBlock
        filename=".env"
        code={`DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_REPO_WEBHOOKS={"owner/repoA":"https://discord.com/api/webhooks/...","owner/repoB":"https://..."}`}
      />
      <p>
        <code>SLACK_WEBHOOK_URL</code> posts the same per-action events (merged/closed/manual) as a
        Block Kit section to one Slack channel. Unlike Discord there is no per-repo map today —
        every repo shares this one webhook. Unset means no Slack notifications.
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
                + <code>--profile gpu</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">Near-zero</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Tens of MiB — a single Go binary shelling out to <code>nvidia-smi</code>
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Estimated. Adds <code>gpu-exporter</code> (nvidia_gpu_exporter) feeding the{" "}
                <code>gpu</code> Prometheus job and the GPU metrics Grafana dashboard — requires the
                NVIDIA Container Toolkit on the host; a device reservation only takes effect once
                this profile is activated, so a non-GPU host is unaffected either way.
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
                Unbounded by default — can still starve the app under CI load
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Bounded by <code>RUNNER_MEM_LIMIT</code> (default 2g) per replica
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Estimated, and explicitly a known risk on the CPU side, not a guess about typical
                usage: the <code>runner</code> service ships with a default memory ceiling (
                <code>RUNNER_MEM_LIMIT</code>, default 2g, added by #3893) but no CPU limit.
                Production experience already documented in{" "}
                <code>docker-compose.override.yml.example</code> found 3 uncapped runner containers
                starving the app for CPU on an 8-vCPU box under real CI load — see that file for the{" "}
                <code>cpu_shares</code>/<code>cpus</code> mitigation before co-locating runners with
                the review stack.
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
        for faster rebuilds. The <code>loopover-docker-safe-prune</code> systemd timer (below)
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
        <code>--profile runners</code>&apos;s CPU side: the service has a default memory ceiling (
        <code>RUNNER_MEM_LIMIT</code>, default 2g) but ships with no CPU limit at all; that is a
        known, documented tradeoff (see the table above and{" "}
        <code>docker-compose.override.yml.example</code>) rather than an oversight, since the right
        CPU ceiling depends entirely on the host's core count and how many runner replicas you run.
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
        code={`sudo cp systemd/loopover-docker-prune.service.example /etc/systemd/system/loopover-docker-prune.service
sudo cp systemd/loopover-docker-prune.timer.example /etc/systemd/system/loopover-docker-prune.timer
sudo $EDITOR /etc/systemd/system/loopover-docker-prune.service   # set WorkingDirectory / ExecStart to your path
sudo systemctl daemon-reload
sudo systemctl enable --now loopover-docker-prune.timer`}
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
      RUNNER_NAME: loopover-runner-2
      RUNNER_SCOPE: \${RUNNER_SCOPE:-repo}
      REPO_URL: \${RUNNER_REPO_URL:-}
      RUNNER_TOKEN: \${RUNNER_TOKEN:-}
      RUNNER_WORKDIR: /tmp/runner
    volumes:
      - runner-work-2:/tmp/runner

volumes:
  runner-work-2:`}
      />

      <h2>Enabling Sentry (your own DSN)</h2>
      <p>
        Sentry is <strong>opt-in and off by default</strong>. Leave <code>SENTRY_DSN</code> unset
        for a complete no-op with negligible overhead — no events leave your box. When you want
        error tracking, point the runtime at a project you control in your own Sentry organization.
      </p>
      <CodeBlock
        filename=".env"
        code={`# Your Sentry project DSN — never commit this to git
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
SENTRY_ENVIRONMENT=production
SENTRY_SERVER_NAME=gittensory-us-east
SENTRY_RELEASE=gittensory-selfhost@2026.07.05
# Optional: sample review tracing spans (0.05 = 5%)
# SENTRY_TRACES_SAMPLE_RATE=0.05`}
      />
      <p>
        Official release images bake <code>GITTENSORY_VERSION</code> as the default release id;
        override with <code>SENTRY_RELEASE</code> when you tag custom builds. Mount secrets with{" "}
        <code>SENTRY_DSN_FILE</code> instead of inline env when you prefer a file-backed DSN. After
        changing Sentry env, restart the <code>loopover</code> service — there is no hot reload.
      </p>
      <Callout variant="note">
        Community self-hosters should send events only to their own DSN. The shipped stack never
        phones home to a maintainer-owned project unless you configure one.
      </Callout>

      <h2>Sentry context taxonomy</h2>
      <p>
        Self-host Sentry events carry a small, scrubbed taxonomy so operators can filter by
        subsystem without opening raw payloads. Structured error logs forwarded from{" "}
        <code>console.error</code> use the JSON <code>event</code> slug as the issue type; direct
        captures use a <code>kind</code> or review <code>operation</code> tag instead.
      </p>
      <FeatureRow
        items={[
          {
            title: "Tags (indexed, low cardinality)",
            description:
              "repo (also indexed when logs emit repository), pr, head_sha, kind, subsystem, jobType, operation, agent, decision_outcome, provider, model, monitor, installation_id_hash (never raw installation id), trace_id, span_id.",
          },
          {
            title: "Contexts (full scrubbed detail)",
            description:
              "gittensory (engine captures), review (failed reviews), log (structured console lines), sentry_monitor (cron failures), otel (active trace ids). Secrets, tokens, bodies, diffs, prompts, and review text are redacted before send.",
          },
          {
            title: "Subsystems",
            description:
              "webhook, queue, github, ai, gate, publish, scheduled, backup, relay — map to the engine paths named in issue #1824.",
          },
        ]}
      />
      <p>
        Cron monitor slugs follow{" "}
        <code>gittensory-selfhost-&#123;environment&#125;-&#123;loop&#125;</code> (for example{" "}
        <code>gittensory-selfhost-production-scheduled-loop</code>). Pair monitor alerts with queue
        depth, dead-job counts, and the matching structured log event.
      </p>

      <h2>Sentry alert classes and runbook</h2>
      <p>
        Tune Sentry alert rules for <strong>persistent failure classes</strong>, not one-off
        fail-open noise. The table below lists actionable signals, what they usually mean, and the
        first checks an operator should run. Prometheus/Grafana alerts in the observability profile
        cover the same failure modes from a metrics angle — use both when Sentry is enabled.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-token-sm">
          <thead>
            <tr className="border-hairline text-left text-token-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Alert class</th>
              <th className="py-2 pr-4 font-medium">Sentry signal</th>
              <th className="py-2 pr-4 font-medium">Threshold guidance</th>
              <th className="py-2 font-medium">First response</th>
            </tr>
          </thead>
          <tbody className="divide-hairline">
            <tr>
              <td className="py-2 pr-4 align-top">Dead-letter growth</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                <code>selfhost_job_dead</code>, <code>queue_pump_crashed</code>, missed{" "}
                <code>queue-dead-letter-revive</code> monitor
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Page when dead jobs stay &gt; 0 for &gt;30m or the revive monitor misses twice
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Check Grafana dead-job panel, <code>/metrics</code>{" "}
                <code>loopover_jobs_dead_total</code>, queue logs; replay from DLQ dashboard only
                after fixing root cause
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Check-run permission gaps</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                <code>check_run_post_denied</code> grouped by repo
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Alert when the same repo hits ≥3 denials in 1h (transient GitHub blips are normal)
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Re-run activation, confirm Checks:write on the GitHub App, verify installation still
                has access to the repo
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">AI provider exhaustion</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                <code>close_breaker_engaged</code>, <code>selfhost_ai_provider</code> errors, review
                failures tagged <code>operation=ai_review</code>
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Warn on first breaker; page when breaker stays engaged &gt;15m or error rate &gt;25%
                of reviews in 1h
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Check provider quotas, <code>AI_*</code> env, CLI availability (
                <code>INSTALL_AI_CLIS</code>), and Grafana AI usage panels
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Relay / broker failures</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                <code>orb_relay_drain</code>, <code>orb_relay_register</code>,{" "}
                <code>orb_broker_unavailable</code>, missed relay monitors
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Page when relay register/drain monitors miss twice or broker errors persist &gt;10m
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Verify Orb enrollment secrets, outbound connectivity, and broker health; check relay
                logs without exposing enrollment material
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Backup failures</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                <code>selfhost_backup_advisory</code>, backup container non-zero exits, stale backup
                freshness metric
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Page when backup freshness &gt;2× <code>BACKUP_INTERVAL_SECONDS</code> or verify
                script fails twice
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Inspect <code>docker compose logs backup</code>, disk space, and{" "}
                <Link to="/docs/self-hosting-backup-scaling">backup docs</Link>; do not delete the
                last good backup after a failed run
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Scheduled monitor misses</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Sentry monitor alert on <code>scheduled-loop</code>, <code>orb-export</code>, or
                other wrapped loops
              </td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Use Sentry&apos;s built-in monitor failure thresholds (2 consecutive misses on most
                loops)
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Process may still be alive but cron work stopped — check{" "}
                <code>selfhost_cron_error</code>, queue pump logs, and restart the app container if
                the loop crashed without taking down the process
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Sentry server name</h2>
      <p>
        <code>SENTRY_SERVER_NAME</code> sets a clean, human name for this instance in Sentry (for
        example <code>gittensory-us-east</code>). Unset defaults to the OS hostname — never the
        public-origin URL. Set this explicitly if you run more than one instance and want to tell
        their Sentry events apart at a glance instead of matching container hostnames.
      </p>

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
        Monitor loop slugs (the <code>&#123;loop&#125;</code> segment in the slug) are{" "}
        <code>scheduled-loop</code>, <code>orb-export</code>, <code>orb-relay-drain</code>,{" "}
        <code>orb-relay-register</code>, and <code>queue-dead-letter-revive</code>. A missed monitor
        means the process may still be alive but the recurring work is not checking in on schedule.
        Pair the monitor with queue depth, dead-job counts, and the structured error log for the
        same subsystem.
      </p>

      <h2>Grafana Sentry data source (in-Grafana issue visualization)</h2>
      <p>
        Query recent Sentry issues, top issues by event count, and error-volume trend directly in
        Grafana — no more switching tabs to check Sentry, and errors line up in time with the rest
        of the stack&apos;s metrics/logs/traces. This is read-only visualization; alert routing to
        Sentry/Discord/Slack is a separate, unrelated concern covered above.
      </p>
      <Callout variant="warn" title="SENTRY_DSN is NOT reusable here">
        The <code>SENTRY_DSN</code> above authenticates event <strong>ingestion</strong> (sending
        errors to Sentry), not the read/query API this data source needs. You need a separate{" "}
        <strong>Sentry Internal Integration token</strong>: Sentry → Settings → Developer Settings →
        Custom Integrations → New Internal Integration (requires an Admin/Manager/Owner role in
        Sentry), with <strong>Read</strong> access on the <strong>Project</strong>,{" "}
        <strong>Issue &amp; Event</strong>, and <strong>Organization</strong> resource scopes.
      </Callout>
      <p>
        The{" "}
        <a
          href="https://grafana.com/grafana/plugins/grafana-sentry-datasource/"
          target="_blank"
          rel="noreferrer"
        >
          grafana-sentry-datasource
        </a>{" "}
        plugin installs automatically (<code>GF_INSTALL_PLUGINS</code>, same mechanism as the GitHub
        data source below). Add the data source itself after Grafana is up — a backend datasource
        whose token isn&apos;t ready at Grafana&apos;s own boot time would crash file-based
        provisioning, so this one is added over the API instead, exactly like the GitHub data
        source:
      </p>
      <CodeBlock
        filename=".env"
        code={`SENTRY_API_TOKEN=<your-sentry-internal-integration-token>
SENTRY_ORG_SLUG=<your-sentry-org-slug>
# SENTRY_API_URL=https://sentry.io   # override only for a self-hosted Sentry instance`}
      />
      <CodeBlock lang="bash" code={`./scripts/setup-sentry-datasource.sh`} />
      <p>
        The script is idempotent — safe to re-run after rotating the token. Open the{" "}
        <strong>Sentry issues</strong> dashboard once it succeeds. Same trade-off as the GitHub data
        source: this one is API-managed, so it stays editable via the Grafana UI rather than locked
        read-only like the file-provisioned data sources.
      </p>

      <h2>Re-gate sweeps (agent-regate-sweep)</h2>
      <p>
        Live PR review is webhook-driven, but open PRs still need periodic re-evaluation — the base
        branch moves, duplicate clusters resolve, settings change, and approved PRs can sit unmerged
        until CI re-runs. A scheduled sweep (<code>agent-regate-sweep</code>, every ~2 minutes on
        the maintenance tick) fans out lightweight <code>agent-regate-pr</code> jobs for the stalest
        open PRs per repo (cap <code>SWEEP_MAX_PRS=3</code> by default, REST-budget sized).
      </p>
      <FeatureRow
        items={[
          {
            title: "What it recomputes",
            description:
              "Gate verdict + auto-maintain actions for open, non-draft PRs the webhook has not refreshed recently. Does not re-run AI unless the live pipeline would.",
          },
          {
            title: "How candidates are picked",
            description:
              "Sorted by lastRegatedAt ascending (stalest first), skipping PRs a webhook touched within ~2 minutes. Dry-run suppresses GitHub writes but still advances lastRegatedAt so coverage keeps moving.",
          },
          {
            title: "Backlog-convergence companion",
            description:
              "A separate backlog-convergence-sweep repairs PRs whose public review surface (comment/check/label) never published for the current head — a case the main sweep can miss when a per-PR job dead-letters after fan-out.",
          },
        ]}
      />
      <p>
        Log markers: <code>regate_sweep_throttled</code> (sweep temporarily paused),{" "}
        <code>regate_sweep_trigger_backlog_deferred</code> (prior regate work still draining —
        avoids piling duplicate fan-outs). In metrics, break down deferrals by{" "}
        <code>job_type=agent-regate-pr</code> or <code>agent-regate-sweep</code> when GitHub
        rate-limit pressure spikes.
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
        Day-two operator flow: pull or build a new app image, restart only the <code>loopover</code>{" "}
        service, verify <code>/ready</code>, and confirm the release id. Use{" "}
        <Link to="/docs/self-hosting-releases">Releases and images</Link> to pick a tag; use the
        checklists below so updates never overwrite operator-owned secrets, config, or data.
      </p>

      <Callout variant="safety" title="Operator-owned — deploy scripts never overwrite these">
        <ul>
          <li>
            <code>.env</code> and any <code>*_FILE</code> secret mounts — deploy scripts only write
            back <code>GITTENSORY_IMAGE</code> (image path) or <code>SENTRY_RELEASE</code> /{" "}
            <code>GITTENSORY_VERSION</code> (source path).
          </li>
          <li>
            <code>./gittensory-config/</code> bind mount — private per-repo{" "}
            <code>.gittensory.yml</code> policy.
          </li>
          <li>
            Named data volumes — especially <code>loopover-data</code> (SQLite DB, Codex/Claude auth
            under <code>/data</code>), <code>loopover-pg</code>, <code>qdrant-data</code>,{" "}
            <code>loopover-backups</code>, and Grafana&apos;s <code>grafana-data</code>.
          </li>
          <li>
            Optional <code>docker-compose.override.yml</code> — still loaded via{" "}
            <code>SELFHOST_COMPOSE_FILES</code> when set, or automatically when present beside{" "}
            <code>docker-compose.yml</code>.
          </li>
        </ul>
      </Callout>

      <FeatureRow
        items={[
          {
            title: "Restart loopover only (normal app update)",
            description:
              "Both deploy-selfhost-image.sh and deploy-selfhost-prebuilt.sh run docker compose up -d --no-deps loopover. Redis, Postgres, Qdrant, Grafana, backup sidecars, and every volume stay running with their existing data.",
          },
          {
            title: "Recreate a profile service (separate step)",
            description:
              "Only when you deliberately change that service's image or major version — e.g. docker compose --profile postgres pull postgres && docker compose --profile postgres up -d postgres. Never required just to ship a new loopover app build.",
          },
        ]}
      />

      <h3>Preflight checklist</h3>
      <ol>
        <li>
          Read release notes for migration or env changes — migrations are forward-only (see
          Rollback below).
        </li>
        <li>
          Take a fresh backup when the release may change schema — see{" "}
          <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link>.
        </li>
        <li>
          Source path only: confirm <code>git status</code> is clean (no uncommitted local changes
          the build would silently pick up). An ad-hoc snapshot like{" "}
          <code>cp docker-compose.yml docker-compose.yml.bak-notes-20260707</code> does not count
          against this — the trailing <code>*.bak-*</code>/<code>*.backup-*</code> patterns in{" "}
          <code>.gitignore</code> keep stray manual backups out of <code>git status</code> entirely,
          on top of the narrower <code>gittensory-config.backup-*/</code> and{" "}
          <code>.deploy-backups/</code> patterns that already covered those specific directories.
          <code>scripts/selfhost-update.sh</code> (below) checks this for you and refuses to
          continue on a dirty tree.
        </li>
        <li>
          Image path only: note the current tag or digest from <code>docker inspect</code> on the
          running <code>loopover</code> container so rollback has a known-good target.
        </li>
        <li>
          Confirm routine health is green before you start —{" "}
          <code>curl http://localhost:8787/ready</code> and a quick <code>docker compose ps</code>.
        </li>
      </ol>

      <h3>Path 1: pull a published image</h3>
      <p>
        <code>scripts/deploy-selfhost-image.sh</code> pulls a tag or digest, restarts only the{" "}
        <code>loopover</code> service, waits for it to report <code>healthy</code> via{" "}
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
        <code>scripts/selfhost-update.sh</code> is the recommended entry point for a Git-backed
        source checkout (#1660) — it is the single command that turns <code>git fetch</code> +
        fast-forward + rebuild + verify into one flow, instead of an operator having to remember the
        right order:
      </p>
      <CodeBlock lang="bash" code={`./scripts/selfhost-update.sh`} />
      <p>
        It refuses to continue, with a clear error and no side effects, on any of the three things
        that make a plain <code>git pull</code> unsafe to script blindly: the working tree is not
        clean, the checkout is not on the expected branch (<code>main</code> by default), or local
        history has diverged from <code>origin/main</code> in a way that is not a fast-forward (
        <code>git merge --ff-only</code> — it never rebases, force-merges, or picks a side for you).
        Only once the fast-forward succeeds does it call{" "}
        <code>scripts/deploy-selfhost-prebuilt.sh</code> (below) to rebuild and restart, then{" "}
        <code>scripts/selfhost-post-update-check.sh</code> to verify health — so a normal update is
        one command and a failure at any step stops before the next one runs.
      </p>
      <p>
        None of this touches operator-owned state: <code>.env</code>, the{" "}
        <code>gittensory-config/</code> mount, <code>.deploy-backups/</code>, any{" "}
        <code>*.local</code> or <code>docker-compose.local-*.yml</code> compose override, or
        Alertmanager file, and every named data volume are already gitignored or outside the source
        tree entirely, so a fetch-and-rebuild never touches them. See the{" "}
        <Link to="/docs/self-hosting-quickstart">Quickstart</Link> for the initial clone; this
        script assumes that checkout already exists and already tracks <code>origin/main</code>.
      </p>
      <CodeBlock
        lang="bash"
        code={`# Point at a fork remote or a non-default branch (e.g. testing a release candidate branch)
SELFHOST_UPDATE_REMOTE=upstream SELFHOST_UPDATE_BRANCH=main ./scripts/selfhost-update.sh

# Skip the health probe step (e.g. you'll run it yourself, or right after a schema-changing release
# where you want to inspect logs before curling /ready)
SELFHOST_SKIP_POST_UPDATE_CHECK=1 ./scripts/selfhost-update.sh`}
      />
      <p>
        Want finer control — a pinned <code>SENTRY_RELEASE</code>, a Sentry source-map upload, or to
        fetch and rebuild as separate manual steps? Call the two scripts it wraps directly:
      </p>
      <CodeBlock
        lang="bash"
        code={`git fetch origin
git merge --ff-only origin/main
./scripts/deploy-selfhost-prebuilt.sh`}
      />
      <p>
        <code>scripts/deploy-selfhost-prebuilt.sh</code> is the actual rebuild step (this is how{" "}
        <code>GITTENSORY_VERSION</code> ends up as a short git SHA instead of an image tag). It
        builds the bundle inside a Dockerized Node container — the host itself never needs Node or
        npm installed — then restarts only the <code>loopover</code> service the same way as the
        image path. <code>SENTRY_RELEASE</code> defaults to{" "}
        <code>gittensory-selfhost@&lt;short git SHA of the current HEAD&gt;</code> unless you
        override it, so each deploy from a new commit gets a distinct release id automatically. When{" "}
        <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_ORG</code>, and <code>SENTRY_PROJECT</code> are
        all configured, the script also injects and uploads Sentry source maps for that release
        before restarting the service (set <code>SELFHOST_SKIP_SENTRY_UPLOAD=1</code> to skip this
        even when those three are present).
      </p>

      <h3>Post-update checklist</h3>
      <p>
        <code>scripts/selfhost-update.sh</code> already runs the health probe below for you unless
        you set <code>SELFHOST_SKIP_POST_UPDATE_CHECK=1</code>. Run it manually after the image
        path, after calling the two wrapped scripts directly, or after any manual{" "}
        <code>docker compose</code> update.
      </p>
      <ol>
        <li>
          Wait for the deploy script&apos;s health wait to finish (or run the helper below if you
          updated manually with plain <code>docker compose</code>).
        </li>
        <li>
          <code>curl http://localhost:8787/ready</code> returns HTTP 200.
        </li>
        <li>
          <code>docker compose ps loopover</code> shows <code>healthy</code>.
        </li>
        <li>
          Tail logs for <code>selfhost_listening</code> and, on first boot after a schema bump,{" "}
          <code>selfhost_migrations_applied</code> — not <code>selfhost_job_dead</code>.
        </li>
        <li>
          Confirm the release id — neither <code>/health</code> nor <code>/ready</code> exposes a
          version string; check <code>.env</code> and the running container image instead.
        </li>
      </ol>
      <CodeBlock
        lang="bash"
        code={`./scripts/selfhost-post-update-check.sh
# equivalent manual checks:
curl -sf http://localhost:8787/ready
docker compose ps loopover
grep -E '^(GITTENSORY_IMAGE|GITTENSORY_VERSION|SENTRY_RELEASE)=' .env
docker inspect --format '{{.Config.Image}}' "$(docker compose ps -q loopover)"`}
      />
      <p>
        If any check fails, see <Link to="/docs/self-hosting-troubleshooting">Troubleshooting</Link>
        .
      </p>

      <h3>Rollback: no dedicated command</h3>
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

      <h2>Uninstalling and decommissioning</h2>
      <p>
        Tearing an instance down cleanly touches four independent things: the GitHub App
        installation, the data volumes, brokered-mode enrollment, and control-panel access. None of
        this is scripted today — do each step deliberately, in this order, and decide what to keep
        before you delete anything.
      </p>

      <h3>1. Revoke the GitHub App installation</h3>
      <p>
        Uninstalling stops GitHub from sending any further webhook events and immediately revokes
        the App&apos;s installation tokens — nothing on the self-host side needs to be told; there
        is no <code>installation</code> <code>deleted</code> webhook handler to run first. From the
        repo or org: Settings → Integrations → GitHub Apps → your App → Uninstall. Do this before
        stopping the container so you are not left with a dangling install pointed at a dead webhook
        URL.
      </p>
      <p>
        If you only want to pause reviews without losing the App&apos;s configuration (permissions,
        webhook URL, private key), suspend the installation instead of uninstalling it — GitHub
        stops delivering events to a suspended install but keeps everything else intact for a later
        resume.
      </p>

      <h3>2. Decide what happens to the data volumes</h3>
      <p>
        Stopping the container does not delete anything — <code>docker compose stop</code> or{" "}
        <code>docker compose down</code> (without <code>-v</code>) leaves every named volume (
        <code>loopover-data</code>, <code>loopover-pg</code>, <code>qdrant-data</code>,{" "}
        <code>loopover-backups</code>, <code>grafana-data</code>, and the rest declared in{" "}
        <code>docker-compose.yml</code>) on disk, along with the <code>./gittensory-config</code>{" "}
        host directory (a bind mount, not a named volume, so it is never affected by <code>-v</code>{" "}
        either way). Pick one:
      </p>
      <FeatureRow
        items={[
          {
            title: "Keep (pause, don't decommission)",
            description:
              "docker compose stop. Volumes and .env stay as-is; restarting later resumes with the same data. Use this if you might come back.",
          },
          {
            title: "Export, then delete",
            description:
              "Run the backup profile one last time (docker compose --profile backup up -d, then confirm with verify-backup.sh — see Backup and scaling) and copy the resulting archive off-host before removing anything.",
          },
          {
            title: "Delete everything",
            description:
              "docker compose down -v removes every named volume permanently — the review database, vector index, Grafana dashboards state, and any local backup archives in loopover-backups go with it. This does not touch ./gittensory-config (delete that host directory yourself if it should go too).",
          },
        ]}
      />
      <Callout variant="warn" title="down -v is irreversible without an existing backup">
        If you have not exported a backup off-host first, <code>docker compose down -v</code>{" "}
        permanently destroys review history, settings, and the vector index with no recovery path —
        the volumes are the only copy. See{" "}
        <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link> before running it on
        an instance you care about.
      </Callout>

      <h3>3. Deregister from the Orb broker (brokered mode only)</h3>
      <p>
        If this instance runs in brokered mode (<code>ORB_ENROLLMENT_SECRET</code> is set — see{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>), be aware there is{" "}
        <strong>no self-service revocation endpoint today</strong> — the &quot;Minimum broker
        safeguards&quot; checklist on that page lists a revocation path as a prerequisite for a
        public brokered rollout that has not shipped yet. An enrollment record (
        <code>orb_enrollments</code>) lives in LoopOver&apos;s own central database, not your
        container, and nothing in this codebase writes a <code>revoked_at</code> value to it outside
        of tests. Practical steps until that exists:
      </p>
      <ul>
        <li>
          Uninstalling the GitHub App (step 1) stops new webhook traffic and installation-token
          issuance from reaching your instance in practice, even though the enrollment row itself
          stays marked enrolled centrally.
        </li>
        <li>
          Stop the container and let <code>ORB_ENROLLMENT_SECRET</code> go with it — with nothing
          polling or listening, the secret is inert even if it still resolves to a valid enrollment.
        </li>
        <li>
          If the secret may have leaked or you want it invalidated outright rather than just
          orphaned, treat this the same as any other suspected credential compromise: contact the
          Orb operator to have the enrollment revoked centrally, since there is no in-product way to
          do it yourself yet.
        </li>
      </ul>

      <h3>4. Remove ADMIN_GITHUB_LOGINS access</h3>
      <p>
        <code>ADMIN_GITHUB_LOGINS</code> is read fresh from the environment on every control-panel
        request (<code>isAuthorizedGitHubSessionLogin</code> in <code>src/auth/security.ts</code>) —
        it is never cached at startup or baked into an issued session. To remove someone&apos;s
        operator access, delete their login from the comma/whitespace-separated list in{" "}
        <code>.env</code> and restart the <code>loopover</code> service so the process picks up the
        new value:
      </p>
      <CodeBlock
        lang="bash"
        code={`$EDITOR .env   # remove the login from ADMIN_GITHUB_LOGINS
docker compose up -d --no-deps loopover`}
      />
      <p>
        This takes effect on their very next control-panel request after the restart — no signed-in
        session is grandfathered in, because authorization is re-checked against the current
        allowlist every time, not read from the session itself. If you are decommissioning the whole
        instance rather than removing one operator, this step is moot once the container is stopped.
      </p>
    </DocsPage>
  );
}
