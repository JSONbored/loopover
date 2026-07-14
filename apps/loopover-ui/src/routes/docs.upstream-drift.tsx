import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/upstream-drift")({
  head: () => ({
    meta: [
      { title: "Upstream drift — LoopOver docs" },
      {
        name: "description",
        content:
          "LoopOver tracks versioned upstream Gittensor source/ruleset snapshots, hashes semantic payloads, and warns when assumptions drift.",
      },
      { property: "og:title", content: "Upstream drift — LoopOver docs" },
      {
        property: "og:description",
        content:
          "LoopOver tracks versioned upstream Gittensor source/ruleset snapshots, hashes semantic payloads, and warns when assumptions drift.",
      },
      { property: "og:url", content: "/docs/upstream-drift" },
    ],
    links: [{ rel: "canonical", href: "/docs/upstream-drift" }],
  }),
  component: UpstreamDrift,
});

function UpstreamDrift() {
  return (
    <DocsPage
      eyebrow="Core concepts"
      title="Upstream drift"
      description="Gittensor moves. LoopOver tracks every meaningful change to scoring, registry, and issue-discovery so your decisions stay grounded."
    >
      <h2>How drift works</h2>
      <p>
        LoopOver stores versioned snapshots of the Gittensor source and ruleset from{" "}
        <a href="https://github.com/entrius/gittensor" target="_blank" rel="noreferrer">
          entrius/gittensor:test
        </a>
        . Semantic payloads are hashed so we can detect scoring, registry, or issue-discovery drift
        without re-deriving the whole world.
      </p>

      <Callout>
        <strong>Upstream relationship.</strong> <code>entrius/gittensor</code> is the upstream
        project LoopOver analyzes. LoopOver is{" "}
        <a href="https://github.com/jsonbored/loopover" target="_blank" rel="noreferrer">
          jsonbored/loopover
        </a>{" "}
        — an independent base-agent layer for the Gittensor ecosystem, not affiliated with the
        official subnet.
      </Callout>

      <h2>Signal fidelity vs readiness</h2>
      <p>
        The API distinguishes service health from data quality. Readiness can be green while signal
        fidelity is <code>stale</code>, <code>degraded</code>, or <code>blocked</code>. The MCP
        surfaces fidelity in every response so agents don't act on stale assumptions.
      </p>

      <h2>Endpoints</h2>
      <CodeBlock
        lang="http"
        code={`GET /v1/readiness
GET /v1/sync/status
GET /v1/upstream/status
GET /v1/upstream/ruleset
GET /v1/upstream/drift`}
      />

      <Callout variant="warn">
        When drift is detected, the MCP CLI prints a heads-up before any analyze/preflight/plan
        output. Treat the response as a snapshot tied to the printed ruleset version.
      </Callout>
    </DocsPage>
  );
}
