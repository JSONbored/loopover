import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/github-app")({
  head: () => ({
    meta: [
      { title: "GitHub App setup — Gittensory docs" },
      {
        name: "description",
        content:
          "Install the Gittensory GitHub App, choose repos, and configure the optional label / sticky comment policy.",
      },
      { property: "og:title", content: "GitHub App setup — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Install the Gittensory GitHub App, choose repos, and configure the optional label / sticky comment policy.",
      },
      { property: "og:url", content: "/docs/github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/github-app" }],
  }),
  component: GithubApp,
});

function GithubApp() {
  return (
    <DocsPage
      eyebrow="Workflows"
      title="GitHub App setup"
      description="Install Gittensory on a repo. Nothing public changes unless you explicitly enable it."
    >
      <h2>Install</h2>
      <ol>
        <li>Open the Gittensory GitHub App listing.</li>
        <li>Choose the repositories you want to grant access to.</li>
        <li>Approve the requested permissions (issues, pulls, metadata).</li>
      </ol>

      <h2>Default posture</h2>
      <p>
        Once installed, Gittensory listens but doesn't speak. There are no public check runs. No
        comments. No labels. You're in control.
      </p>

      <h2>Opt-in: confirmed-miner output</h2>
      <p>
        You can enable a single configured label and one sticky sanitized comment per PR{" "}
        <strong>only</strong> for official confirmed Gittensor miners. Everything is per-repo
        configurable.
      </p>

      <h2>Install diagnostics</h2>
      <p>
        After installing, verify your install health from the API. The readiness endpoint separates
        service health from data quality.
      </p>

      <Callout variant="safety">
        Gittensory's GitHub App never requests source push, never stores repository contents, and
        never writes anything public it wasn't explicitly configured to write.
      </Callout>
    </DocsPage>
  );
}
