import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-github-app")({
  head: () => ({
    meta: [
      { title: "Self-host GitHub App and Orb — Gittensory docs" },
      {
        name: "description",
        content:
          "Connect a self-hosted Gittensory review service to GitHub with a direct GitHub App or brokered Orb enrollment.",
      },
      { property: "og:title", content: "Self-host GitHub App and Orb — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Connect a self-hosted Gittensory review service to GitHub with a direct GitHub App or brokered Orb enrollment.",
      },
      { property: "og:url", content: "/docs/self-hosting-github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-github-app" }],
  }),
  component: SelfHostingGithubApp,
});

function SelfHostingGithubApp() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="GitHub App and Orb"
      description="A self-host needs webhook delivery and installation tokens. Use a direct GitHub App when you own the full setup, or Orb broker mode when you want delegated token minting."
    >
      <h2>Choose a connection mode</h2>
      <FeatureRow
        items={[
          {
            title: "Direct GitHub App",
            description:
              "Your self-host stores the App id, slug, private key, and webhook secret. It mints installation tokens directly.",
          },
          {
            title: "Brokered Orb",
            description:
              "Your self-host uses ORB_ENROLLMENT_SECRET to request short-lived installation tokens from the central Orb broker.",
          },
        ]}
      />

      <h2>Direct App permissions</h2>
      <ul>
        <li>Pull requests: read/write.</li>
        <li>Checks: read/write.</li>
        <li>Issues: read/write.</li>
        <li>Contents: read. Add write only if the self-host should merge.</li>
        <li>Commit statuses: read.</li>
        <li>Metadata: read.</li>
      </ul>
      <p>
        Events should include pull request, pull request review, push, issues, check suite, check
        run, and status.
      </p>

      <h2>Direct App env</h2>
      <CodeBlock
        filename=".env"
        code={`GITHUB_APP_ID=123456
GITHUB_APP_SLUG=my-gittensory-app
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=<same-secret-configured-on-the-app>`}
      />

      <h2>Brokered Orb env</h2>
      <CodeBlock
        filename=".env"
        code={`ORB_ENROLLMENT_SECRET=<issued-once-by-orb>
ORB_BROKER_URL=https://gittensory-api.aethereal.dev`}
      />
      <Callout variant="note">
        Brokered mode is useful when the self-host should not hold a GitHub App private key. It
        still needs a reachable webhook path or relay mode, depending on the network setup.
      </Callout>

      <h2>Webhook checks</h2>
      <CodeBlock
        lang="bash"
        code={`curl https://reviews.example.com/health
curl https://reviews.example.com/ready`}
      />
      <p>
        After installing the App on a test repo, open a small PR and confirm the webhook delivery
        appears in GitHub and a job appears in self-host logs. Continue with{" "}
        <Link to="/docs/self-hosting-operations">Operations</Link> for log and metric checks.
      </p>
    </DocsPage>
  );
}
