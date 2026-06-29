import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-configuration")({
  head: () => ({
    meta: [
      { title: "Self-host configuration — Gittensory docs" },
      {
        name: "description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:title", content: "Self-host configuration — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Configure the self-host review service: env vars, private repo config, feature flags, review modes, and safe defaults.",
      },
      { property: "og:url", content: "/docs/self-hosting-configuration" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-configuration" }],
  }),
  component: SelfHostingConfiguration,
});

function SelfHostingConfiguration() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Configuration"
      description="The self-host configuration model: deployment env, private per-repo policy, feature flags, and review modes."
    >
      <h2>Config layers</h2>
      <FeatureRow
        items={[
          {
            title: "Environment",
            description:
              "Deployment-wide infrastructure, secrets, feature kill switches, and service URLs. Requires restart or recreate when changed.",
          },
          {
            title: "Private repo config",
            description:
              "Mounted GITTENSORY_REPO_CONFIG_DIR files for private per-repo policy. Read fresh each review.",
          },
          {
            title: "Public repo config",
            description:
              "The repo .gittensory.yml. Useful for transparent policy, but not for thresholds or rules you need to keep private.",
          },
          {
            title: "Built-in defaults",
            description:
              "Safe fallback when nothing is configured. Gate off, AI off, and no repo runs per-PR features until allowlisted.",
          },
        ]}
      />

      <h2>Required baseline env</h2>
      <CodeBlock
        filename=".env"
        code={`PUBLIC_API_ORIGIN=https://reviews.example.com
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-gittensory-app
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=<random-webhook-secret>

GITTENSOR_REGISTRY_URL=https://example.invalid/registry.json
GITTENSORY_API_TOKEN=<random-32-byte-token>
GITTENSORY_MCP_TOKEN=<random-32-byte-token>
INTERNAL_JOB_TOKEN=<random-32-byte-token>`}
      />
      <p>
        Any <code>FOO_FILE</code> is loaded into <code>FOO</code> at startup. Explicit{" "}
        <code>FOO</code> wins over the file variant.
      </p>

      <h2>Per-PR feature flags</h2>
      <p>
        Most review capabilities need both their own flag and the repo in{" "}
        <code>GITTENSORY_REVIEW_REPOS</code>. This gives you a global kill switch and a per-repo
        rollout switch.
      </p>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_REPOS=owner/repo,owner/another
GITTENSORY_REVIEW_UNIFIED_COMMENT=true
GITTENSORY_REVIEW_INLINE_COMMENTS=false
GITTENSORY_REVIEW_SAFETY=true
GITTENSORY_REVIEW_GROUNDING=true
GITTENSORY_REVIEW_RAG=false
GITTENSORY_REVIEW_ENRICHMENT=false
GITTENSORY_REVIEW_REPUTATION=false`}
      />
      <Callout variant="safety">
        Empty <code>GITTENSORY_REVIEW_REPOS</code> means no repos run the per-PR feature path,
        regardless of the individual flags.
      </Callout>

      <h2>Private per-repo config</h2>
      <p>
        Mount a gitignored directory and point <code>GITTENSORY_REPO_CONFIG_DIR</code> at it. The
        first matching file wins and replaces the public repo config for that review.
      </p>
      <CodeBlock
        filename="config directory"
        code={`gittensory-config/
  owner__repo/.gittensory.yml
  repo-name/.gittensory.yml
  owner__repo.yml
  .gittensory.yml`}
      />
      <CodeBlock
        filename="owner__repo/.gittensory.yml"
        code={`gate:
  enabled: true
  aiReview:
    mode: advisory
    allAuthors: true
settings:
  commentMode: all_prs
  includeMaintainerAuthors: true
  autonomy:
    merge: observe
    close: observe
  agentDryRun: false
features:
  safety: true
  unifiedComment: true
  rag: false
  reputation: false`}
      />

      <h2>Instance-wide write switches</h2>
      <FeatureRow
        items={[
          {
            title: "Unset",
            description:
              "Normal mode. Per-repo autonomy and GitHub permissions decide what can be written.",
          },
          {
            title: "dry-run",
            description:
              "Compute reviews and audit as shadow, but suppress comments, checks, labels, merges, and closes.",
          },
          {
            title: "disabled",
            description: "Suppress writes as denied. Use when you need a hard instance-wide stop.",
          },
        ]}
      />

      <h2>Next steps</h2>
      <p>
        Configure the GitHub integration in{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>, then add optional
        context through <Link to="/docs/self-hosting-ai-providers">AI providers</Link>,{" "}
        <Link to="/docs/self-hosting-rees">REES</Link>, or{" "}
        <Link to="/docs/self-hosting-rag">RAG</Link>.
      </p>
    </DocsPage>
  );
}
