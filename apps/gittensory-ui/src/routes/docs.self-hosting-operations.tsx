import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-operations")({
  head: () => ({
    meta: [
      { title: "Self-host operations — Gittensory docs" },
      {
        name: "description",
        content:
          "Operate the self-hosted Gittensory review service: readiness, metrics, logs, dashboards, jobs, queues, and routine checks.",
      },
      { property: "og:title", content: "Self-host operations — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Operate the self-hosted Gittensory review service: readiness, metrics, logs, dashboards, jobs, queues, and routine checks.",
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
review_context_fetch_failed`}
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
        <li>Webhook deliveries are recent and have 2xx responses.</li>
        <li>AI usage matches expected review volume and model/effort choices.</li>
        <li>REES and RAG failures are visible and bounded.</li>
        <li>
          Postgres connections, lock waits, slow transactions, dead tuples, and table growth are
          stable.
        </li>
        <li>Backups are recent and restore-tested.</li>
      </ul>

      <p>
        If an operating check fails, go to{" "}
        <Link to="/docs/self-hosting-troubleshooting">Self-host troubleshooting</Link>.
      </p>
    </DocsPage>
  );
}
