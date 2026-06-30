import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-quickstart")({
  head: () => ({
    meta: [
      { title: "Self-hosting quickstart — Gittensory docs" },
      {
        name: "description",
        content:
          "Bring up the Gittensory self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:title", content: "Self-hosting quickstart — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Bring up the Gittensory self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:url", content: "/docs/self-hosting-quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-quickstart" }],
  }),
  component: SelfHostingQuickstart,
});

function SelfHostingQuickstart() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Quickstart"
      description="A minimal self-host boot path for maintainers: start the service, verify readiness, and keep the first rollout safe."
    >
      <h2>1. Copy the sample env</h2>
      <p>
        The sample env contains placeholders only. Keep your real <code>.env</code> out of git and
        prefer mounted secret files for multiline values like the GitHub App private key.
      </p>
      <CodeBlock
        lang="bash"
        code={`cp .env.example .env
# edit .env`}
      />

      <h2>2. Start conservative</h2>
      <p>
        Begin with a small allowlist, unified comments, safety, and grounding. Leave AI, RAG, and
        REES off until webhook delivery and deterministic review are working.
      </p>
      <CodeBlock
        filename=".env"
        code={`SELFHOST_DEPLOYMENT_MODE=dry-run
GITTENSORY_REVIEW_REPOS=owner/repo
GITTENSORY_REVIEW_UNIFIED_COMMENT=true
GITTENSORY_REVIEW_SAFETY=true
GITTENSORY_REVIEW_GROUNDING=true
GITTENSORY_REVIEW_RAG=false
GITTENSORY_REVIEW_ENRICHMENT=false`}
      />
      <Callout variant="note">
        <code>dry-run</code> computes reviews but suppresses writes. Switch to live only after
        webhook delivery, logs, and review output match expectations.
      </Callout>

      <h2>3. Boot the stack</h2>
      <CodeBlock
        lang="bash"
        code={`docker compose up -d --build
curl http://localhost:8787/health
curl http://localhost:8787/ready`}
      />
      <FeatureRow
        items={[
          {
            title: "/health",
            description: "Liveness. It confirms the HTTP process is up.",
          },
          {
            title: "/ready",
            description:
              "Readiness. It returns 200 only after database access and migrations are healthy.",
          },
          {
            title: "/metrics",
            description: "Prometheus metrics for queue, jobs, HTTP traffic, uptime, and AI usage.",
          },
        ]}
      />

      <h2>4. Install or connect the GitHub App</h2>
      <p>
        Point your App webhook to <code>https://your-host.example/v1/github/webhook</code>, set the
        same webhook secret in <code>GITHUB_WEBHOOK_SECRET</code>, install the App on one test repo,
        and open a small PR. The direct App and Orb modes are covered in{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>.
      </p>

      <h2>5. Watch the first review</h2>
      <p>Look for these logs during boot and the first webhook:</p>
      <CodeBlock
        code={`selfhost_listening
selfhost_migrations_applied
selfhost_ai_provider          # only when AI_PROVIDER is set
selfhost_job_dead             # investigate immediately if present
review_context_fetch_failed   # REES/RAG/grounding context failure`}
      />
      <p>
        After the deterministic path is stable, continue with{" "}
        <Link to="/docs/self-hosting-configuration">Configuration</Link> and then layer in AI, REES,
        or RAG deliberately.
      </p>
    </DocsPage>
  );
}
