import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/tuning")({
  head: () => ({
    meta: [
      { title: "Tuning your reviews — Gittensory docs" },
      {
        name: "description",
        content:
          "Configure Gittensory CI and Gittensory review: gate modes, score thresholds, guardrails, and feature flags via .gittensory.yml and repo settings.",
      },
      { property: "og:title", content: "Tuning your reviews — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Configure Gittensory CI and Gittensory review: gate modes, score thresholds, guardrails, and feature flags via .gittensory.yml and repo settings.",
      },
      { property: "og:url", content: "/docs/tuning" },
    ],
    links: [{ rel: "canonical", href: "/docs/tuning" }],
  }),
  component: Tuning,
});

function Tuning() {
  return (
    <DocsPage
      eyebrow="Operating"
      title="Tuning your reviews"
      description="How to configure Gittensory CI and Gittensory review — gate modes, score thresholds, guardrails, and feature flags — through .gittensory.yml and your repo settings."
    >
      <h2>How configuration fits together</h2>
      <p>
        <strong>Gittensory review</strong> is the engine that scores, gates, and comments on your
        pull requests. You shape its behavior in two places, and you never have to touch the review
        algorithm itself:
      </p>
      <ul>
        <li>
          <strong>Per-repo settings</strong> — gate modes, score thresholds, guardrails, and which
          surfaces are enabled. Set them in the dashboard, or declare them as config-as-code in a{" "}
          <code>.gittensory.yml</code> file in the repo.
        </li>
        <li>
          <strong>Feature flags</strong> — the <code>GITTENSORY_REVIEW_*</code> family of
          environment variables on the worker. These switch whole capabilities (safety scanning,
          grounding, RAG context, the unified comment, the content lane, observability, self-tuning,
          and more) on or off for the deployment.
        </li>
      </ul>
      <p>
        The review algorithm — the deterministic gate, the scoring signals, the slop detector, the
        grounding and RAG context builders, and the comment renderer — is open source. Anyone can
        read exactly how a verdict is reached. The settings above sit <em>on top</em> of that open
        algorithm and never reveal review <em>direction</em>, so a contributor cannot read them and
        game the gate.
      </p>
      <p>
        This page covers those fields in depth, for the cloud service or a self-host alike. If
        you're running your own instance, see{" "}
        <Link to="/docs/self-hosting-configuration">Self-host configuration</Link> for the
        environment layer (deployment-wide flags, secrets, and where config files can live) that
        sits underneath everything below.
      </p>

      <Callout variant="safety" title="Defaults are safe and conservative">
        Every feature flag ships <strong>OFF</strong>. A repo with no settings and no{" "}
        <code>.gittensory.yml</code> falls back to a quiet, non-blocking profile: the gate is{" "}
        <code>off</code>, AI review is <code>off</code>, slop scoring is <code>off</code>, comments
        go only to detected contributors, and no check-run is published. Turning anything on is
        always an explicit opt-in — you roll capabilities forward, and back, one flag and one repo
        at a time.
      </Callout>

      <h2>Precedence</h2>
      <p>Most specific wins:</p>
      <ul>
        <li>
          <code>.gittensory.yml</code> in the repo, then
        </li>
        <li>per-repo database settings, then</li>
        <li>built-in safe defaults.</li>
      </ul>
      <p>
        Path holds are explicit config-as-code only: a configured{" "}
        <code>settings.hardGuardrailGlobs</code> ADDS repo-specific globs on top of a fixed set of
        built-in invariant guardrails that always apply and can never be disabled. Omitted or empty
        means only those built-in invariants hold.
      </p>
      <p>
        The friendly <code>gate:</code> block in <code>.gittensory.yml</code> is a typed alias for
        the gate-related fields and wins over the generic <code>settings:</code> block for those
        same fields. Gittensory looks for the manifest at the first match of{" "}
        <code>.gittensory.yml</code> → <code>.github/gittensory.yml</code> →{" "}
        <code>.gittensory.json</code> → <code>.github/gittensory.json</code>.
      </p>

      <h2>Feature flags (GITTENSORY_REVIEW_*)</h2>
      <p>
        These are worker environment variables, every one defaulting to <strong>OFF</strong>.
        "Truthy" means one of <code>1</code>, <code>true</code>, <code>yes</code>, or{" "}
        <code>on</code> (case-insensitive); anything else — including unset, empty, or{" "}
        <code>false</code> — is OFF. When a flag is OFF its code path is inert: the review behaves
        exactly as if the feature did not exist.
      </p>
      <p>
        One flag is a <strong>scope</strong> rather than a capability:{" "}
        <code>GITTENSORY_REVIEW_REPOS</code> is a per-repo allowlist that must <em>also</em> pass
        for any per-PR feature to run on a given repo. So a per-PR feature activates only when{" "}
        <strong>its own flag is ON and the repo is allowlisted</strong>.
      </p>
      <ul>
        <li>
          <code>GITTENSORY_REVIEW_REPOS</code> — the per-repo allowlist. Comma-separated{" "}
          <code>owner/repo</code> names that may run the per-PR features (safety, grounding, RAG,
          reputation, unified comment). Empty or unset means no repos — every per-PR feature stays
          dormant for everyone regardless of the global flags. Case-insensitive and trimmed; stray
          commas are ignored. The cron and endpoint flags (ops, self-tune, parity audit, content
          lane, draft) are <strong>not</strong> scoped by this list.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_SAFETY</code> — safety scan in the review path: it neutralizes
          prompt-injection in untrusted PR title/body/diff before the AI reviewer sees it, and scans
          the diff for leaked secrets, surfacing a <code>secret_leak</code> blocker. Per-PR (also
          needs the repo in the allowlist).
        </li>
        <li>
          <code>GITTENSORY_REVIEW_GROUNDING</code> — grounds the AI reviewer with the PR's{" "}
          <em>finished</em> CI status plus the <em>full post-change content</em> of the changed
          files, so the model verifies claims against reality instead of predicting CI or flagging
          symbols defined just outside the diff hunk. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_E2E_TESTS</code> — master kill-switch for the opt-in,
          maintainer-triggered AI-generated E2E test coverage feature. Off by default; a repo also
          needs its own <code>features.e2eTests: true</code> override in{" "}
          <code>.gittensory.yml</code> before the feature is active for it. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_IMPROVEMENT_SIGNAL</code> — master kill-switch for the read-only,
          advisory PR quality-delta signal (the positive-axis counterpart to the slop risk score).
          Off by default; config-as-code activation only for now — no tier reads the resolved value
          yet, so turning this on has no visible effect until a later release wires real behavior
          behind it. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_CONTINUOUS</code> — fleet-wide default AI review re-trigger
          cadence. Off by default (one-shot): AI-generated content (main review, slop advisory,
          linked-issue satisfaction) is produced once per PR and never regenerated automatically
          afterward — only an explicit maintainer retrigger (the PR-panel checkbox, or{" "}
          <code>@gittensory review</code> as a maintainer) spends a fresh call. Truthy switches the
          fleet default to continuous — every push/CI-completion/sweep re-runs AI content
          generation. A repo's own <code>review.auto_review.cadence</code> in{" "}
          <code>.gittensory.yml</code> always overrides this default, in either direction. Never
          affects the deterministic gate (CI status, mergeability, static-rule blockers), which
          always re-evaluates regardless.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_RAG</code> — retrieval-augmented context: queries the codebase
          vector index for related code and docs (callers, related modules, existing conventions)
          and appends a "Relevant existing code / docs" section to the reviewer prompt. Additive
          only. Inert until a vector index exists for the repo — a cold or missing index degrades to
          no context. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_IMPACT_MAP</code> — deterministic impact map: from the codebase
          vector index plus the PR's changed exported symbols, computes which other repo files
          plausibly need re-checking, and renders that as a compact section in the unified review
          comment (also feeds it to the AI reviewer as additive reference context). ANDed with the
          per-repo <code>review.impact_map</code> opt-in — neither alone is sufficient. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_CULTURE_PROFILE</code> — appends a "repo quality-culture profile"
          reference block to the reviewer prompt: typical merged-PR size and common accepted labels,
          derived from this repo's own merge history. Additive reference only — never a gate or
          scoring input. Also requires the per-repo <code>review.culture_profile: true</code> opt-in
          in <code>.gittensory.yml</code>. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_MEMORY</code> — repeat-false-positive suppression: matches an
          advisory (non-blocking) AI finding against this repo's stored suppression signals (a
          maintainer's own past false-positive dismissals) and demotes or drops it before the
          unified comment renders. A maintainer records a signal with{" "}
          <code>@gittensory resolve [finding-code]</code> (or a whole-PR{" "}
          <code>@gittensory resolve</code> ack). Advisory-only by construction — never applied to
          gate blockers, so it can never change the merge/close disposition. Also requires the
          per-repo <code>review.memory: true</code> opt-in in <code>.gittensory.yml</code>. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_REPUTATION</code> — submitter-reputation spend control. A new,
          burst, or low-reputation submitter is downgraded to a deterministic-only review; good
          reputation proceeds normally. Never surfaced publicly — no comment, label, or check shows
          reputation. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_UNIFIED_COMMENT</code> — renders the public PR comment as one
          in-place unified comment instead of the legacy multi-panel comment. Per-PR. With the flag
          off, the legacy comment is byte-identical.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_ENRICHMENT</code> — runs the review-enrichment analyzer registry
          (duplication, churn hotspots, blame links, approval integrity, undocumented exports, and
          more) and folds their findings into the review context. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_INLINE_COMMENTS</code> — posts AI-review findings as inline
          diff-anchored PR review comments instead of (or alongside) the summary comment. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_FIX_HANDOFF</code> — renders a review finding as a structured,
          machine-readable "apply this fix" block for the contributor's own local agent to consume —
          content only, no server-side write, no execution. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_PLANNER</code> — enables <code>@gittensory plan</code>, an
          on-demand structured implementation plan posted to the PR thread. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_SCREENSHOTS</code> — visual capture: renders and attaches
          before/after screenshots for PRs that change UI. Per-PR.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_OPS</code> — observability, read-only. On the cron tick an anomaly
          scan over the gate-block ledger and calibration data emits a structured{" "}
          <code>ops_anomaly</code> log when something drifts, and a bearer-gated{" "}
          <code>GET /v1/internal/ops/stats</code> serves an outcome aggregate. Does not mutate
          config. Global.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_SELFTUNE</code> — the self-improvement loop. On the cron tick it
          computes tuning recommendations from your own outcome data, shadow-soaks any strictly
          tightening recommendation, and auto-promotes it only after the soak passes. It can{" "}
          <strong>only ever tighten</strong> the gate — a loosening recommendation is never applied.
          Global, and safe to leave on.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_PARITY_AUDIT</code> — parity readiness, shadow record-only.
          Records each finalized gate decision and serves a readiness report at{" "}
          <code>GET /v1/internal/parity</code>. Changes no review behavior. Global.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_CONTENT_LANE</code> — routes content repos (curated lists,
          registries) through the dedicated content lane — duplicate detection, source-evidence
          reachability, security scanning, scope classification, registry grounding — instead of the
          code gate. Global.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_DRAFT</code> — the public draft-submission flow (the{" "}
          <code>/v1/drafts</code> endpoints: contributor draft → GitHub OAuth → fork PR). With the
          flag off every draft endpoint 404s. Requires the{" "}
          <code>DRAFT_TOKEN_ENCRYPTION_SECRET</code> and <code>GITHUB_OAUTH_CLIENT_SECRET</code>{" "}
          secrets. Global.
        </li>
        <li>
          <code>GITTENSORY_REVIEW_STATS_TOKEN</code> — the bearer secret for the stats data
          endpoint. Not an on/off switch; it is the token value. When set, the stats route requires
          this bearer token.
        </li>
      </ul>

      <Callout variant="note" title="Rolling out a per-PR feature">
        A safe rollout is two flips: turn the capability flag <code>true</code>, then add the repo
        to <code>GITTENSORY_REVIEW_REPOS</code>. Because both must be true, you can leave a
        capability globally enabled while it stays dormant everywhere except the repos you have
        explicitly allowlisted — and you roll a single repo back by removing it from the list
        without disturbing the others.
      </Callout>

      <h2>Gate modes</h2>
      <p>
        Per-repo behavior is the <strong>effective settings</strong>: the database row for the repo,
        overlaid with the repo's <code>.gittensory.yml</code>. Most gate dimensions are tri-state:
      </p>
      <ul>
        <li>
          <code>off</code> — the dimension is not evaluated.
        </li>
        <li>
          <code>advisory</code> — the finding is surfaced in the comment or context but never
          blocks.
        </li>
        <li>
          <code>block</code> — the finding can become a hard{" "}
          <code>Gittensory Orb Review Agent</code> blocker. A block outcome fails the gate for any
          author identically — confirmed-Gittensor-contributor status doesn&apos;t change{" "}
          <em>who</em> can be blocked, only the mode chooses <em>which</em> deterministic checks are
          active. Confirmed status is carried through for on-chain scoring, a separate concern from
          the gate&apos;s own merge/close decision.
        </li>
      </ul>
      <p>
        The master switch is <code>gate.enabled</code> (<code>off</code> / <code>enabled</code>).
        The per-dimension modes refine an already-enabled gate. The main dimensions:
      </p>
      <ul>
        <li>
          <code>gate.pack</code> — the policy pack: <code>gittensor</code> (default; registry-aware,
          tracks confirmed-Gittensor-contributor status for scoring) or <code>oss-anti-slop</code>{" "}
          (runs the deterministic rules against any author on any repo, with no
          confirmed-contributor tracking at all).
        </li>
        <li>
          <code>gate.duplicates</code> — duplicate / superseding-PR detection. Default{" "}
          <code>block</code>.
        </li>
        <li>
          <code>gate.linkedIssue</code> — what happens when a PR has <em>no linked issue at all</em>
          {". "}Default <code>advisory</code> (surfaced in the review panel, never blocks — issues
          aren&apos;t always available). Set <code>block</code>, or turn on the dashboard "Require
          linked issue" toggle, to make a missing issue an explicit opt-in blocker (if the toggle is
          on but this is still <code>off</code>, it is auto-promoted to <code>block</code>). This is
          unrelated to closing a PR that links an <em>ineligible</em> issue (owner-assigned, wrong
          label, etc.) — that is a separate, deterministic rule, not this gate.
        </li>
        <li>
          <code>gate.readiness.mode</code> — the PR-quality / merge-readiness score gate. Default{" "}
          <code>advisory</code>. Pair it with <code>gate.readiness.minScore</code> (0–100; at or
          above this score the quality dimension passes; <code>null</code> uses the engine's default
          band).
        </li>
        <li>
          <code>gate.slop.mode</code> — the deterministic anti-slop signal. Default <code>off</code>{" "}
          (opt-in). <code>advisory</code> surfaces the slop score and warnings; <code>block</code>{" "}
          also hard-blocks at or above <code>gate.slop.minScore</code> (0–100; <code>null</code>{" "}
          uses <code>60</code>, the "high" band). Set <code>gate.slop.aiAdvisory: true</code> to add
          a free advisory-only <code>ai_slop_advisory</code> finding — it never feeds the slop score
          or the gate.
        </li>
        <li>
          <code>gate.copycat.mode</code> — code containment/similarity gate against prior art (repo
          history, other PRs). Default <code>off</code>. Escalating tiers: <code>warn</code>,{" "}
          <code>label</code>, <code>block</code>, plus a further strikes escalation for repeat
          offenders. Pair it with <code>gate.copycat.minScore</code> (0–100). Config only today —
          the detection engine has not shipped yet, so this has no effect until it does.
        </li>
        <li>
          <code>gate.mergeReadiness</code> — composite merge-readiness gate. Default{" "}
          <code>off</code>, no min score.
        </li>
        <li>
          <code>gate.manifestPolicy</code> — when <code>block</code>, the manifest's declared policy
          (required linked issue and test expectations) becomes an enforceable blocker.
          Manual-review path holds use <code>settings.hardGuardrailGlobs</code> instead. Default{" "}
          <code>off</code>.
        </li>
        <li>
          <code>gate.size</code> — PR-size hold: flags an oversized diff. Default <code>off</code>.
        </li>
        <li>
          <code>gate.lockfileIntegrity</code> — flags lockfile-tamper risk (a lockfile changed
          without its matching manifest, or vice versa). Default <code>off</code>.
        </li>
        <li>
          <code>gate.claMode</code> — CLA / license-acknowledgment gate. Default <code>off</code>.
        </li>
        <li>
          <code>gate.selfAuthoredLinkedIssue</code> — whether a PR may link an issue opened by the
          same author. Default <code>advisory</code>.
        </li>
        <li>
          <code>gate.linkedIssueSatisfaction</code> — an AI assessment of whether the PR's diff
          actually satisfies its primary linked issue's intent, distinct from{" "}
          <code>gate.linkedIssue</code> (which only checks a link exists). Default <code>off</code>.{" "}
          <code>advisory</code> renders the assessment in the review comment without blocking;{" "}
          <code>block</code> additionally lets a confidence-floor-passing "unaddressed" verdict
          become a blocker.
        </li>
        <li>
          <code>settings.moderationGateMode</code> — whether the moderation-rules engine
          (contributor cap, blacklist, review-nag feeding a shared cross-repo violation tally) runs
          on this repo at all. <code>inherit</code> (default) defers to the instance-wide{" "}
          <code>global_moderation_config.enabled</code>; <code>off</code>/<code>enabled</code> force
          this repo regardless of the global default.
        </li>
        <li>
          <code>gate.aiReview.mode</code> — AI review. Default <code>off</code>.{" "}
          <code>advisory</code> posts AI review notes only; <code>block</code> lets a dual-model
          high-confidence consensus defect become a blocker.
        </li>
      </ul>

      <h3>Bring your own model (AI review)</h3>
      <p>
        The AI-review write-up can optionally use your own frontier model. By default the blocking
        decision runs on a pair of free built-in models and requires agreement; an operator can
        override this per repo with <code>aiReviewCombine</code> (<code>single</code> /{" "}
        <code>consensus</code> / <code>synthesis</code>) — in <code>single</code> mode, one
        reviewer's verdict is the decision. BYOK changes which model writes the advisory text, not
        this combine behavior.
      </p>
      <ul>
        <li>
          <code>gate.aiReview.byok</code> — when <code>true</code> and a provider key is configured,
          the advisory write-up uses the maintainer's frontier model. Default <code>false</code>.
        </li>
        <li>
          <code>gate.aiReview.provider</code> — <code>anthropic</code>, <code>openai</code>, or{" "}
          <code>null</code> (use the stored key's own provider). Must match the stored key's
          provider or BYOK is skipped and falls back to the built-in pair.
        </li>
        <li>
          <code>gate.aiReview.model</code> — model override for the BYOK write-up (for example{" "}
          <code>claude-3-5-sonnet-latest</code>); <code>null</code> uses the key record's model,
          else a conservative per-provider default.
        </li>
      </ul>
      <Callout variant="safety">
        The provider key itself never lives in <code>.gittensory.yml</code>. It is held only in the
        encrypted key store and unlocked by the <code>TOKEN_ENCRYPTION_SECRET</code> worker secret —
        absent that secret, BYOK is unavailable and AI review silently falls back to the free
        built-in model pair.
      </Callout>

      <h2>Guardrails and scope</h2>
      <p>
        Top-level keys in <code>.gittensory.yml</code> declare the repo's focus and validation
        expectations. These feed deterministic findings such as <code>manifest_missing_tests</code>{" "}
        and — when <code>gate.manifestPolicy: block</code> — can become enforceable blockers. Manual
        path holds are configured only through <code>settings.hardGuardrailGlobs</code>.
      </p>
      <ul>
        <li>
          <code>wantedPaths</code> — globs for work areas you want; PRs touching these are
          preferred. Default <code>[]</code>.
        </li>
        <li>
          <code>preferredLabels</code> — labels you prefer on incoming PRs; a missing one is
          surfaced. Default <code>[]</code>.
        </li>
        <li>
          <code>linkedIssuePolicy</code> — <code>required</code> / <code>preferred</code> /{" "}
          <code>optional</code>. How strongly a linked issue is expected. Default{" "}
          <code>optional</code>.
        </li>
        <li>
          <code>testExpectations</code> — test paths expected to change with code; a{" "}
          <code>manifest_missing_tests</code> finding fires when absent. Default <code>[]</code>.
        </li>
        <li>
          <code>issueDiscoveryPolicy</code> — <code>encouraged</code> / <code>neutral</code> /{" "}
          <code>discouraged</code>. Default <code>neutral</code>.
        </li>
        <li>
          <code>maintainerNotes</code> — private review context, never published to any public
          GitHub surface. Default <code>[]</code>.
        </li>
        <li>
          <code>publicNotes</code> — notes explicitly opted into public output (public-safe
          filtered; unsafe lines are dropped). Default <code>[]</code>.
        </li>
      </ul>

      <h2>Other repo settings</h2>
      <p>
        Anything you can toggle in the dashboard can also be set as code under{" "}
        <code>settings:</code> in <code>.gittensory.yml</code>. Common ones, all defaulting to the
        safe values shown:
      </p>
      <ul>
        <li>
          <code>commentMode</code> — comment audience: <code>off</code> /{" "}
          <code>detected_contributors_only</code> (default) / <code>all_prs</code>.
        </li>
        <li>
          <code>publicAudienceMode</code> — <code>oss_maintainer</code> (default) /{" "}
          <code>gittensor_only</code>.
        </li>
        <li>
          <code>publicSignalLevel</code> — <code>minimal</code> / <code>standard</code> (default).
        </li>
        <li>
          <code>checkRunMode</code> — publishes the <strong>Gittensory Context</strong> check (not
          the <strong>Orb Review Agent</strong> gate check, which is <code>reviewCheckMode</code>):{" "}
          <code>off</code> (default) / <code>enabled</code>. Pair with{" "}
          <code>checkRunDetailLevel</code> (<code>minimal</code> (default) / <code>standard</code>).
        </li>
        <li>
          <code>publicSurface</code> — <code>off</code> / <code>comment_and_label</code> (default) /{" "}
          <code>comment_only</code> / <code>label_only</code>.
        </li>
        <li>
          <code>autoLabelEnabled</code> (default <code>true</code>), <code>gittensorLabel</code>{" "}
          (default <code>gittensor</code>), and <code>createMissingLabel</code> (default{" "}
          <code>true</code>) — the base per-PR context label, shown to the public surface.
        </li>
        <li>
          <code>typeLabelsEnabled</code> (default <code>true</code>) and <code>typeLabels</code> — a
          separate, independent taxonomy label family: internal triage metadata gated by its own
          toggle, not by <code>autoLabelEnabled</code> above. <code>typeLabels</code> is an open{" "}
          <code>category → label name</code> map, not fixed to any specific set — the built-in{" "}
          <code>bug</code>/<code>feature</code>/<code>priority</code> categories default to{" "}
          <code>gittensor:bug</code>/<code>gittensor:feature</code>/<code>gittensor:priority</code>{" "}
          (examples, not required names), and you can add any number of your own categories (e.g.{" "}
          <code>security: area:security</code>) for your own taxonomy. An explicit{" "}
          <code>typeLabels: {"{}"}</code> means zero configured categories for the repo.
        </li>
        <li>
          <code>includeMaintainerAuthors</code> (default <code>false</code>),{" "}
          <code>requireLinkedIssue</code> (default <code>false</code>), <code>backfillEnabled</code>{" "}
          (default <code>true</code>), and <code>badgeEnabled</code> (README status badge, default{" "}
          <code>false</code>), and <code>publicQualityMetrics</code> (public review-quality page,
          default <code>false</code>).
        </li>
        <li>
          <code>agentPaused</code> (per-repo kill-switch, default <code>false</code>) and{" "}
          <code>agentDryRun</code> (shadow mode, default <code>false</code>).
        </li>
        <li>
          <code>autonomy</code> (per-action-class level; default is observe, deny-by-default),{" "}
          <code>autoMaintain</code> (<code>{`{ mergeMethod, requireApprovals }`}</code>; default{" "}
          <code>squash</code> / <code>1</code>), and <code>commandAuthorization</code> (role policy;
          built-in default).
        </li>
      </ul>

      <h2>Example .gittensory.yml</h2>
      <p>
        A worked manifest: focus and validation up top, a refined gate, BYOK AI review, and a few
        dashboard-equivalent overrides.
      </p>
      <CodeBlock
        filename=".gittensory.yml"
        lang="yaml"
        code={`# Focus / validation
wantedPaths:
  - "src/**"
testExpectations:
  - "tests/**"
linkedIssuePolicy: preferred

# Gate policy (refines an enabled gate)
gate:
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
    aiAdvisory: true
  mergeReadiness: advisory
  manifestPolicy: block
  aiReview:
    mode: advisory
    byok: true
    provider: anthropic
    model: claude-3-5-sonnet-latest

# Generic dashboard-equivalent overrides
settings:
  commentMode: detected_contributors_only
  checkRunMode: enabled
  checkRunDetailLevel: standard
  badgeEnabled: true
  # Optional path holds. Omitted or [] means no path guardrails.
  # hardGuardrailGlobs:
  #   - "src/selfhost/**"`}
      />

      <Callout variant="warn" title="Roll forward one step at a time">
        Start conservative: enable the gate in <code>advisory</code> before <code>block</code>,
        watch the surfaced findings, and only then tighten. Combined with the tightening-only
        self-tune loop, this keeps the gate from ever blocking a contributor on a setting you have
        not validated.
      </Callout>

      <p>
        For the privacy guarantees behind these surfaces, see{" "}
        <a href="/docs/privacy-security">Privacy &amp; security</a>. For the maintainer install and
        trust flow, see <a href="/docs/maintainer-install-trust">Install &amp; trust</a>. If you're
        self-hosting, see <Link to="/docs/self-hosting-configuration">Self-host configuration</Link>{" "}
        for the environment layer these settings sit on top of, plus the config-precedence rules and
        a link to the fully-commented <code>.gittensory.yml.example</code>.
      </p>
    </DocsPage>
  );
}
