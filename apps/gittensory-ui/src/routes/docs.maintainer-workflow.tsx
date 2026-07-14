import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";
import { WorkflowMirror, type MirroredStep } from "@/components/site/workflow-mirror";
import { MAINTAINER_COMMAND_LIST, PUBLIC_COMMAND_LIST } from "@/lib/command-reference";

export const Route = createFileRoute("/docs/maintainer-workflow")({
  head: () => ({
    meta: [
      { title: "Maintainer workflow — LoopOver docs" },
      {
        name: "description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
      },
      { property: "og:title", content: "Maintainer workflow — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How to use LoopOver in a repo: confirmed-miner labels, sticky sanitized comments, on-demand @loopover commands.",
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
            code={`@loopover preflight
@loopover blockers
@loopover duplicate-check`}
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
        maintainer: { label: "Self-host reviews", to: "/docs/maintainer-self-hosting" },
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
        New installations should start with{" "}
        <Link to="/docs/maintainer-self-hosting">self-hosting setup</Link>, then{" "}
        <Link to="/docs/github-app">GitHub App configuration</Link>: install on one repo, verify
        installation health, preview the public panel, then decide whether{" "}
        <strong>LoopOver Orb Review Agent</strong> should become a required check.
      </p>
      <WorkflowMirror
        role="maintainer"
        steps={steps}
        minerCta={{ label: "See the contributor side", to: "/docs/miner-workflow" }}
        maintainerCta={{ label: "Self-host reviews", to: "/docs/maintainer-self-hosting" }}
      />

      <h2>On-demand commands</h2>
      <p>
        By default, the public commands below are authorized for maintainers, collaborators, and
        confirmed miners (not the general public) — output stays scoped to maintainer-visible
        packets when appropriate. A repo can narrow this per command via{" "}
        <code>commandAuthorization</code> in its settings.
      </p>
      <CodeBlock code={PUBLIC_COMMAND_LIST} />
      <p>
        A separate maintainer-only queue-digest family defaults to maintainers and collaborators
        only:
      </p>
      <CodeBlock code={MAINTAINER_COMMAND_LIST} />
      <p>
        For syntax, default roles, PR action verbs, and the gate vs auto-review boundary, see the{" "}
        <Link to="/docs/gittensory-commands">@loopover command reference</Link>.
      </p>

      <Callout variant="safety">
        Public-facing comments are sanitized before they leave the Worker. Private scoring, reward,
        and risk language never appears in the PR thread.
      </Callout>
    </DocsPage>
  );
}
