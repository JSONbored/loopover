import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/branch-analysis")({
  head: () => ({
    meta: [
      { title: "Branch analysis — Gittensory docs" },
      {
        name: "description",
        content:
          "Metadata-only analysis of a branch. Inputs, outputs, and the privacy boundary explained.",
      },
      { property: "og:title", content: "Branch analysis — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Metadata-only analysis of a branch. Inputs, outputs, and the privacy boundary explained.",
      },
      { property: "og:url", content: "/docs/branch-analysis" },
    ],
    links: [{ rel: "canonical", href: "/docs/branch-analysis" }],
  }),
  component: BranchAnalysis,
});

function BranchAnalysis() {
  return (
    <DocsPage
      eyebrow="Core concepts"
      title="Branch analysis"
      description="Gittensory analyzes branches using metadata only. Your source code never leaves your machine."
    >
      <h2>Inputs</h2>
      <ul>
        <li>Repository identity (owner/repo).</li>
        <li>Branch, base, and head refs.</li>
        <li>
          Changed-file <em>metadata</em> — paths, sizes, line counts.
        </li>
        <li>Labels and linked issues.</li>
        <li>Commit messages.</li>
        <li>Validation summaries (lint/test outcomes, not logs).</li>
        <li>Optional local scorer output.</li>
        <li>User-supplied scenario assumptions.</li>
      </ul>

      <h2>Outputs</h2>
      <ul>
        <li>Lane context (maintainer / contributor / hybrid).</li>
        <li>Role context for your account.</li>
        <li>
          Scoreability scenarios (see <a href="/docs/scoreability">Scoreability</a>).
        </li>
        <li>Branch blockers and account/queue blockers.</li>
        <li>Maintainer-fit notes.</li>
        <li>Public-safe PR packet preview.</li>
        <li>Ranked next actions.</li>
      </ul>

      <h2>Example invocation</h2>
      <CodeBlock
        lang="http"
        code={`POST /v1/local/branch-analysis
Authorization: Bearer ••••••••
Content-Type: application/json

{
  "repo": { "owner": "entrius", "repo": "gittensor" },
  "refs": { "base": "main", "head": "feat/scorer-cleanup" },
  "files": [ { "path": "src/scorer.ts", "added": 42, "removed": 8 } ],
  "labels": ["scorer", "ready-for-review"],
  "linked_issues": [421],
  "commits": ["refactor scorer gating", "fix linked-issue projection"]
}`}
      />

      <Callout variant="safety">
        File <strong>metadata</strong> is allowed (path, line counts). File contents are not
        requested, accepted, or stored. The MCP enforces this on the client.
      </Callout>
    </DocsPage>
  );
}
