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
          "Install the Gittensory GitHub App, choose repos, and configure sticky PR panels, advisory checks, and optional Gate enforcement.",
      },
      { property: "og:title", content: "GitHub App setup — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Install the Gittensory GitHub App, choose repos, and configure sticky PR panels, advisory checks, and optional Gate enforcement.",
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
      description="Install Gittensory on a repo, then choose whether it should stay advisory or enforce repo-configured PR quality rules."
    >
      <h2>Install</h2>
      <ol>
        <li>Open the Gittensory GitHub App listing.</li>
        <li>Choose the repositories you want to grant access to.</li>
        <li>Approve the requested permissions (issues, pulls, checks, metadata).</li>
      </ol>

      <h2>Default posture</h2>
      <p>
        Gittensory is advisory-first. Public comments, labels, the Context check, and the Gate check
        are controlled per repo. Missing issue links, non-Gittensor contributors, busy queues, and
        weak overlap signals do not block merge by default.
      </p>

      <h2>PR panel</h2>
      <p>
        The PR panel is one sticky bot comment that updates in place. It shows a public-safe
        readiness score, concrete signal evidence, and short actions for linked issues, related
        work, review load, validation evidence, open PR queue, contributor context, and Gate result.
      </p>

      <h2>Checks</h2>
      <p>
        <strong>Gittensory Context</strong> is advisory and should not be required in branch
        protection. <strong>Gittensory Gate</strong> is opt-in and can be made required after a repo
        owner chooses blocking rules.
      </p>

      <h2>Gate modes</h2>
      <p>
        Each Gate rule supports <code>off</code>, <code>advisory</code>, or <code>block</code>.
        Linked issue, duplicate PR, and quality-score checks default to <code>advisory</code>. The
        quality rule only blocks when <code>qualityGateMode</code> is <code>block</code> and a
        <code>qualityGateMinScore</code> threshold is configured.
      </p>

      <h2>Dogfood mode</h2>
      <p>
        For repos like <code>JSONbored/gittensory</code> and <code>awesome-claude</code>, enable PR
        comments, labels, Context, and Gate together to test the full product surface. If another
        maintainer agent can merge quickly, configure that agent to wait for{" "}
        <code>Gittensory Gate</code> before merge or close.
      </p>

      <h2>Install diagnostics</h2>
      <p>
        After installing, verify your install health from the API. The readiness endpoint separates
        service health from data quality.
      </p>

      <Callout variant="safety">
        Gittensory's GitHub App never requests source push, never stores repository contents, and
        never publishes wallet, hotkey, payout, trust, reward, or private scoring language.
      </Callout>
    </DocsPage>
  );
}
