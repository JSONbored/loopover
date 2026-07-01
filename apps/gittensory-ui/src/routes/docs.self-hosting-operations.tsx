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
