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
      <CodeBlock lang="bash" code={`docker compose --profile observability up -d`} />

      <h2>Routine checks</h2>
      <ul>
        <li>Queue pending count is not growing without processing.</li>
        <li>Dead jobs stay at zero or are investigated promptly.</li>
        <li>Webhook deliveries are recent and have 2xx responses.</li>
        <li>AI usage matches expected review volume and model/effort choices.</li>
        <li>REES and RAG failures are visible and bounded.</li>
        <li>Backups are recent and restore-tested.</li>
      </ul>

      <p>
        If an operating check fails, go to{" "}
        <Link to="/docs/self-hosting-troubleshooting">Self-host troubleshooting</Link>.
      </p>
    </DocsPage>
  );
}
