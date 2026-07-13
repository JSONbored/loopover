import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-troubleshooting")({
  head: () => ({
    meta: [
      { title: "Self-host troubleshooting — LoopOver docs" },
      {
        name: "description",
        content:
          "Troubleshoot self-hosted LoopOver reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, GitHub rate limits, Qdrant, Orb, AI provider circuit breakers, and readiness failures.",
      },
      { property: "og:title", content: "Self-host troubleshooting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Troubleshoot self-hosted LoopOver reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, GitHub rate limits, Qdrant, Orb, AI provider circuit breakers, and readiness failures.",
      },
      { property: "og:url", content: "/docs/self-hosting-troubleshooting" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-troubleshooting" }],
  }),
  component: SelfHostingTroubleshooting,
});

function SelfHostingTroubleshooting() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Troubleshooting"
      description="Start with readiness and logs, then isolate webhook, queue, AI, REES, RAG, or write-suppression problems."
    >
      <h2>First checks</h2>
      <CodeBlock
        lang="bash"
        code={`docker compose ps
docker compose logs --tail=200 loopover
curl http://localhost:8787/ready
curl http://localhost:8787/metrics`}
      />

      <h2>No review appears</h2>
      <FeatureRow
        items={[
          {
            title: "Webhook",
            description:
              "Check GitHub App deliveries and confirm /v1/github/webhook receives 2xx responses.",
          },
          {
            title: "Allowlist",
            description: "Confirm the repo is in LOOPOVER_REVIEW_REPOS for per-PR features.",
          },
          {
            title: "Write mode",
            description:
              "SELFHOST_DEPLOYMENT_MODE=dry-run or disabled suppresses writes even when review computes.",
          },
          {
            title: "Policy",
            description:
              "gate.aiReview.mode=off or commentMode=off can make AI/comment output intentionally quiet.",
          },
        ]}
      />

      <h2>AI summary unavailable</h2>
      <ul>
        <li>
          Confirm <code>AI_PROVIDER</code> is set and supported.
        </li>
        <li>Confirm the provider key or local endpoint works from inside the container.</li>
        <li>
          Set the matching provider model env, such as <code>ANTHROPIC_AI_MODEL</code>,{" "}
          <code>OPENAI_COMPATIBLE_AI_MODEL</code>, <code>OLLAMA_AI_MODEL</code>,{" "}
          <code>CLAUDE_AI_MODEL</code>, or <code>CODEX_AI_MODEL</code>.
        </li>
        <li>
          Increase the matching provider timeout env, such as <code>CLAUDE_AI_TIMEOUT_MS</code> or{" "}
          <code>CODEX_AI_TIMEOUT_MS</code>, for large subscription-CLI reviews.
        </li>
        <li>For CLI providers, confirm the CLI binary and credential path are available.</li>
      </ul>

      <h2>REES is silent</h2>
      <p>
        A no-finding REES response can be intentionally invisible. For failures, search logs for
        <code>review_context_fetch_failed</code> with <code>contextType</code> set to{" "}
        <code>enrichment</code>.
      </p>
      <CodeBlock
        code={`review_context_fetch_failed
rees_analyzer_config_invalid`}
      />
      <p>
        Check <Link to="/docs/self-hosting-rees">REES enrichment</Link> for enablement and{" "}
        <Link to="/docs/self-hosting-rees-analyzers">REES analyzer reference</Link> for analyzer
        names, network calls, and token requirements.
      </p>

      <h2>RAG returns no context</h2>
      <ul>
        <li>
          Confirm <code>LOOPOVER_REVIEW_RAG=true</code>, the repo is in{" "}
          <code>LOOPOVER_REVIEW_REPOS</code> (or has <code>features.rag: true</code> in private
          config), and RAG indexing has run — see{" "}
          <Link to="/docs/self-hosting-configuration">Configuration</Link> for the three activation
          layers (<code>is_registered</code> is only required for Gittensor-scored paths, not RAG on
          a self-host allowlist).
        </li>
        <li>Confirm Qdrant or the vector backend is reachable from the app container.</li>
        <li>Confirm the embedding endpoint and model are running.</li>
        <li>Confirm the repo has been indexed after enabling the feature.</li>
      </ul>

      <h2>Queue stuck or dead jobs</h2>
      <p>
        Watch pending, processed, failed, and dead metrics. A high pending count can be webhook
        replay or maintenance work; dead jobs need direct investigation.
      </p>
      <CodeBlock
        lang="bash"
        code={`curl http://localhost:8787/metrics | grep loopover_queue
docker compose logs loopover | grep selfhost_job_dead`}
      />

      <h2>GitHub rate-limit responses or admission deferrals</h2>
      <p>
        Two independent signals cover this:{" "}
        <code>loopover_github_rest_rate_limit_responses_total</code> counts actual 403/429 responses
        from GitHub, and the <code>loopover_jobs_rate_limit_admission_deferred_total</code> /{" "}
        <code>loopover_jobs_rate_limit_budget_deferred_total</code> /{" "}
        <code>loopover_jobs_rate_limited_by_type_total</code> counters track jobs the queue itself
        held back <em>before</em> making a request, to avoid tripping a limit. All three job-side
        counters carry the same three labels — <code>kind</code> (<code>webhook</code> or{" "}
        <code>background</code>), <code>key_scope</code> (<code>installation</code>,{" "}
        <code>public</code>, <code>global</code>, or <code>other</code>), and <code>job_type</code>{" "}
        (the queue job's type, e.g. <code>agent-regate-pr</code>) — so you can break a spike down to
        exactly which token pool and which job type is under pressure.
      </p>
      <p>
        A short burst of deferrals is expected and self-resolving: the queue is deliberately trading
        a few seconds of delay to avoid a real 429. Treat it as a real problem only once it&apos;s
        <strong> sustained</strong> — which is exactly what{" "}
        <code>LoopoverGitHubRateLimitResponses</code> (real 403/429s observed) and{" "}
        <code>LoopoverQueueRateLimitDeferralsHigh</code> (a sustained deferral rate, not a blip) are
        tuned to alert on, rather than firing on every brief admission hold.
      </p>
      <CodeBlock
        lang="promql"
        code={`# Deferrals broken down by token pool and job type over the last 10m
sum by (key_scope, job_type) (rate(loopover_jobs_rate_limit_admission_deferred_total[10m]))

# Is one key_scope (e.g. a single installation token) the bottleneck?
topk(5, sum by (key_scope) (rate(loopover_jobs_rate_limit_budget_deferred_total[10m])))

# Real rate-limit responses from GitHub itself (not just internal deferrals)
sum(rate(loopover_github_rest_rate_limit_responses_total[10m]))`}
      />
      <p>
        If a single <code>key_scope=installation</code> pool is consistently the bottleneck, the fix
        is usually spreading load across more installation tokens (fewer repos per installation) or
        raising the GitHub App&apos;s own rate-limit tier, not code changes here.
      </p>

      <h2>Low GitHub response-cache hit rate</h2>
      <p>
        <code>loopover_github_response_cache_total</code> (REST) and{" "}
        <code>loopover_github_graphql_cache_total</code> (GraphQL) both carry a <code>result</code>{" "}
        label — <code>hit</code>, <code>miss</code>, <code>set</code>, <code>coalesced</code>,{" "}
        <code>bypassed</code>, or <code>error</code> — and a <code>class</code> label identifying
        the endpoint family. A healthy cache should show most traffic as <code>hit</code> for
        endpoints that are read repeatedly in one review/maintenance pass (PR reads, check-run
        lookups); a low hit rate on those specific classes, not the overall average, is the useful
        signal.
      </p>
      <CodeBlock
        lang="promql"
        code={`# REST hit rate by endpoint class over the last 15m
sum by (class) (rate(loopover_github_response_cache_total{result="hit"}[15m]))
/
sum by (class) (rate(loopover_github_response_cache_total[15m]))

# GraphQL hit rate — same shape, separate metric
sum by (class) (rate(loopover_github_graphql_cache_total{result="hit"}[15m]))
/
sum by (class) (rate(loopover_github_graphql_cache_total[15m]))`}
      />

      <h2>Qdrant / vector-store errors</h2>
      <p>
        <code>loopover_qdrant_errors_total</code> carries an <code>op</code> label (
        <code>upsert</code>, <code>query</code>, or <code>delete</code>) so you can tell whether
        indexing or retrieval is failing. <code>LoopoverQdrantErrorRateHigh</code> fires on a
        sustained error ratio, not an isolated blip.
      </p>
      <ul>
        <li>
          Confirm <code>QDRANT_URL</code> (e.g. <code>http://qdrant:6333</code>) is reachable from
          the app container and the <code>qdrant</code> Compose profile is running.
        </li>
        <li>
          If Qdrant requires auth, confirm <code>QDRANT_API_KEY</code> is set and matches the Qdrant
          deployment&apos;s configuration.
        </li>
        <li>
          A dimension-mismatch error means the existing <code>gittensory</code> collection (the
          fixed collection name self-host always uses) was created with a different embedding model
          than the one currently configured (<code>AI_EMBED_MODEL</code>). Recreating it — delete
          the collection and let the next index run recreate it at the current width — is the fix,
          but it temporarily removes ALL indexed RAG context for every repo until re-indexing
          completes, so treat it as a deliberate, disruptive step, not a routine one.
        </li>
      </ul>
      <CodeBlock
        lang="bash"
        code={`curl "$QDRANT_URL/collections/gittensory"
docker compose --profile qdrant ps qdrant

# Only after confirming a dimension mismatch is the actual cause:
curl -X DELETE "$QDRANT_URL/collections/gittensory"`}
      />

      <h2>Orb export or relay problems</h2>
      <p>
        For brokered self-host deployments, <code>loopover_orb_events_exported_total</code> and{" "}
        <code>loopover_orb_export_errors_total</code> track the hourly outcome-export loop;{" "}
        <code>LoopoverOrbExportErrorRateHigh</code> fires on a sustained error ratio there. The
        pull-mode relay loop (for installations receiving events outbound from Orb) reports through{" "}
        <code>loopover_orb_relay_drains_total</code> (<code>result=events</code> when it drained
        something, <code>result=empty</code> otherwise) and <code>loopover_orb_webhook_total</code>{" "}
        (<code>event</code> + <code>result</code> labels) for what happened to each relayed event
        once enqueued locally.
      </p>
      <p>
        If exports are failing but the relay itself looks healthy, the export loop&apos;s Sentry
        cron monitor (see <Link to="/docs/self-hosting-operations">Self-host operations</Link>) is
        the fastest way to confirm whether the loop is even running, before digging into the error
        counters.
      </p>
      <p>
        <code>selfhost_orb_relay_register_failed</code> means the container could not announce
        itself to the broker at boot. What it means depends on <code>ORB_RELAY_MODE</code> (see{" "}
        <Link to="/docs/self-hosting-github-app">choosing a relay mode</Link>):
      </p>
      <ul>
        <li>
          <strong>Push mode</strong> (default) — logged at <code>error</code> and{" "}
          <strong>release-blocking</strong>: the container looks healthy but never receives an
          event, since there is no fallback delivery path. Check that <code>PUBLIC_API_ORIGIN</code>{" "}
          is a real, internet-reachable, TLS-terminated URL — the broker rejects a loopback or
          private address at registration time, so a misconfigured or unreachable origin fails here
          every time, not intermittently.
        </li>
        <li>
          <strong>Pull mode</strong> — logged at <code>warn</code> and non-fatal: the drain loop (
          <code>loopover_orb_relay_drains_total</code>) keeps retrying on its own schedule
          regardless, so a transient failure here recovers on its own once the broker is reachable
          again. A registration failure that never clears across many retries still points at{" "}
          <code>ORB_ENROLLMENT_SECRET</code> being wrong, revoked, or not yet provisioned
          server-side.
        </li>
      </ul>
      <p>
        Either mode: confirm <code>ORB_BROKER_URL</code> is reachable from inside the container
        first — a broker that is down or unreachable produces the same registration-failed event
        regardless of relay mode or credential correctness.
      </p>

      <h2>AI provider circuit breaker keeps opening</h2>
      <p>
        Each AI provider (self-host <code>AI_PROVIDER</code> entries) has its own circuit breaker:
        after 3 consecutive failures it stops attempting real calls to that provider for 60 seconds,
        recorded as <code>loopover_ai_provider_circuit_open_total{'{provider="..."}'}</code>{" "}
        (skipped calls) alongside{" "}
        <code>loopover_ai_provider_failures_total{'{provider="..."}'}</code> (real failures). It
        self-heals automatically — there is no manual reset — but it will reopen immediately if the
        underlying problem is still there.
      </p>
      <ul>
        <li>
          Search logs for <code>circuit_open: provider "..."</code> to confirm which provider
          tripped, and <code>selfhost_ai_provider_failed_in_chain</code> for the real error each
          failed attempt hit before the breaker opened.
        </li>
        <li>
          A provider that keeps re-tripping after its cooldown almost always means a persistent
          problem, not a transient blip: an expired/invalid API key, a CLI binary missing from the
          image (see <code>selfhost_ai_cli_missing</code> at boot), or the endpoint being genuinely
          unreachable from the container.
        </li>
        <li>
          <code>LoopoverAiProviderCircuitOpen</code> fires on any circuit-open event in a 15-minute
          window — a single trip during a real but brief outage is expected; a rule that keeps
          firing across multiple windows points at the persistent case above.
        </li>
      </ul>

      <h2>Grafana metrics/dashboards show no data</h2>
      <p>
        The metrics path is the app's own <code>/metrics</code> (scraped directly by Prometheus)
        plus, for Claude Code's OTEL telemetry specifically, app or smoke process → OTEL collector →
        its Prometheus exporter (<code>:8889</code>) → Prometheus.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile observability ps prometheus otel-collector grafana
docker compose logs --tail=80 prometheus otel-collector grafana

# Send one synthetic OTLP metric through the collector, read it back from its Prometheus exporter,
# and sanity-check the app's own /metrics HELP/TYPE shape.
npm run test:smoke:observability:metrics`}
      />
      <ul>
        <li>
          If the smoke command fails at <code>otel-collector:4318/v1/metrics</code>, the collector
          is not reachable from the app container.
        </li>
        <li>
          If it pushes successfully but cannot read it back from{" "}
          <code>otel-collector:8889/metrics</code>, the collector's Prometheus exporter is unhealthy
          or the pipeline in <code>otel/otel-collector-config.yml</code> is misconfigured.
        </li>
        <li>
          If the app's own <code>/metrics</code> check fails, that is unrelated to the OTEL
          collector — check the app container directly (<code>docker compose logs loopover</code>
          ).
        </li>
        <li>
          If the smoke command passes but a Grafana dashboard panel is still blank, check that
          panel's own PromQL expression against a metric name actually emitted in <code>src/</code>{" "}
          — a renamed or removed metric a dashboard still references renders as a permanent
          zero/no-data, not an error.
        </li>
      </ul>

      <h2>Grafana traces error or show no data</h2>
      <p>
        The trace path is app or smoke process → OTEL collector → Tempo → Grafana. Tempo is only
        started by the observability profile, and app traces are only emitted when{" "}
        <code>OTEL_TRACES_EXPORTER</code> includes <code>otlp</code>.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose --profile observability ps tempo otel-collector grafana
docker compose logs --tail=80 tempo otel-collector grafana

# Send one synthetic span through the collector and read it back from Tempo.
npm run test:smoke:observability`}
      />
      <ul>
        <li>
          If the smoke command fails at <code>otel-collector:4318/v1/traces</code>, the collector is
          not reachable from the app container.
        </li>
        <li>
          If it pushes successfully but cannot read{" "}
          <code>tempo:3200/api/traces/&lt;trace_id&gt;</code>, Tempo is unhealthy, not ingesting, or
          not sharing the Compose network.
        </li>
        <li>
          If the smoke command passes but Grafana Explore fails, check the Tempo data source URL. It
          should point at <code>http://tempo:3200</code>, not the OTLP ingest ports.
        </li>
        <li>
          For a temporary live debugging run, set <code>OTEL_TRACES_SAMPLER_ARG=1</code> so every
          root trace is sampled, then lower it again after diagnosis.
        </li>
      </ul>

      <h2>Readiness fails</h2>
      <FeatureRow
        items={[
          {
            title: "DB",
            description:
              "Check DATABASE_URL or DATABASE_PATH, volume permissions, Postgres reachability, and migrations.",
          },
          {
            title: "Migrations",
            description: "Read startup logs for migration errors before recreating volumes.",
          },
          {
            title: "Dependencies",
            description:
              "If Qdrant or Postgres profiles are enabled, confirm those services are healthy first.",
          },
        ]}
      />
    </DocsPage>
  );
}
