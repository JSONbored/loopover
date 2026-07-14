import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";

import { AmsObservabilityCallout } from "@/components/site/ams-observability-callout";
import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";
import { WorkflowMirror, type MirroredStep } from "@/components/site/workflow-mirror";

export const Route = createFileRoute("/docs/miner-workflow")({
  head: () => ({
    meta: [
      { title: "Miner workflow — LoopOver docs" },
      {
        name: "description",
        content: "Plan → analyze → preflight → packet. The four-step miner loop with the MCP CLI.",
      },
      { property: "og:title", content: "Miner workflow — LoopOver docs" },
      {
        property: "og:description",
        content: "Plan → analyze → preflight → packet. The four-step miner loop with the MCP CLI.",
      },
      { property: "og:url", content: "/docs/miner-workflow" },
    ],
    links: [{ rel: "canonical", href: "/docs/miner-workflow" }],
  }),
  component: MinerWorkflow,
});

export function MinerWorkflow() {
  const steps: MirroredStep[] = [
    {
      title: "Plan",
      miner: (
        <>
          Pull a decision pack — lane context, repo targets to pursue or avoid, freshness, and
          ranked next actions.
          <CodeBlock code={`loopover-mcp agent plan --login your-login --json`} />
        </>
      ),
      maintainer: (
        <>
          Nothing visible in the repo. The plan step is private MCP context for the contributor; no
          public comments or labels are emitted.
        </>
      ),
      nextStep: {
        miner: { label: "How scoreability works", to: "/docs/scoreability" },
        maintainer: { label: "Privacy boundary", to: "/docs/privacy-security" },
      },
    },
    {
      title: "Analyze",
      miner: (
        <>
          Metadata-only branch analysis on the current branch — refs, changed-file metadata, labels,
          linked issues, commit messages, validation summaries.
          <CodeBlock code={`loopover-mcp analyze-branch --login your-login --json`} />
        </>
      ),
      maintainer: (
        <>
          Still silent in the repo. Branch analysis runs locally against the API; no source is
          uploaded and no check runs are created.
        </>
      ),
      nextStep: {
        miner: { label: "Branch analysis reference", to: "/docs/branch-analysis" },
        maintainer: { label: "What we don't upload", to: "/docs/privacy-security" },
      },
    },
    {
      title: "Preflight",
      miner: (
        <>
          Combine branch analysis with account/queue context to surface branch blockers, account
          blockers, and maintainer-fit notes.
          <CodeBlock code={`loopover-mcp preflight --login your-login --json`} />
        </>
      ),
      maintainer: (
        <>
          On confirmed-miner PRs you can later request the same view with
          <code> @loopover preflight</code> — the response is sanitized for the PR thread.
        </>
      ),
      nextStep: {
        miner: { label: "Common preflight blockers", to: "/docs/troubleshooting" },
        maintainer: { label: "All @loopover commands", to: "/docs/maintainer-workflow" },
      },
    },
    {
      title: "Packet",
      miner: (
        <>
          Produce a public-safe PR packet — a description that reads cleanly to maintainers, with no
          private scoring or risk language leaking out.
          <CodeBlock code={`loopover-mcp agent packet --json`} />
        </>
      ),
      maintainer: (
        <>
          At most one sticky sanitized comment and one configured label per confirmed-miner PR.
          Private scoring, reward, and risk language never appear in the thread.
        </>
      ),
      nextStep: {
        miner: { label: "Set up your MCP client", to: "/docs/mcp-clients" },
        maintainer: { label: "Self-host reviews", to: "/docs/maintainer-self-hosting" },
      },
    },
  ];

  return (
    <DocsPage
      eyebrow="Workflows"
      title="Miner workflow"
      description="A deterministic four-step loop. Each step is pure metadata; each output is structured JSON your agent can consume."
    >
      <p>
        If the workflow will spawn Claude Code or Codex, configure that driver first in{" "}
        <Link to="/docs/miner-coding-agent">Miner coding-agent driver</Link>.
      </p>
      <h2>The mirrored loop</h2>
      <p>
        Each step on the left is what the contributor runs; the matching step on the right is what
        the maintainer sees in the repo at the same point.
      </p>
      <WorkflowMirror
        role="miner"
        steps={steps}
        minerCta={{ label: "Set up the MCP client", to: "/docs/mcp-clients" }}
        maintainerCta={{ label: "See the maintainer side", to: "/docs/maintainer-workflow" }}
      />

      <Callout variant="safety">
        <strong>Cleanup first.</strong> When the preflight reports queue pressure or unsquashed
        commits, prefer cleaning open work over opening more — risk-adjusted priority is part of the
        score model.
      </Callout>
      <AmsObservabilityCallout />
    </DocsPage>
  );
}
