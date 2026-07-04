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
      <h2>The seven scenarios</h2>
      <p>
        Every preview computes <code>scenarioPreviews</code>, an array of exactly seven named
        scenarios, alongside a top-level <code>effectiveEstimatedScore</code> and{" "}
        <code>underlyingPotentialScore</code> for the current state:
      </p>
      <ul>
        <li>
          <strong>current</strong> — what's scoreable right now, given all current gates and
          observed data.
        </li>
        <li>
          <strong>cleanGates</strong> — projection assuming every currently-failing gate (open-PR
          threshold, credibility floor, review penalty, etc.) clears.
        </li>
        <li>
          <strong>afterPendingMerges</strong> — projection assuming your other open PRs on this repo
          merge, relieving open-PR collateral.
        </li>
        <li>
          <strong>afterApprovedPrsMerge</strong> — projection assuming only your already-approved
          open PRs merge.
        </li>
        <li>
          <strong>afterStalePrsClose</strong> — projection assuming your stale open PRs close
          instead of merging.
        </li>
        <li>
          <strong>linkedIssueFixed</strong> — projection assuming the linked issue is validated and
          the standard issue multiplier applies.
        </li>
        <li>
          <strong>bestReasonableCase</strong> — the best of the above scenarios; the realistic upper
          bound across known cleanups.
        </li>
      </ul>
      <p>
        Each scenario carries its own <code>scoreEstimate</code>, <code>gates</code>,{" "}
        <code>effectiveEstimatedScore</code>, <code>underlyingPotentialScore</code>,{" "}
        <code>blockedBy</code>, and a human-readable <code>deltaExplanation</code>.
      </p>

      <h2>Language rules</h2>
      <p>
        Use <code>scoreability</code>, <code>estimated score</code>,{" "}
        <code>underlying potential</code>, and <code>scoreability status</code>. Never say{" "}
        <em>guaranteed payout</em>, <em>guaranteed reward</em>, or anything implying outcome
        guarantees.
      </p>

      <h2>Example shape</h2>
      <p>
        Trimmed for readability — the real response also includes <code>laneMath</code>,{" "}
        <code>gates</code>, <code>gateDeltas</code>, and per-scenario detail:
      </p>
      <CodeBlock
        lang="json"
        code={`{
  "effectiveEstimatedScore": 18.4,
  "underlyingPotentialScore": 31.2,
  "scoreabilityStatus": "conditionally_scoreable",
  "blockedBy": [
    { "code": "credibility_floor", "severity": "reducer", "detail": "..." }
  ],
  "scenarioPreviews": [
    { "name": "current", "effectiveEstimatedScore": 18.4, "blockedBy": [{ "code": "credibility_floor", "severity": "reducer", "detail": "..." }] },
    { "name": "cleanGates", "effectiveEstimatedScore": 24.9, "blockedBy": [] },
    { "name": "afterPendingMerges", "effectiveEstimatedScore": 21.0, "blockedBy": [{ "code": "open_pr_threshold", "severity": "reducer", "detail": "..." }] },
    { "name": "afterApprovedPrsMerge", "effectiveEstimatedScore": 19.7, "blockedBy": [{ "code": "open_pr_threshold", "severity": "reducer", "detail": "..." }] },
    { "name": "afterStalePrsClose", "effectiveEstimatedScore": 20.1, "blockedBy": [{ "code": "open_pr_threshold", "severity": "reducer", "detail": "..." }] },
    { "name": "linkedIssueFixed", "effectiveEstimatedScore": 27.6, "blockedBy": [] },
    { "name": "bestReasonableCase", "effectiveEstimatedScore": 31.2, "blockedBy": [] }
  ],
  "recommendation": { "level": "reasonable_fit", "actions": ["..."] },
  "warnings": ["..."],
  "assumptions": ["Advisory preview only; tied to the recorded scoring model snapshot..."]
}`}
      />
      <p>
        <code>scoreabilityStatus</code> is one of <code>blocked</code>,{" "}
        <code>conditionally_scoreable</code>, <code>scoreable</code>, or <code>hold</code> (the repo
        itself isn't actively scoreable — unregistered or inactive allocation).
      </p>

      <Callout variant="safety">
        Scoreability numbers and risk language are <strong>private</strong>. They appear only in
        MCP/API responses. They are never written to public GitHub surfaces.
      </Callout>
    </DocsPage>
  );
}
