import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/github-app")({
  head: () => ({
    meta: [
      { title: "GitHub App configuration — LoopOver docs" },
      {
        name: "description",
        content:
          "How the LoopOver GitHub App reviews pull requests once installed. Self-hosting is the only currently available path; a shared, centrally hosted App is planned as a future offering. The LoopOver Orb Review Agent check plus a review comment posted as loopover[bot]. Choose repos, configure sticky PR panels, advisory checks, and optional review-agent enforcement.",
      },
      { property: "og:title", content: "GitHub App configuration — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How the LoopOver GitHub App reviews pull requests once installed. Self-hosting is the only currently available path; a shared, centrally hosted App is planned as a future offering. Choose repos, configure sticky PR panels, advisory checks, and optional review-agent enforcement.",
      },
      { property: "og:url", content: "/docs/github-app" },
    ],
    links: [{ rel: "canonical", href: "/docs/github-app" }],
  }),
  component: GithubApp,
});

function GithubApp() {
  return (
    <DocsPage
      eyebrow="Workflows"
      title="GitHub App configuration"
      description="Install a LoopOver GitHub App on a repo so it reviews your pull requests, then choose whether it should stay advisory or enforce repo-configured PR quality rules."
    >
      <p>
        Once installed, a <strong>LoopOver GitHub App reviews every pull request</strong> on the
        repos you select. Self-hosting your own App (see{" "}
        <Link to="/docs/maintainer-self-hosting">self-hosting setup</Link>) is the only currently
        available path. Each review produces two surfaces: the{" "}
        <strong>LoopOver Orb Review Agent</strong> check run (and the advisory{" "}
        <strong>LoopOver Context</strong> check), and a single review comment posted by{" "}
        <code>loopover[bot]</code> that updates in place as the PR evolves. The review behavior
        below this page's Install section (PR panel, checks, gate modes, config-as-code) is the same
        regardless of which connection mode your self-hosted App uses.
      </p>

      <h2>Install</h2>
      <p>
        <strong>Self-hosting is the only currently available path.</strong> Run the review stack
        yourself, then install your own GitHub App on exactly the repos you choose using the
        self-host setup wizard. The direct App's required permissions and events are covered in{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link> — use that page's
        checklist for a self-hosted install.
      </p>
      <Callout variant="note" title="Shared, centrally hosted App: not currently available">
        LoopOver previously ran a private managed-beta shared App that repo owners could install
        directly, without self-hosting. That shared install path is currently paused while
        self-hosted Orb is the primary way to run LoopOver — a new centrally hosted offering is
        planned for the future. If you previously used the shared managed-beta App, see{" "}
        <Link to="/docs/maintainer-self-hosting">self-hosting setup</Link> to move your repos over.
      </Callout>

      <h2>First 10 minutes</h2>
      <ol>
        <li>Install the app on one test repository first.</li>
        <li>
          Confirm the installation appears in the private API, then open its health record.
          <CodeBlock
            lang="http"
            code={`GET /v1/installations
GET /v1/installations/:id/health
GET /v1/installations/:id/repair`}
          />
        </li>
        <li>
          Check repo readiness before enabling public output.
          <CodeBlock lang="http" code={`GET /v1/repos/:owner/:repo/registration-readiness`} />
        </li>
        <li>
          Preview the exact public surface without posting to GitHub.
          <CodeBlock
            lang="http"
            code={`POST /v1/repos/:owner/:repo/settings-preview
# body: sample PR fields + desired comment/check/gate settings`}
          />
        </li>
        <li>
          Leave <strong>LoopOver Context</strong> advisory while you tune copy and settings. Make{" "}
          <strong>LoopOver Orb Review Agent</strong> required only after the repo explicitly enables
          blocking rules.
        </li>
      </ol>

      <h2>Default posture</h2>
      <p>
        LoopOver is advisory-first. Public comments, labels, the Context check, and the review-agent
        check are controlled per repo. Missing issue links, non-Gittensor contributors, busy queues,
        and weak overlap signals do not block merge by default.
      </p>

      <h2>PR panel</h2>
      <p>
        The PR panel is the review comment the LoopOver app posts on each pull request. It is one
        sticky comment authored by <code>loopover[bot]</code> that updates in place — the app edits
        the same comment instead of adding new ones. It shows a public-safe readiness score,
        concrete signal evidence, and short actions for linked issues, related work, review load,
        validation evidence, open PR queue, contributor context, and Gate result.
      </p>
      <p>
        By default the comment is posted only to detected contributors (<code>commentMode</code> is{" "}
        <code>detected_contributors_only</code>). Set <code>commentMode</code> to{" "}
        <code>all_prs</code> to comment on every PR, or <code>off</code> to suppress the comment
        entirely. Operators who have rolled the deployment onto the unified review comment (see
        below) get the single in-place comment shape; otherwise the legacy multi-panel comment is
        used unchanged.
      </p>

      <h2>Checks</h2>
      <p>
        The LoopOver app publishes its review as check runs.{" "}
        <strong>LoopOver Orb Review Agent</strong> is the gate result, controlled by{" "}
        <code>reviewCheckMode</code> (<code>required</code> / <code>visible</code> /{" "}
        <code>disabled</code>). <strong>LoopOver Context</strong> is the separate advisory
        companion, controlled by its own <code>checkRunMode</code> (<code>off</code> /{" "}
        <code>enabled</code>) — these two switches are independent axes, not one setting for both
        checks. <code>checkRunDetailLevel</code> (<code>minimal</code> / <code>standard</code>) only
        affects <strong>LoopOver Context</strong>'s output depth; it has no effect on the Orb Review
        Agent check.
      </p>
      <p>
        <strong>LoopOver Context</strong> is advisory and should not be required in branch
        protection. <strong>LoopOver Orb Review Agent</strong> is opt-in and can be made required
        after a repo owner chooses blocking rules.
      </p>
      <p>
        Branch protection should require <strong>LoopOver Orb Review Agent</strong> only after the
        repo has verified installation health, previewed the public panel, and configured at least
        one <code>block</code> rule. Do not require <strong>LoopOver Context</strong>; it is there
        to inform reviewers, not stop merges.
      </p>

      <h2>Gate modes</h2>
      <p>
        The deterministic gate is the heart of the LoopOver review. Its master switch is{" "}
        <code>reviewCheckMode</code> (<code>required</code> / <code>visible</code> /{" "}
        <code>disabled</code>); each dimension then refines an already-enabled gate with a tri-state
        mode — <code>off</code> (not evaluated), <code>advisory</code> (surfaced, never blocks), or{" "}
        <code>block</code> (can become a hard <strong>LoopOver Orb Review Agent</strong> blocker). A
        configured blocker fails the gate for any author identically —
        confirmed-Gittensor-contributor status does not change <em>who</em> can be blocked; it's
        carried through only for on-chain scoring, a separate concern from the gate's own
        merge/close decision.
      </p>
      <ul>
        <li>
          <code>linkedIssueGateMode</code> — linked-issue check. Default <code>advisory</code>.
        </li>
        <li>
          <code>duplicatePrGateMode</code> — duplicate / superseding PR detection. Default{" "}
          <code>block</code>.
        </li>
        <li>
          <code>qualityGateMode</code> + <code>qualityGateMinScore</code> — the PR-quality score
          gate. Default <code>advisory</code>; only blocks when set to <code>block</code> with a
          configured min score.
        </li>
        <li>
          <code>slopGateMode</code> + <code>slopGateMinScore</code> — the deterministic anti-slop
          signal. Default <code>off</code>; <code>advisory</code> surfaces the slop score and
          warnings, <code>block</code> also hard-blocks at or above the min score (engine default
          band <code>60</code>).
        </li>
        <li>
          <code>mergeReadinessGateMode</code> — composite merge-readiness gate. Default{" "}
          <code>off</code>.
        </li>
        <li>
          <code>manifestPolicyGateMode</code> — makes the repo manifest's declared policy (blocked
          paths, required linked issue, test expectations) enforceable. Default <code>off</code>.
        </li>
        <li>
          <code>aiReviewMode</code> — AI review. Default <code>off</code>; <code>advisory</code>{" "}
          posts AI review notes only, <code>block</code> lets a dual-model high-confidence consensus
          defect become a blocker.
        </li>
        <li>
          <code>sizeGateMode</code> — PR-size hold. Default <code>off</code>; a PR at or above the
          configured file/line thresholds is held for manual review rather than auto-merged, never a
          hard failure.
        </li>
        <li>
          <code>lockfileIntegrityGateMode</code> — lockfile-tamper-risk check (a resolved/integrity
          change with no matching version bump, or a dependency pointed off the npm registry).
          Default <code>off</code>.
        </li>
        <li>
          <code>claGateMode</code> — CLA / license-compatibility gate. Default <code>off</code>.
        </li>
        <li>
          <code>selfAuthoredLinkedIssueGateMode</code> — flags or blocks a PR whose author also
          opened the linked issue. Default <code>advisory</code>.
        </li>
        <li>
          <code>linkedIssueSatisfactionGateMode</code> — an AI assessment of whether the PR's diff
          actually satisfies its primary linked issue's intent, distinct from{" "}
          <code>linkedIssueGateMode</code> (which only checks a link exists). Default{" "}
          <code>off</code>; <code>advisory</code> renders in the review comment without blocking,{" "}
          <code>block</code> additionally lets a confidence-floor-passing "unaddressed" verdict
          become a blocker.
        </li>
        <li>
          <code>moderationGateMode</code> — whether the moderation-rules engine (contributor cap,
          blacklist, review-nag feeding a shared cross-repo violation tally) runs on this repo.
          Default <code>inherit</code> (defers to the instance-wide default); <code>off</code>/
          <code>enabled</code> force it per repo.
        </li>
      </ul>
      <p>
        The policy pack (<code>gatePack</code>) selects which rule set runs: <code>gittensor</code>{" "}
        (registry-aware, tracks confirmed-Gittensor-contributor status for scoring) or{" "}
        <code>oss-anti-slop</code> (the deterministic rules against any author on any repo, with no
        confirmed-contributor tracking at all).
      </p>

      <h2>
        Configure as code (<code>.loopover.yml</code>)
      </h2>
      <p>
        Every setting can be committed to <code>.loopover.yml</code> at the repo root instead of, or
        layered over, the dashboard. Precedence is <code>.loopover.yml</code> &gt; repository
        settings &gt; safe defaults; an unset field falls back to the next layer. It only chooses{" "}
        <em>what</em> LoopOver does — a configured blocker gates every author identically,
        regardless of config.
      </p>
      <CodeBlock
        lang="yaml"
        code={`# Repository settings as code — any dashboard toggle:
settings:
  reviewCheckMode: required     # review-agent check on/off (required|visible|disabled)
  checkRunMode: enabled         # the advisory Context check on/off
  commentMode: detected_contributors_only
  publicSurface: comment_only

# Friendly gate alias (wins over settings: for gate fields):
gate:
  enabled: true                 # review-agent check on/off
  linkedIssue: advisory         # block | advisory | off
  duplicates: block
  readiness: { mode: advisory, minScore: 60 }

# Public review-panel content:
review:
  footer: { text: "Reviewed by our bot." }   # custom lead — the Gittensor register link is always appended
  note: "Run npm test before requesting review."
  fields: { relatedWork: false }              # show/hide individual panel rows`}
      />
      <p>
        Maintainer-supplied footer and note text is dropped if it contains forbidden public language
        (reward, score, wallet, hotkey, payout, etc.); the Gittensor attribution and register link
        always remain on the footer.
      </p>
      <p>
        The per-repo settings above choose <em>what</em> LoopOver does on each PR. The next section
        covers the deployment-wide capability switches that turn whole review features on or off.
      </p>

      <h2>
        Review capability flags (<code>LOOPOVER_REVIEW_*</code>)
      </h2>
      <p>
        Beyond per-repo settings, operators turn whole review <em>capabilities</em> on or off with
        the <code>LOOPOVER_REVIEW_*</code> worker environment variables. Every flag defaults to{" "}
        <strong>OFF</strong>: when a flag is off its code path is inert and the review behaves
        exactly as if the feature did not exist. "Truthy" is one of <code>1</code>,{" "}
        <code>true</code>, <code>yes</code>, or <code>on</code>. You roll capabilities forward — and
        back — one flag, and one repo, at a time.
      </p>
      <Callout variant="safety">
        Per-PR features require <strong>two</strong> conditions: the capability flag is on{" "}
        <em>and</em> the repo is listed in <code>LOOPOVER_REVIEW_REPOS</code>. With an empty repo
        allowlist every per-PR feature stays dormant for everyone, no matter the global flags.
      </Callout>
      <ul>
        <li>
          <code>LOOPOVER_REVIEW_REPOS</code> — per-repo cutover allowlist. Comma-separated{" "}
          <code>owner/repo</code> names that may run the per-PR features. Add repos one at a time to
          roll forward; remove to roll back.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_SAFETY</code> — safety scan: defangs untrusted PR title/body/diff
          (prompt-injection neutralization) before the reviewer sees it, and surfaces a{" "}
          <code>secret_leak</code> blocker for leaked secrets in the diff. Per-PR.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_GROUNDING</code> — grounds the AI reviewer with the PR's finished CI
          status and the full post-change content of the changed files, so the model verifies its
          claims against reality. Per-PR.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_RAG</code> — retrieval-augmented context: appends semantically
          related code/docs from the codebase vector index to the reviewer prompt. Per-PR; inert
          until a <code>VECTORIZE</code> index exists for the repo.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_REPUTATION</code> — submitter-reputation spend control: downgrades a
          new / burst / low-reputation submitter to a deterministic-only review. Internal-only,
          never surfaced publicly. Per-PR.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_UNIFIED_COMMENT</code> — renders the public PR comment as one
          in-place unified comment instead of the legacy multi-panel comment. Per-PR; flag-off keeps
          the legacy comment byte-identical.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_OPS</code> — read-only observability: a cron anomaly scan over your
          own review-outcome data plus a bearer-gated stats aggregate. Global (not scoped by the
          repo allowlist).
        </li>
        <li>
          <code>LOOPOVER_REVIEW_SELFTUNE</code> — self-improvement loop that computes tuning
          recommendations from review outcomes, shadow-soaks any strictly-tightening recommendation,
          and can <em>only ever tighten</em> the gate. Global.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_CONTENT_LANE</code> — routes content repos (curated lists,
          registries) through the dedicated content lane instead of the code gate. Global.
        </li>
        <li>
          <code>LOOPOVER_REVIEW_DRAFT</code> — public draft-submission flow (contributor draft →
          GitHub OAuth → fork PR). Global; also needs the draft secrets set.
        </li>
      </ul>
      <p>
        A safe rollout for a per-PR feature is two flips: set the capability flag truthy, then add
        the repo to <code>LOOPOVER_REVIEW_REPOS</code>. Because both must hold, a capability can
        stay globally enabled while remaining dormant everywhere except the repos you have
        explicitly added.
      </p>
      <CodeBlock
        lang="bash"
        code={`# Roll grounding + the unified comment onto one repo:
LOOPOVER_REVIEW_GROUNDING="true"
LOOPOVER_REVIEW_UNIFIED_COMMENT="true"
LOOPOVER_REVIEW_REPOS="JSONbored/loopover"`}
      />

      <h2>Dogfood mode</h2>
      <p>
        For repos like <code>JSONbored/loopover</code> and <code>awesome-claude</code>, enable PR
        comments, labels, Context, and Gate together to test the full product surface. If another
        maintainer agent can merge quickly, configure that agent to wait for{" "}
        <code>LoopOver Orb Review Agent</code> before merge or close.
      </p>

      <h2>Install diagnostics</h2>
      <p>
        After installing, verify your install health from the API. The readiness endpoint separates
        service health from data quality.
      </p>
      <p>
        If the install route changes, check the deployed <code>GITHUB_APP_SLUG</code> before
        publishing setup copy. Self-hosted deployments use whatever slug you chose during setup.
      </p>

      <p>
        New maintainers should start with{" "}
        <Link to="/docs/maintainer-self-hosting">self-hosting setup</Link>, then continue with{" "}
        <Link to="/docs/maintainer-workflow">Maintainer workflow</Link> or the{" "}
        <Link to="/docs/beta-onboarding">beta onboarding checklist</Link> after the health endpoint
        reports clean permissions and events.
      </p>

      <Callout variant="safety">
        LoopOver's GitHub App never requests source push, never stores repository contents, and
        never publishes wallet, hotkey, payout, trust, reward, or private scoring language.
      </Callout>
    </DocsPage>
  );
}
