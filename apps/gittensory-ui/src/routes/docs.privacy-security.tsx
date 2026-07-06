import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/privacy-security")({
  head: () => ({
    meta: [
      { title: "Privacy & security — Gittensory docs" },
      {
        name: "description",
        content:
          "Gittensory's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:title", content: "Privacy & security — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Gittensory's privacy posture: metadata-only MCP, no PATs, no wallet, no source upload, sanitized public output.",
      },
      { property: "og:url", content: "/docs/privacy-security" },
    ],
    links: [{ rel: "canonical", href: "/docs/privacy-security" }],
  }),
  component: PrivacySecurity,
});

function PrivacySecurity() {
  return (
    <DocsPage
      eyebrow="Operating"
      title="Privacy & security"
      description="Privacy is the product. These are hard rules, not best-effort goals."
    >
      <h2>Hard rules</h2>
      <ul>
        <li>No source upload by default. MCP sends metadata only.</li>
        <li>No PAT storage. Auth uses GitHub Device Flow.</li>
        <li>No wallet or hotkey display.</li>
        <li>No raw trust-score display.</li>
        <li>No payout/reward guarantees, anywhere.</li>
        <li>No farming language.</li>
        <li>No public score estimates.</li>
        <li>No private reviewability details in public GitHub output.</li>
      </ul>

      <h2>Open algorithm, private tuning</h2>
      <p>
        Gittensory's review engine is built so the{" "}
        <strong>logic is public but the dial settings are not</strong>. The deterministic gate, the
        scoring signals, the slop detector, the grounding/RAG context builders, and the comment
        renderer all live in the open source tree — anyone can read exactly how a verdict is
        reached. What stays private is the <strong>production tuning</strong>: the thresholds,
        guardrail paths, and gate modes an operator runs in production. That separation is what
        keeps a review from being gameable off the public code.
      </p>
      <p>
        Tuning lives in two private, repo-scoped places that sit on top of the open algorithm, and
        neither reveals review <em>direction</em>:
      </p>
      <ul>
        <li>
          <strong>Per-repo settings</strong> — gate modes, score thresholds, and guardrails, stored
          in the operator's database (set through the dashboard/API) or declared as config-as-code
          in a repo's <code>.gittensory.yml</code>. Choosing <code>gate.slop.minScore</code> or
          setting <code>settings.hardGuardrailGlobs</code> tightens the gate without telling a
          contributor how to bypass it.
        </li>
        <li>
          <strong>Operator feature flags</strong> — the <code>GITTENSORY_REVIEW_*</code> family of
          worker environment variables. These switch whole capabilities (safety scanning, CI and
          full-file grounding, RAG context, reputation-based spend control, the unified comment) on
          or off for a deployment.
        </li>
      </ul>
      <p>
        Every feature flag ships <strong>OFF</strong>, and a per-PR capability runs only when its
        own flag is on <em>and</em> the repo is in the <code>GITTENSORY_REVIEW_REPOS</code>{" "}
        allowlist — so capabilities stay dormant until an operator explicitly converges a repo, one
        flag and one repo at a time.
      </p>
      <CodeBlock
        code={`# Per-PR features run only when the flag is ON and the repo is allowlisted.
GITTENSORY_REVIEW_REPOS="JSONbored/gittensory"   # per-repo cutover allowlist (default: none)
GITTENSORY_REVIEW_SAFETY="true"                  # prompt-injection defang + secret-leak scan
GITTENSORY_REVIEW_GROUNDING="true"               # CI status + full changed-file content
GITTENSORY_REVIEW_RAG="true"                     # codebase vector-index context (needs index)
GITTENSORY_REVIEW_IMPACT_MAP="true"              # deterministic impact map (needs review.impact_map too)
GITTENSORY_REVIEW_CULTURE_PROFILE="true"         # repo quality-culture profile (needs review.culture_profile: true)
GITTENSORY_REVIEW_REPUTATION="true"              # submitter-reputation spend control (never shown)
GITTENSORY_REVIEW_UNIFIED_COMMENT="true"         # one in-place unified PR comment
GITTENSORY_REVIEW_ENRICHMENT="true"              # external analyzer registry (REES) findings
GITTENSORY_REVIEW_INLINE_COMMENTS="true"         # diff-anchored inline PR review comments
GITTENSORY_REVIEW_TEST_GENERATION="true"         # boundary-safe test-gen action spec (contributor-run)
GITTENSORY_REVIEW_FIX_HANDOFF="true"             # machine-readable fix-handoff block (contributor-run)
GITTENSORY_REVIEW_PLANNER="true"                 # @gittensory plan on-demand implementation plan
GITTENSORY_REVIEW_SCREENSHOTS="true"             # before/after visual capture for UI changes

# Global (cron / endpoint) flags, not scoped by GITTENSORY_REVIEW_REPOS.
GITTENSORY_REVIEW_OPS="true"                     # read-only anomaly scan + outcome stats endpoint
GITTENSORY_REVIEW_SELFTUNE="true"                # self-tightening tuning loop, never loosens
GITTENSORY_REVIEW_PARITY_AUDIT="true"            # shadow-record gate-decision parity readiness
GITTENSORY_REVIEW_CONTENT_LANE="true"            # dedicated content/registry-repo review lane
GITTENSORY_REVIEW_DRAFT="true"                   # public draft-submission (contributor fork PR) flow`}
      />
      <p>
        The internal-only controls never surface publicly. Submitter reputation, for example, can
        downgrade a burst or low-reputation submitter to a deterministic-only review — but no
        comment, label, or check ever shows a reputation value. Reputation thresholds are generic
        anti-abuse defaults that reveal no review direction and are not per-repo tunable.
      </p>
      <Callout variant="safety">
        Reading the open source tells you <strong>how</strong> a verdict is computed, never{" "}
        <strong>what</strong> an operator's production gate will decide. The deciding inputs —
        thresholds, guardrail globs, and which <code>GITTENSORY_REVIEW_*</code> capabilities are
        live — are private runtime settings, so reviews cannot be reverse-engineered or gamed from
        the public code.
      </Callout>

      <h2>Public output rules</h2>
      <ul>
        <li>At most one sticky sanitized comment per confirmed-miner PR.</li>
        <li>At most one configured label per confirmed-miner PR.</li>
        <li>Public comments are maintainer-friendly and non-shaming.</li>
      </ul>

      <h2>Auth</h2>
      <ul>
        <li>
          Public endpoint: <code>GET /health</code>.
        </li>
        <li>Private API uses Bearer / session tokens.</li>
        <li>MCP CLI uses GitHub OAuth Device Flow.</li>
        <li>Static bearer tokens remain internal / bootstrap only.</li>
      </ul>

      <Callout variant="safety">
        Website copy may discuss private scoreability and risk reasoning, but it's always framed as{" "}
        <strong>private MCP/API context</strong>. The public web never carries score numbers.
      </Callout>
    </DocsPage>
  );
}
