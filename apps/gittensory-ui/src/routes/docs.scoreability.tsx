import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/scoreability")({
  head: () => ({
    meta: [
      { title: "Scoreability — Gittensory docs" },
      {
        name: "description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:title", content: "Scoreability — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Scoreability scenarios explained: current gated, underlying potential, clean-gate, after-pending-merges, linked-issue-fixed, best-reasonable. Estimates only.",
      },
      { property: "og:url", content: "/docs/scoreability" },
    ],
    links: [{ rel: "canonical", href: "/docs/scoreability" }],
  }),
  component: Scoreability,
});

function Scoreability() {
  return (
    <DocsPage
      eyebrow="Core concepts"
      title="Scoreability"
      description="Gittensory projects how scoreable your branch is under several scenarios. These are estimates, never guarantees."
    >
      <h2>The six scenarios</h2>
      <ul>
        <li>
          <strong>Current gated</strong> — what's scoreable right now, given all current gates.
        </li>
        <li>
          <strong>Underlying potential</strong> — the upper bound implied by the work itself,
          ignoring gates.
        </li>
        <li>
          <strong>Clean-gate</strong> — what becomes scoreable if branch hygiene issues are
          resolved.
        </li>
        <li>
          <strong>After-pending-merges</strong> — projection assuming pending related PRs merge.
        </li>
        <li>
          <strong>Linked-issue-fixed</strong> — projection assuming the linked issue is closed
          cleanly.
        </li>
        <li>
          <strong>Best reasonable case</strong> — the realistic upper bound across known cleanups.
        </li>
      </ul>

      <p>
        All six scenarios are recomputed on every push, so the numbers reflect the branch's latest
        state rather than a one-time snapshot.
      </p>

      <h2>Language rules</h2>
      <p>
        Use <code>scoreability</code>, <code>estimated score</code>,{" "}
        <code>underlying potential</code>, and <code>risk-adjusted priority</code>. Never say{" "}
        <em>guaranteed payout</em>, <em>guaranteed reward</em>, or anything implying outcome
        guarantees.
      </p>

      <h2>Example shape</h2>
      <CodeBlock
        lang="json"
        code={`{
  "scoreability": {
    "current_gated":        0.42,
    "underlying_potential": 0.83,
    "clean_gate":           0.71,
    "after_pending_merges": 0.66,
    "linked_issue_fixed":   0.78,
    "best_reasonable":      0.83
  },
  "blockers": ["unsquashed-commits", "missing-issue-link"],
  "risk_adjusted_priority": 0.61
}`}
      />

      <Callout variant="safety">
        Scoreability numbers and risk language are <strong>private</strong>. They appear only in
        MCP/API responses. They are never written to public GitHub surfaces.
      </Callout>
    </DocsPage>
  );
}
