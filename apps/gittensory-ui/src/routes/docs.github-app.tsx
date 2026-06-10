import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

const GITHUB_APP_INSTALL_URL = "https://github.com/apps/gittensory/installations/new";

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
      <p>
        The hosted deployment uses the GitHub App slug <code>gittensory</code>. Start from{" "}
        <a href={GITHUB_APP_INSTALL_URL} target="_blank" rel="noreferrer">
          the GitHub App install flow
        </a>
        , then choose only the repositories you want Gittensory to see.
      </p>
      <ol>
        <li>Open the install flow and pick the owning account.</li>
        <li>
          Choose selected repositories instead of all repositories unless you are onboarding an org.
        </li>
        <li>
          Approve <code>Metadata: read</code>, <code>Pull requests: read</code>, and{" "}
          <code>Issues: write</code>. Enable <code>Checks: write</code> when Context or Gate check
          runs are enabled.
        </li>
        <li>
          Keep webhook events enabled for <code>issues</code>, <code>issue_comment</code>,{" "}
          <code>pull_request</code>, and <code>repository</code>.
        </li>
      </ol>

      <h2>First 10 minutes</h2>
      <ol>
        <li>Install the app on one test repository first.</li>
        <li>
          Confirm the installation appears in the private API, then open its health record.
          <CodeBlock
            lang="http"
            code={`GET /v1/installations
GET /v1/installations/:id/health
GET /v1/installations/:id/repair`}
          />
        </li>
        <li>
          Check repo readiness before enabling public output.
          <CodeBlock lang="http" code={`GET /v1/repos/:owner/:repo/registration-readiness`} />
        </li>
        <li>
          Preview the exact public surface without posting to GitHub.
          <CodeBlock
            lang="http"
            code={`POST /v1/repos/:owner/:repo/settings-preview
# body: sample PR fields + desired comment/check/gate settings`}
          />
        </li>
        <li>
          Leave <strong>Gittensory Context</strong> advisory while you tune copy and settings. Make{" "}
          <strong>Gittensory Gate</strong> required only after the repo explicitly enables blocking
          rules.
        </li>
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
      <p>
        Branch protection should require <strong>Gittensory Gate</strong> only after the repo has
        verified installation health, previewed the public panel, and configured at least one{" "}
        <code>block</code> rule. Do not require <strong>Gittensory Context</strong>; it is there to
        inform reviewers, not stop merges.
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
      <p>
        If the install route changes, check the deployed <code>GITHUB_APP_SLUG</code> before
        publishing setup copy. For the hosted app, the expected slug is <code>gittensory</code>.
      </p>

      <p>
        New maintainers should continue with{" "}
        <Link to="/docs/maintainer-workflow">Maintainer workflow</Link> or the{" "}
        <Link to="/docs/beta-onboarding">beta onboarding checklist</Link> after the health endpoint
        reports clean permissions and events.
      </p>

      <Callout variant="safety">
        Gittensory's GitHub App never requests source push, never stores repository contents, and
        never publishes wallet, hotkey, payout, trust, reward, or private scoring language.
      </Callout>
    </DocsPage>
  );
}
