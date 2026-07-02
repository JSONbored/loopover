import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/maintainer-install-trust")({
  head: () => ({
    meta: [
      { title: "Maintainer install and trust guide — Gittensory docs" },
      {
        name: "description",
        content:
          "Install Gittensory as a maintainer, verify trust boundaries, preview public output, and decide when GitHub App checks are safe to enable.",
      },
      {
        property: "og:title",
        content: "Maintainer install and trust guide — Gittensory docs",
      },
      {
        property: "og:description",
        content:
          "Install Gittensory as a maintainer, verify trust boundaries, preview public output, and decide when GitHub App checks are safe to enable.",
      },
      { property: "og:url", content: "/docs/maintainer-install-trust" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-install-trust" }],
  }),
  component: MaintainerInstallTrust,
});

function MaintainerInstallTrust() {
  return (
    <DocsPage
      eyebrow="Launch guide"
      title="Maintainer install and trust guide"
      description="A maintainer-first checklist for installing the GitHub App, keeping public output safe, authorizing commands, using the browser extension, and rejecting weak Gittensory-driven PRs."
    >
      <Callout variant="safety" title="Trust posture">
        Gittensory is advisory-first. It may help you review contribution readiness, but it does not
        replace human maintainer judgment, expose private scoreability signals, or make reward,
        payout, wallet, hotkey, or trust-score claims in public surfaces.
      </Callout>

      <h2>Install the GitHub App</h2>
      <p>
        Start from <Link to="/docs/maintainer-self-hosting">self-hosting setup</Link> (the
        recommended, default path — you install your own App) or{" "}
        <Link to="/docs/github-app">GitHub App configuration</Link>, then keep the first rollout
        narrow until the repo owner has verified permissions, webhook delivery, and public copy.
      </p>
      <ol>
        <li>Install Gittensory on one test repository or a selected repository set.</li>
        <li>
          Approve <code>Metadata: read</code>, <code>Pull requests: read</code>, and{" "}
          <code>Issues: write</code>. Add <code>Checks: write</code> only when Context or
          review-agent check runs are enabled for the repository.
        </li>
        <li>
          Keep webhook events enabled for <code>issues</code>, <code>issue_comment</code>,{" "}
          <code>pull_request</code>, and <code>repository</code>.
        </li>
        <li>
          Leave comments, labels, Context checks, and review-agent checks in advisory mode until
          preview output matches the repo's maintainer policy.
        </li>
      </ol>
      <CodeBlock
        lang="http"
        code={`GET /v1/installations
GET /v1/installations/:id/health
GET /v1/installations/:id/repair
GET /v1/repos/:owner/:repo/registration-readiness
POST /v1/repos/:owner/:repo/settings-preview`}
      />

      <h2>Launch verification flow</h2>
      <p>
        Treat launch as a controlled trust review. Do not enable public comments or required checks
        until every step below has a maintainer-visible result.
      </p>
      <CodeBlock
        lang="text"
        filename="maintainer-launch-flow.txt"
        code={`Install selected repos
  -> verify installation health and webhook delivery
  -> preview public panel and command output
  -> confirm private signals stay private
  -> enable advisory Context, labels, or comments
  -> capture screenshots/recordings for UI or extension changes
  -> decide whether the review-agent check should be required in branch protection`}
      />

      <h2>Maintainer controls</h2>
      <FeatureRow
        items={[
          {
            title: "Public comments",
            description:
              "The sticky PR panel is opt-in per repo and must be previewed before posting to GitHub.",
          },
          {
            title: "Labels",
            description:
              "Labels are repo-configured and should stay quiet for non-confirmed-miner PRs unless maintainers intentionally enable them.",
          },
          {
            title: "Context check",
            description:
              "Gittensory Context is advisory and should not be required by branch protection.",
          },
          {
            title: "Review agent check",
            description:
              "Gittensory Orb Review Agent is opt-in. Make it required only after the repo owner chooses blocking rules and validates previews.",
          },
          {
            title: "Command access",
            description:
              "PR-thread commands are maintainer-authorized. Untrusted contributors should not be able to trigger private maintainer packets.",
          },
        ]}
      />

      <h2>Command authorization</h2>
      <p>
        Maintainer commands should be treated like privileged review actions. Use them to fetch
        context on demand, not to create always-on public scoring.
      </p>
      <CodeBlock
        code={`@gittensory help
@gittensory preflight
@gittensory blockers
@gittensory duplicate-check
@gittensory miner-context
@gittensory next-action`}
      />
      <p>
        If a command would include private reviewability, private scoreability, duplicate-risk, or
        contributor-history context, the result must stay in maintainer-visible surfaces. Public
        replies should only contain sanitized actions a contributor can safely use.
      </p>

      <h2>Public-safe previews</h2>
      <p>
        Preview every public output path before enabling it. The same public-safety boundary applies
        to GitHub comments, issue bodies, PR bodies, extension-visible public panels, and copied
        snippets.
      </p>
      <ul>
        <li>No wallet or hotkey identifiers.</li>
        <li>No reward, payout, or emission estimates.</li>
        <li>No trust-score, public score prediction, or private scoreability language.</li>
        <li>No private reviewability blockers or maintainer-only duplicate-risk notes.</li>
        <li>No farming instructions, bounty gaming language, or rank-chasing advice.</li>
      </ul>
      <p>
        For the full boundary, keep <Link to="/docs/privacy-security">Privacy & security</Link> as
        the source of truth. For AI-written text, use the{" "}
        <Link to="/docs/ai-summaries">AI summaries policy</Link> before posting generated copy.
      </p>

      <h2>Browser extension states</h2>
      <p>
        The extension is a maintainer review aid. It should make state and scope obvious instead of
        implying that a contributor or public viewer can see private packets.
      </p>
      <CodeBlock
        lang="text"
        filename="extension-state-map.txt"
        code={`Signed out
  -> no repo context, no private packet
Signed in without repo scope
  -> prompt for authorized GitHub App installation or browser session
Authorized maintainer on PR page
  -> public-safe PR panel + private maintainer blockers
Unauthorized viewer or stale session
  -> public-safe state only, no private blockers
API unavailable or stale data
  -> degraded state with retry guidance, never guessed scores`}
      />
      <p>
        UI, frontend, browser-extension, or GitHub-overlay pull requests need maintainer-reviewable
        screenshots or a short recording that shows the relevant states. A checked template box is
        not enough evidence.
      </p>

      <h2>Audit expectations</h2>
      <p>
        A healthy installation should leave an audit trail that maintainers can reason about without
        exposing repository source or contributor secrets.
      </p>
      <ul>
        <li>Installation health shows permissions and webhook readiness.</li>
        <li>Settings preview shows the exact public copy before posting.</li>
        <li>Command previews identify the maintainer action that produced them.</li>
        <li>Extension sessions are scoped to authorized review context.</li>
        <li>Failures are inspectable through diagnostics instead of silent public output.</li>
      </ul>

      <h2>CI checks are not reviewer approval</h2>
      <p>
        Keep GitHub CI/check state separate from reviewer and mergeability state. A green CI run or
        advisory Context check can prove automation completed, but it does not prove the PR is
        acceptable, non-duplicative, or safe to merge. Human maintainers still decide whether the
        contribution fits the repo, issue, and subnet goals.
      </p>
      <p>
        If the repo enables <strong>Gittensory Orb Review Agent</strong>, document which blockers
        are enforced and why. Otherwise, treat Gittensory output as reviewer context only.
      </p>

      <h2>Reject weak Gittensory-driven PRs</h2>
      <p>
        Maintainers should request changes or close PRs that misuse Gittensory output. The tool is a
        contribution operating layer, not a guarantee that work deserves merge.
      </p>
      <ul>
        <li>Reject PRs with no linked issue, no reproduction, or no validation evidence.</li>
        <li>Reject UI or extension PRs that omit screenshots or recordings of changed flows.</li>
        <li>
          Reject copied snippets that leak private scoring, reward, trust, wallet, or hotkey text.
        </li>
        <li>Reject duplicated work when the PR does not explain overlap and maintainer value.</li>
        <li>
          Reject generated broad rewrites that are not scoped to the issue acceptance criteria.
        </li>
        <li>Reject PRs that confuse passing CI with maintainer approval.</li>
      </ul>

      <h2>Next docs</h2>
      <p>
        Continue with <Link to="/docs/maintainer-workflow">Maintainer workflow</Link> for daily PR
        review, <Link to="/docs/troubleshooting">Troubleshooting</Link> for install diagnostics, and{" "}
        <Link to="/extension">Browser extension</Link> for overlay behavior.
      </p>
    </DocsPage>
  );
}
