import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/owner-onboarding")({
  head: () => ({
    meta: [
      { title: "Repo owner onboarding checklist — Gittensory docs" },
      {
        name: "description",
        content:
          "Is your repo ready to accept Gittensory-driven contribution traffic? Work through policy, labels, issue quality, maintainer capacity, and public/private boundaries before registering.",
      },
      { property: "og:title", content: "Repo owner onboarding checklist — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Is your repo ready to accept Gittensory-driven contribution traffic? Work through policy, labels, issue quality, maintainer capacity, and public/private boundaries before registering.",
      },
      { property: "og:url", content: "/docs/owner-onboarding" },
    ],
    links: [{ rel: "canonical", href: "/docs/owner-onboarding" }],
  }),
  component: OwnerOnboarding,
});

function OwnerOnboarding() {
  return (
    <DocsPage
      eyebrow="Repo owners"
      title="Repo owner onboarding checklist"
      description="Work through each section before registering. This checklist covers what Gittensory needs from your repo and what tradeoffs you are accepting."
    >
      <Callout>
        <strong>Before you start.</strong> Run the readiness report first —{" "}
        <code>GET /v1/repos/:owner/:repo/registration-readiness</code> — or open the{" "}
        <Link to="/app/owner">Owner console</Link> and read the blockers and warnings before working
        through this checklist manually.
      </Callout>

      <h2>1. Repo policy</h2>
      <p>Gittensory works best on repos with a clear, enforced contribution policy.</p>
      <ul>
        <li>
          <strong>Contribution lane is defined.</strong> Choose one: direct-PR lane (contributors
          open PRs against issues), issue-discovery lane (contributors source and solve open
          issues), or a split. Mixed posture without a documented lane produces noisy, low-signal
          traffic.
        </li>
        <li>
          <strong>CONTRIBUTING.md is present and current.</strong> It must say what a good PR looks
          like: linked issue, scope, test expectations, and review expectations. Miners read this
          before submitting.
        </li>
        <li>
          <strong>Linked-issue requirement is explicit.</strong> If you require a linked issue, set{" "}
          <code>requireLinkedIssue: true</code> in your settings. If you accept no-issue PRs,
          document why — the gate will flag them otherwise.
        </li>
        <li>
          <strong>Maintainer-cut posture is decided.</strong> A non-zero maintainer cut shifts
          review incentives. Decide before registration whether this is appropriate for your repo's
          size and review load.
        </li>
      </ul>

      <h2>2. Labels</h2>
      <p>Labels drive scoring, lane filtering, and the trusted label pipeline.</p>
      <ul>
        <li>
          <strong>
            At least one label is configured in <code>.gittensor.yml</code>.
          </strong>{" "}
          Without configured label multipliers, scoring is flat and lane signals are weak.
        </li>
        <li>
          <strong>Labels exist on real issues.</strong> Configured labels that are never observed on
          open issues produce zero signal. Apply labels to your backlog before registering.
        </li>
        <li>
          <strong>No farming-language labels.</strong> Labels like "bounty", "reward", "payout", or
          "hotkey" will be rejected by the sanitizer and may suppress public output entirely.
        </li>
        <li>
          <strong>Trusted label pipeline is plausible.</strong> If you intend to use{" "}
          <code>trustedLabelPipeline: true</code>, ensure labels are applied by maintainers, not
          self-applied by contributors.
        </li>
      </ul>

      <h2>3. Issue quality</h2>
      <p>
        Gittensory surfaces issue quality warnings to miners. Registering with poor issue hygiene
        means miners see low-quality targets and the signal fidelity drops.
      </p>
      <ul>
        <li>
          <strong>Open issues have titles and bodies.</strong> Titleless or bodyless issues score
          near zero for quality and are deprioritized in contributor recommendations.
        </li>
        <li>
          <strong>Issues are scoped.</strong> Issues that mix multiple unrelated changes produce
          ambiguous collision clusters and lower lane clarity scores.
        </li>
        <li>
          <strong>Stale issues are labelled or closed.</strong> Issues open for months without
          activity inflate the open-issue count and depress queue health scores.
        </li>
        <li>
          <strong>Linked PRs are reflected.</strong> Issues that have been resolved by a merged PR
          should be closed. Unclosed resolved issues pollute the issue-discovery lane.
        </li>
      </ul>

      <h2>4. Validation commands</h2>
      <p>
        The test coverage gate uses the trusted label pipeline and check-run mode to report
        readiness. These must work before you enable gate checks.
      </p>
      <ul>
        <li>
          <strong>
            <code>npm run test:ci</code> passes at or above 97% coverage.
          </strong>{" "}
          This is the minimum gate threshold. Aim for 98%+ locally so CI variance does not trip the
          gate on normal PRs.
        </li>
        <li>
          <strong>Branch coverage is the binding constraint.</strong> Line and statement coverage
          can be high while branch coverage hides untested paths. Check{" "}
          <code>npm run test:coverage</code> locally before enabling the gate.
        </li>
        <li>
          <strong>Build and lint pass cleanly.</strong> A repo where CI is red by default will
          produce misleading gate-check results. Fix existing failures before enabling gate checks.
        </li>
        <li>
          <strong>Check-run mode is opt-in.</strong> You can register without enabling check runs.
          Start with <code>checkRunMode: off</code> and enable after you confirm the gate threshold
          is realistic for your PR traffic.
        </li>
      </ul>

      <h2>5. Maintainer capacity</h2>
      <p>
        Registering increases inbound PR volume. Be honest about whether your repo can absorb it.
      </p>
      <ul>
        <li>
          <strong>Open PR queue is reviewable.</strong> If you already have more open PRs than
          reviewers can process, registration will deepen the backlog. The readiness report shows
          queue health; a "critical" level is a blocker.
        </li>
        <li>
          <strong>At least one active maintainer.</strong> A repo with no recent maintainer activity
          will receive PRs with no reviewer. Gittensory does not assign reviewers — it surfaces
          context. Assignment is still your responsibility.
        </li>
        <li>
          <strong>Review SLA expectations are documented.</strong> Miners check how long PRs wait
          before merging. If your median review time is weeks, document it so miners set realistic
          expectations.
        </li>
        <li>
          <strong>Low-quality PR pressure is a real tradeoff.</strong> Gittensory reduces noise via
          the confirmation gate and miner context, but it does not eliminate low-effort submissions.
          Some low-quality PRs will still arrive. Decide before registration whether the signal gain
          is worth the additional triage cost.
        </li>
      </ul>

      <h2>6. Contribution lanes</h2>
      <ul>
        <li>
          <strong>Direct-PR lane:</strong> Issues are well-scoped and self-contained. Contributors
          open PRs against open issues. You need a linked-issue requirement and a review process
          that closes issues promptly when PRs merge.
        </li>
        <li>
          <strong>Issue-discovery lane:</strong> Contributors surface and triage new issues, not
          just solve existing ones. Enable this only if your backlog needs discovery work; it
          changes how contributor scoring weights issue authoring versus PR authoring.
        </li>
        <li>
          <strong>Split lane:</strong> Some contributors do PRs, others do issue discovery. This
          works when the two activities are balanced in your <code>.gittensor.yml</code> emission
          share config. Unbalanced split configs produce misleading contributor recommendations.
        </li>
      </ul>

      <h2>7. Public/private boundaries</h2>
      <p>
        Gittensory posts one sanitized sticky comment per confirmed-miner PR and optionally applies
        a configured label. Everything else stays private.
      </p>
      <ul>
        <li>
          <strong>Public comment content is sanitized.</strong> Wallet addresses, hotkeys, coldkeys,
          raw trust scores, reward estimates, payout amounts, farming language, and private
          reviewability details are never included. The sanitizer enforces this at the output layer
          — but verify your label names and issue bodies do not contain this language either, as it
          affects signal quality.
        </li>
        <li>
          <strong>Private API context stays private.</strong> The decision pack, scoring profile,
          maintainer packet, and registration readiness report are authenticated-only. They are
          never mirrored to public GitHub comments, issue bodies, or PR descriptions.
        </li>
        <li>
          <strong>Public audience mode is set correctly.</strong> Use{" "}
          <code>publicAudienceMode: oss_maintainer</code> for general OSS repos. Use{" "}
          <code>gittensor_only</code> only if you want to suppress public output entirely for
          non-confirmed-miner PRs.
        </li>
        <li>
          <strong>Comment mode matches your intent.</strong> <code>detected_contributors_only</code>{" "}
          (default) posts only on confirmed miners. <code>all_prs</code> posts on every PR that
          passes the other gates. Start with the default and widen only if you want context on all
          contributor PRs.
        </li>
      </ul>

      <h2>Tradeoffs to accept before registering</h2>
      <Callout>
        Registration is reversible — you can disable public output at any time via settings — but
        the inbound PR volume increase is not instantly reversible. Set expectations before you
        register.
      </Callout>
      <ul>
        <li>
          <strong>Higher inbound PR volume.</strong> Confirmed miners will target registered repos.
          More PRs means more triage, even with the confirmation gate reducing noise.
        </li>
        <li>
          <strong>Review burden from low-signal PRs.</strong> Not every miner PR will be high
          quality. The gate narrows the field, but it does not eliminate effort on your part.
        </li>
        <li>
          <strong>Label and config lock-in.</strong> Changing label multipliers or lane posture
          after registration shifts contributor targeting. Do it deliberately, not frequently.
        </li>
        <li>
          <strong>Maintainer-cut economics.</strong> If you enable a maintainer cut, the repo
          becomes part of the Gittensor incentive model. This is a deliberate opt-in, not a default.
          Review the economics before enabling.
        </li>
      </ul>

      <h2>Ready? Next steps</h2>
      <ol>
        <li>
          Run the readiness report and resolve all blockers:{" "}
          <code>GET /v1/repos/:owner/:repo/registration-readiness</code>
        </li>
        <li>
          Review config guidance and apply via PR:{" "}
          <code>GET /v1/repos/:owner/:repo/gittensor-config-recommendation</code>
        </li>
        <li>
          Open the <Link to="/app/owner">Owner console</Link> to inspect live signals after signing
          in with GitHub.
        </li>
        <li>
          Check <Link to="/docs/upstream-drift">Upstream drift</Link> — a repo can look ready while
          Gittensor scoring rules are stale.
        </li>
        <li>
          Review <Link to="/docs/privacy-security">Privacy & security</Link> to confirm public
          output boundaries before going live.
        </li>
      </ol>
    </DocsPage>
  );
}
