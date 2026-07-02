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

      <h2>One-click App creation (recommended for a Direct App)</h2>
      <p>
        Before the App exists (no <code>GITHUB_APP_ID</code> set yet), the self-host serves a setup
        wizard at <code>GET /setup</code>. It renders a form that POSTs a GitHub App{" "}
        <em>manifest</em> — the exact permission and event set below, pre-filled — to GitHub's own
        App-creation flow. GitHub creates the App with the correct configuration in one step and
        redirects back to exchange credentials automatically; there is no manual permission
        checklist to get right or wrong. The route is disabled once an App is configured, so it
        can't rebind a live install.
      </p>
      <CodeBlock
        filename=".env"
        code={`PUBLIC_API_ORIGIN=https://reviews.example.com  # exact public URL, embedded in the manifest
SELFHOST_SETUP_TOKEN=change-this-long-random-value  # unlocks /setup for a freshly-booted instance`}
      />
      <CodeBlock
        lang="bash"
        code={`open "https://reviews.example.com/setup?token=<SELFHOST_SETUP_TOKEN>"`}
      />
      <Callout variant="note">
        Manual App creation (below) is still fully supported — for an air-gapped instance, a
        stricter change-review process, or simply a preference for reviewing every permission by
        hand before it exists. Whichever path you take, the resulting App needs the SAME
        permissions: this doc's manual list is kept in sync with the wizard's manifest and checked
        in CI, so the two can't silently drift apart.
      </Callout>

      <h2>Direct App permissions</h2>
      <ul>
        <li>Pull requests: write.</li>
        <li>
          Checks: write — the gate posts a check-run; <code>checks: read</code> alone 403s that
          write (silently fails the first review with no obvious cause).
        </li>
        <li>Issues: write.</li>
        <li>
          Contents: write — required for BOTH merging and the auto-maintain{" "}
          <code>update_branch</code> action. <code>contents: read</code> looks sufficient at
          creation time but silently breaks auto-merge later with no error surfaced in the UI; there
          is no lesser permission that keeps merge/update-branch working.
        </li>
        <li>Commit statuses: read.</li>
        <li>Metadata: read.</li>
      </ul>
      <p>
        Events: pull request, pull request review, push, issues, check suite, check run, and status.
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
