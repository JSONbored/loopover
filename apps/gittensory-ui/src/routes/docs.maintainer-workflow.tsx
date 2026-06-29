import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";
import { WorkflowMirror, type MirroredStep } from "@/components/site/workflow-mirror";

export const Route = createFileRoute("/docs/maintainer-workflow")({
  head: () => ({
    meta: [
      { title: "Maintainer workflow — Gittensory docs" },
      {
        name: "description",
        content:
          "How to use Gittensory in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @gittensory commands.",
      },
      { property: "og:title", content: "Maintainer workflow — Gittensory docs" },
      {
        property: "og:description",
        content:
          "How to use Gittensory in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @gittensory commands.",
      },
      { property: "og:url", content: "/docs/maintainer-workflow" },
    ],
    links: [{ rel: "canonical", href: "/docs/maintainer-workflow" }],
  }),
  component: MaintainerWorkflow,
});

function MaintainerWorkflow() {
  const steps: MirroredStep[] = [
    {
      title: "Plan",
      miner: (
        <>
          The contributor pulls a private decision pack via MCP — lane fit, repo targets, ranked
          next actions. Nothing is posted to your repo.
        </>
      ),
      maintainer: (
        <>
          Default posture is silence. No always-on public check runs, no score numbers, no labels on
          non-confirmed-miner PRs.
        </>
      ),
      nextStep: {
        miner: { label: "What miners see", to: "/docs/miner-workflow" },
        maintainer: { label: "Privacy boundary", to: "/docs/privacy-security" },
      },
    },
    {
      title: "Analyze",
      miner: (
        <>
          Metadata-only branch analysis runs locally. Source code stays on the contributor's
          machine.
        </>
      ),
      maintainer: (
        <>
          On confirmed-miner PRs, request the maintainer packet on demand — no background scanning
          of your repo.
          <CodeBlock
            lang="http"
            code={`GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet`}
          />
        </>
      ),
      nextStep: {
        miner: { label: "Branch analysis reference", to: "/docs/branch-analysis" },
        maintainer: { label: "Maintainer packet API", to: "/api" },
      },
    },
    {
      title: "Preflight",
      miner: (
        <>
          The contributor sees branch blockers, account/queue blockers, and maintainer-fit notes
          before opening the PR.
        </>
      ),
      maintainer: (
        <>
          You can ask for the same reviewability view in the PR thread.
          <CodeBlock
            code={`@gittensory preflight
@gittensory blockers
@gittensory duplicate-check`}
          />
        </>
      ),
      nextStep: {
        miner: { label: "Common blockers", to: "/docs/troubleshooting" },
        maintainer: { label: "Upstream drift", to: "/docs/upstream-drift" },
      },
    },
    {
      title: "Packet",
      miner: (
        <>
          The contributor opens the PR with a public-safe packet — clean description, no private
          scoring language.
        </>
      ),
      maintainer: (
        <>
          At most one sticky sanitized comment and one configured label per confirmed-miner PR. Pull
          richer context on demand via the API.
          <CodeBlock
            lang="http"
            code={`GET /v1/repos/:owner/:repo/pulls/:number/reviewability
GET /v1/repos/:owner/:repo/registration-readiness`}
          />
        </>
      ),
      nextStep: {
        miner: { label: "PR packet format", to: "/docs/miner-workflow" },
        maintainer: { label: "Install the GitHub App", to: "/docs/github-app" },
      },
    },
  ];

  return (
    <DocsPage
      eyebrow="Workflows"
      title="Maintainer workflow"
      description="The default posture is silence. You opt into context. The repo stays calm."
    >
      <h2>The mirrored loop</h2>
      <p>
        Each step on the right is what you see in the repo; the matching step on the left is what
        the contributor is doing privately via MCP at the same point.
      </p>
      <p>
        New installations should start with <Link to="/docs/github-app">GitHub App setup</Link>:
        install on one repo, verify installation health, preview the public panel, then decide
        whether <strong>Gittensory Orb Review Agent</strong> should become a required check.
      </p>
      <WorkflowMirror
        role="maintainer"
        steps={steps}
        minerCta={{ label: "See the contributor side", to: "/docs/miner-workflow" }}
        maintainerCta={{ label: "Install the GitHub App", to: "/docs/github-app" }}
      />

      <h2>On-demand commands</h2>
      <p>
        Maintainers (and only maintainers) can trigger context with a comment. Output is scoped to
        maintainer-visible packets when appropriate.
      </p>
      <CodeBlock
        code={`@gittensory help
@gittensory preflight
@gittensory blockers
@gittensory duplicate-check
@gittensory miner-context
@gittensory next-action`}
      />

      <Callout variant="safety">
        Public-facing comments are sanitized before they leave the Worker. Private scoring, reward,
        and risk language never appears in the PR thread.
      </Callout>
    </DocsPage>
  );
}
