import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/troubleshooting")({
  head: () => ({
    meta: [
      { title: "Troubleshooting — LoopOver docs" },
      {
        name: "description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:title", content: "Troubleshooting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Diagnose MCP/CLI issues with doctor, status, and whoami. Common errors and fixes.",
      },
      { property: "og:url", content: "/docs/troubleshooting" },
    ],
    links: [{ rel: "canonical", href: "/docs/troubleshooting" }],
  }),
  component: Troubleshooting,
});

function Troubleshooting() {
  return (
    <DocsPage
      eyebrow="Operating"
      title="Troubleshooting"
      description="The MCP ships with diagnostics. Start with doctor, then drill in."
    >
      <h2>Health checks</h2>
      <CodeBlock
        code={`gittensory-mcp doctor
gittensory-mcp status
gittensory-mcp whoami`}
      />
      <p>Or hit the public API endpoint directly to confirm reachability:</p>
      <CodeBlock lang="http" code={`GET https://api.loopover.ai/health`} />

      <h2>Self-host Docker observability</h2>
      <p>
        The Docker stack exposes three different operator signals: structured logs from the{" "}
        <code>gittensory</code> container, Prometheus metrics at <code>/metrics</code>, and optional
        OpenTelemetry traces through the observability profile. Metrics answer <em>how much</em>{" "}
        work is happening; traces answer <em>where time went</em> inside a review job.
      </p>
      <CodeBlock
        lang="bash"
        code={`# Enable the collector + Tempo/Grafana stack.
docker compose --profile observability up -d

# Export app queue-job and AI-provider spans to Tempo.
OTEL_TRACES_EXPORTER=otlp
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.05
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`}
      />
      <p>
        App traces are off unless <code>OTEL_TRACES_EXPORTER</code> includes <code>otlp</code>. When
        enabled, the self-host runtime exports durable queue-job spans and AI-provider attempt spans
        over OTLP/HTTP; the default collector endpoint is normalized to <code>/v1/traces</code>.
        Span attributes are bounded to operational labels such as job type, queue backend, provider,
        model, and request kind.
      </p>
      <Callout variant="safety" title="Trace data stays operational">
        Do not put request bodies, prompts, diffs, credentials, or private config in trace
        attributes. The built-in self-host spans intentionally avoid those fields.
      </Callout>

      <h2>Common issues</h2>
      <h3>Login hangs on device flow</h3>
      <p>
        Confirm you can reach <code>github.com/login/device</code> in your browser. Re-run{" "}
        <code>gittensory-mcp login</code> and paste the new code.
      </p>

      <h3>“Stale fidelity” warning</h3>
      <p>
        Upstream Gittensor changed. See <a href="/docs/upstream-drift">Upstream drift</a> for what
        that means and how to interpret cached analysis until fidelity recovers.
      </p>

      <h3>MCP not appearing in my editor</h3>
      <p>
        Re-run the appropriate <code>init-client</code> command and restart the editor. See{" "}
        <a href="/docs/mcp-clients">MCP client setup</a> for per-editor config locations.
      </p>

      <h3>401 Unauthorized from the API</h3>
      <p>
        Your LoopOver session expired. Run <code>gittensory-mcp login</code> again. Static bearer
        tokens are not user-facing.
      </p>

      <h2 id="api-status">API status &amp; offline mode</h2>
      <p>
        The site continuously monitors the LoopOver API and surfaces problems through a banner under
        the header and a single deduped toast with a <strong>Recheck</strong> button.
      </p>
      <h3 id="offline">You're offline</h3>
      <p>
        We detected your browser is offline (<code>navigator.onLine === false</code>). Live API
        actions in the API reference are paused. Reconnect and the site auto-rechecks
        <code>/health</code> within a few seconds.
      </p>
      <h3 id="api-unreachable">API unreachable</h3>
      <p>
        <code>/health</code> couldn't be reached at all. This usually means a network problem
        between you and the API edge. Try the <strong>Recheck</strong> button in the banner, or run{" "}
        <code>curl https://api.loopover.ai/health</code> from your machine to confirm.
      </p>
      <h3 id="api-timeout">API timing out</h3>
      <p>
        <code>/health</code> didn't respond within the 4-second probe window. The API may be slow or
        restarting. Retry — most timeouts resolve within a minute.
      </p>
      <h3 id="api-degraded">API degraded</h3>
      <p>
        <code>/health</code> returned a non-2xx response. Some endpoints may still work; check the
        Roadmap for incident notes or wait for the recheck cycle to clear.
      </p>
    </DocsPage>
  );
}
