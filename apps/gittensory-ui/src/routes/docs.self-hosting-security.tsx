import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-security")({
  head: () => ({
    meta: [
      { title: "Self-host security — Gittensory docs" },
      {
        name: "description",
        content:
          "Secure the self-hosted Gittensory review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:title", content: "Self-host security — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Secure the self-hosted Gittensory review service: secrets, private rules, network exposure, public output boundaries, REES, AI credentials, and observability.",
      },
      { property: "og:url", content: "/docs/self-hosting-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-security" }],
  }),
  component: SelfHostingSecurity,
});

function SelfHostingSecurity() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Security"
      description="The self-host stack holds maintainer credentials and policy. Keep those boundaries explicit."
    >
      <h2>Secret handling</h2>
      <FeatureRow
        items={[
          {
            title: "Never bake secrets",
            description:
              "Images should not contain .env files, private keys, API keys, webhook secrets, REES secrets, or CLI auth files.",
          },
          {
            title: "Prefer secret files",
            description:
              "Use FOO_FILE for multiline values and orchestrator-managed secrets where possible.",
          },
          {
            title: "Rotate deliberately",
            description:
              "Rotate GitHub webhook secrets, API tokens, REES secrets, and provider keys with a restart window and validation PR.",
          },
        ]}
      />

      <h2>Private policy</h2>
      <p>
        Keep sensitive review thresholds, autonomy, maintainer notes, and repo-specific rules in
        <code>GITTENSORY_REPO_CONFIG_DIR</code>, not in public repo config.
      </p>
      <CodeBlock filename=".env" code={`GITTENSORY_REPO_CONFIG_DIR=/config`} />

      <h2>Network exposure</h2>
      <ul>
        <li>Expose the webhook endpoint only through TLS.</li>
        <li>Keep Prometheus, Grafana, Qdrant, Ollama, and database ports private by default.</li>
        <li>Put an auth layer in front of dashboards and internal admin routes.</li>
        <li>
          Use <code>/ready</code> for orchestrators, not as a public status surface.
        </li>
      </ul>

      <h2>AI credential boundaries</h2>
      <Callout variant="warn" title="Subscription CLI credentials">
        CLI auth files can be readable by the runtime. Do not mount a prompt-readable Claude Code or
        Codex home into review execution unless you have intentionally isolated it. API-key and
        local model providers are easier to reason about operationally.
      </Callout>

      <h2>REES boundary</h2>
      <p>
        REES receives PR diff and file metadata. Use a private network URL when possible, require
        <code>REES_SHARED_SECRET</code>, and remember that the engine treats REES output as
        untrusted advisory context.
      </p>

      <h2>Public output boundary</h2>
      <p>
        Public PR comments and checks must not leak secrets, private policy, provider credentials,
        private scoring context, or maintainer-only notes. For hosted and self-host boundaries, keep
        <Link to="/docs/privacy-security"> Privacy and security</Link> nearby.
      </p>
    </DocsPage>
  );
}
