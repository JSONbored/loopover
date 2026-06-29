import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-troubleshooting")({
  head: () => ({
    meta: [
      { title: "Self-host troubleshooting — Gittensory docs" },
      {
        name: "description",
        content:
          "Troubleshoot self-hosted Gittensory reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, and readiness failures.",
      },
      { property: "og:title", content: "Self-host troubleshooting — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Troubleshoot self-hosted Gittensory reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, and readiness failures.",
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
docker compose logs --tail=200 gittensory
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
            description: "Confirm the repo is in GITTENSORY_REVIEW_REPOS for per-PR features.",
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
          Confirm <code>GITTENSORY_REVIEW_RAG=true</code> and repo activation.
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
        code={`curl http://localhost:8787/metrics | grep gittensory_queue
docker compose logs gittensory | grep selfhost_job_dead`}
      />

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
