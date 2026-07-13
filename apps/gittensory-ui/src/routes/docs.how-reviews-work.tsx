import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/how-reviews-work")({
  head: () => ({
    meta: [
      { title: "How reviews work — LoopOver docs" },
      {
        name: "description",
        content:
          "How LoopOver reviews a pull request: the deterministic gate, the dual-AI review and consensus, the unified review comment, and the signals behind a verdict.",
      },
      { property: "og:title", content: "How reviews work — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How LoopOver reviews a pull request: the deterministic gate, the dual-AI review and consensus, the unified review comment, and the signals behind a verdict.",
      },
      { property: "og:url", content: "/docs/how-reviews-work" },
    ],
    links: [{ rel: "canonical", href: "/docs/how-reviews-work" }],
  }),
  component: HowReviewsWork,
});

function HowReviewsWork() {
  return (
    <DocsPage
      eyebrow="Reviews"
      title="How reviews work"
      description="What LoopOver does when a pull request opens — the gate, the dual-AI review and consensus, and the single comment that surfaces it."
    >
      <h2>The shape of a review</h2>
      <p>
        When a pull request opens or updates, <strong>LoopOver CI</strong> runs a review in two
        layers and reports the result in one place:
      </p>
      <ol>
        <li>
          <strong>The gate</strong> — a deterministic pass that never asks an AI. It runs a fixed
          set of rules (duplicates, linked issues, merge-readiness, anti-slop, manifest policy) and
          each rule is <code>off</code>, <code>advisory</code>, or <code>block</code>.
        </li>
        <li>
          <strong>The AI review</strong> — a dual-model read of the diff that writes review notes
          and, when you opt in, lets a high-confidence <em>consensus</em> become a blocker.
        </li>
      </ol>
      <p>
        comment on the PR, plus an optional <strong>Gittensory Orb Review Agent</strong> check run.
        The review algorithm is open-source; what changes between repos is the configuration you
        tune. See <a href="/docs/tuning">Tuning your reviews</a> for the review options and
        defaults.
      </p>
      <Callout variant="safety">
        Defaults are quiet. With no settings and no <code>.loopover.yml</code> (or legacy{" "}
        <code>.gittensory.yml</code>, #4773), the gate is <code>off</code>, AI review is{" "}
        <code>off</code>, and the comment is posted only to detected contributors. Every capability
        is an explicit opt-in.
      </Callout>

      <h2>1. The gate: advisory vs. block</h2>
      <p>
        The gate is deterministic — same inputs, same verdict, no model in the loop. Its master
        switch is <code>reviewCheckMode</code> (<code>required</code> / <code>visible</code> /{" "}
        <code>disabled</code>). Once enabled, each <em>dimension</em> is independently set to one of
        three modes:
      </p>
      <ul>
        <li>
          <code>off</code> — the dimension is not evaluated at all.
        </li>
        <li>
          <code>advisory</code> — the finding is <strong>surfaced</strong> in the comment, but it
          never blocks the merge.
        </li>
        <li>
          <code>block</code> — the finding can become a hard{" "}
          <strong>Gittensory Orb Review Agent</strong> blocker.
        </li>
      </ul>
      <p>
        A <code>block</code> outcome fails the gate for any author identically — confirmed-
        Gittensor-contributor status doesn't change <em>who</em> can be blocked, only the mode
        chooses <em>which</em> checks are active. Confirmed status is carried through for on-chain
        scoring, a separate concern from the gate's own merge/close decision.
      </p>

      <h3>The gate dimensions</h3>
      <p>These are the deterministic rules the gate runs, with their default modes:</p>
      <ul>
        <li>
          <strong>Duplicate-PR gate</strong> (<code>duplicatePrGateMode</code>, default{" "}
          <code>block</code>) — detects duplicate or superseding PRs.
        </li>
        <li>
          <strong>Linked-issue gate</strong> (<code>linkedIssueGateMode</code>, default{" "}
          <code>advisory</code>) — checks the PR references an issue, as strongly as{" "}
          <code>linkedIssuePolicy</code> asks.
        </li>
        <li>
          <strong>Quality / merge-readiness score gate</strong> (<code>qualityGateMode</code>,
          default <code>advisory</code>) — the PR-quality score; passes at or above{" "}
          <code>qualityGateMinScore</code>.
        </li>
        <li>
          <strong>Slop gate</strong> (<code>slopGateMode</code>, default <code>off</code>) — the
          deterministic anti-slop signal. <code>advisory</code> surfaces the slop score and
          warnings; <code>block</code> also hard-blocks at or above <code>slopGateMinScore</code>{" "}
          (engine default band <code>60</code>).
        </li>
        <li>
          <strong>Copycat / plagiarism gate</strong> (<code>copycatGateMode</code>, default{" "}
          <code>off</code>) — a code containment/similarity check against prior art (repo history,
          other PRs). Escalating tiers: <code>warn</code>, <code>label</code>, <code>block</code>,
          plus a further strikes escalation for repeat offenders. Config only today — the detection
          engine itself has not shipped yet, so setting this has no effect until it does.
        </li>
        <li>
          <strong>Merge-readiness gate</strong> (<code>mergeReadinessGateMode</code>, default{" "}
          <code>off</code>) — a composite readiness check.
        </li>
        <li>
          <strong>Manifest-policy gate</strong> (<code>manifestPolicyGateMode</code>, default{" "}
          <code>off</code>) — when <code>block</code>, the repo's declared policy (required linked
          issue and test expectations) becomes enforceable. Manual-review path holds are controlled
          separately by <code>settings.hardGuardrailGlobs</code>.
        </li>
        <li>
          <strong>PR-size hold</strong> (<code>sizeGateMode</code>, default <code>off</code>) — a PR
          at or above the configured file/line thresholds is held for manual review, never a hard
          failure.
        </li>
        <li>
          <strong>Lockfile-integrity gate</strong> (<code>lockfileIntegrityGateMode</code>, default{" "}
          <code>off</code>) — flags a lockfile-tamper-risk finding (a resolved/integrity change with
          no matching version bump, or a dependency pointed off the npm registry).
        </li>
        <li>
          <strong>CLA / license gate</strong> (<code>claGateMode</code>, default <code>off</code>) —
          CLA / license-compatibility check.
        </li>
        <li>
          <strong>Self-authored-linked-issue gate</strong> (
          <code>selfAuthoredLinkedIssueGateMode</code>, default <code>advisory</code>) — flags or
          blocks a PR whose author also opened the linked issue.
        </li>
        <li>
          <strong>Linked-issue satisfaction gate</strong> (
          <code>linkedIssueSatisfactionGateMode</code>, default <code>off</code>) — an AI assessment
          of whether the PR's diff actually satisfies its primary linked issue's intent (distinct
          from the linked-issue gate above, which only checks that a link exists).{" "}
          <code>advisory</code> renders the assessment in the review comment without ever blocking;{" "}
          <code>block</code> additionally lets a confidence-floor-passing "unaddressed" verdict
          become a hard blocker.
        </li>
        <li>
          <strong>Moderation-rules engine</strong> (<code>moderationGateMode</code>, default{" "}
          <code>inherit</code>) — whether the contributor-cap / blacklist / review-nag mechanisms
          feed a shared, cross-repo violation tally on this repo; <code>inherit</code> defers to the
          instance-wide default, <code>off</code>/<code>enabled</code> force it per repo.
        </li>
      </ul>
      <p>
        Which deterministic rules even apply is set by the <strong>policy pack</strong> (
        <code>gatePack</code>): <code>gittensor</code> (registry-aware, tracks confirmed-Gittensor-
        contributor status for scoring) or <code>oss-anti-slop</code> (runs the rules against any
        author on any repo, with no confirmed-contributor tracking at all).
      </p>
      <CodeBlock
        filename=".loopover.yml"
        code={`gate:
  enabled: true
  pack: gittensor
  duplicates: block
  linkedIssue: advisory
  readiness:
    mode: advisory
    minScore: 70
  slop:
    mode: block
    minScore: 60
  mergeReadiness: advisory
  manifestPolicy: block`}
      />

      <h2>2. The dual-AI review and consensus</h2>
      <p>
        AI review is its own dimension (<code>aiReviewMode</code>, default <code>off</code>). It
        reads the diff and produces review notes — concrete findings tied to the change, not a vague
        verdict. Two modes:
      </p>
      <ul>
        <li>
          <code>advisory</code> — the AI write-up is posted as notes only. It never blocks.
        </li>
        <li>
          <code>block</code> — a <strong>dual-model high-confidence consensus</strong> defect is
          allowed to become a blocker.
        </li>
      </ul>
      <p>
        By default, the blocking decision runs on a <strong>pair</strong> of free models and only
        blocks when <em>both</em> models independently agree, with high confidence, on a real defect
        — no single-model block and no tie-breaker third model, so a confident-but-wrong single
        model can't block a good PR on its own. An operator can override this per repo (
        <code>aiReviewCombine</code>: <code>single</code> / <code>consensus</code> /{" "}
        <code>synthesis</code>); in <code>single</code> mode, one reviewer's verdict is the
        decision.
      </p>

      <h3>Bring your own model (advisory only)</h3>
      <p>
        With <code>aiReviewByok: true</code> and a configured provider key, the <em>advisory</em>{" "}
        write-up can use a maintainer's own frontier model (<code>aiReviewProvider</code> /{" "}
        <code>aiReviewModel</code>, e.g. <code>claude-3-5-sonnet-latest</code>). The consensus
        blocker always stays on the free model pair, so BYOK improves the prose without ever
        changing <em>who</em> can be blocked.
      </p>
      <Callout variant="note" title="Grounding makes the AI check reality">
        The <code>GITTENSORY_REVIEW_GROUNDING</code> flag grounds the reviewer prompt with the PR's
        finished CI status and the full post-change content of the changed files — so the model
        verifies its claims instead of predicting CI or flagging a symbol defined just outside the
        diff hunk. <code>GITTENSORY_REVIEW_RAG</code> adds semantically related existing code and
        docs as extra context. Both are additive and opt-in.
      </Callout>

      <h2>3. The unified review comment</h2>
      <p>
        The result is rendered as <strong>one in-place comment</strong> on the PR — updated in place
        on each push rather than stacked — when <code>GITTENSORY_REVIEW_UNIFIED_COMMENT</code> is on
        for the repo. It has three parts, top to bottom:
      </p>
      <ul>
        <li>
          <strong>The alert</strong> — a one-line headline verdict: whether the gate blocks, what
          the single most important blocker is, or that the PR is clear. This is the line a reader
          scans first.
        </li>
        <li>
          <strong>The signal table</strong> — a compact row-per-signal summary: each dimension that
          ran, its state (pass / advisory / block), and a short reason. This is the at-a-glance map
          of why the verdict came out the way it did.
        </li>
        <li>
          <strong>Collapsibles</strong> — expandable sections for the detail behind each signal: the
          AI review notes, the slop warnings, duplicate matches, manifest findings. Folded away by
          default so the comment stays short, opened when a reader wants the evidence.
        </li>
      </ul>
      <p>
        Who sees the comment, and how much detail it carries, is a repo setting:{" "}
        <code>commentMode</code> chooses the audience (<code>off</code> /{" "}
        <code>detected_contributors_only</code> / <code>all_prs</code>), and{" "}
        <code>publicSignalLevel</code> (<code>minimal</code> / <code>standard</code>) controls how
        much of the signal detail is published. Private review context (<code>maintainerNotes</code>
        ) is never published to a public surface.
      </p>
      <Callout variant="safety">
        Public-facing comments are sanitized before they leave the worker. Private scoring, reward,
        and reputation language never appears in the PR thread — and reputation-based spend control
        (<code>GITTENSORY_REVIEW_REPUTATION</code>) is never surfaced in any comment, label, or
        check.
      </Callout>

      <h2>4. The signals behind a verdict</h2>
      <p>Each row in the signal table comes from a named finding. The common ones you will see:</p>
      <ul>
        <li>
          <code>secret_leak</code> — the safety scan (<code>GITTENSORY_REVIEW_SAFETY</code>) found a
          leaked secret in the diff. The same scan also defangs untrusted PR text before the AI
          reviewer reads it.
        </li>
        <li>
          <code>guardrail_hold</code> — the PR touches a path listed in{" "}
          <code>settings.hardGuardrailGlobs</code>. This is a manual-review hold, not an auto-close
          reason.
        </li>
        <li>
          <code>manifest_missing_tests</code> — code changed but the expected test paths (
          <code>testExpectations</code>) did not.
        </li>
        <li>
          <strong>Slop score + warnings</strong> — the deterministic anti-slop signal. With{" "}
          <code>slopAiAdvisory: true</code>, a free advisory-only <code>ai_slop_advisory</code>{" "}
          finding is added too — it never feeds the score or the gate.
        </li>
        <li>
          <strong>Duplicate match</strong> — the other PR this one duplicates or supersedes.
        </li>
        <li>
          <strong>AI review notes</strong> — the dual-model findings, and (in <code>block</code>{" "}
          mode) any consensus defect.
        </li>
      </ul>
      <p>
        The check run can carry the same signals at adjustable depth — but this is the{" "}
        <strong>Gittensory Context</strong> check, not the Orb Review Agent gate check:{" "}
        <code>checkRunMode</code> (<code>off</code> / <code>enabled</code>) publishes it, and{" "}
        <code>checkRunDetailLevel</code> (<code>minimal</code> / <code>standard</code>) sets how
        much the check summary spells out. <strong>Gittensory Orb Review Agent</strong> is published
        separately, controlled by <code>reviewCheckMode</code> (see above).
      </p>

      <h2>Putting it together</h2>
      <p>
        A pull request flows through the deterministic gate, then the dual-AI review, and the union
        of both is rendered as one alert + signal table + collapsibles comment. The gate decides{" "}
        <em>can this merge</em> with fixed rules you can read; the AI review adds judgment as
        advisory notes, escalating to a blocker only on two-model consensus; and the comment is the
        single, sanitized place a contributor reads the whole verdict. Tune every mode, threshold,
        and surface in <a href="/docs/tuning">Tuning your reviews</a>.
      </p>
    </DocsPage>
  );
}
