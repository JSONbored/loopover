import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/owner-checklist")({
  head: () => ({
    meta: [
      { title: "Repo-owner onboarding checklist — LoopOver docs" },
      {
        name: "description",
        content:
          "A pre-flight checklist for repo owners: registration, config quality, labels, issue quality, contribution lanes, validation, maintainer capacity, and the public/private boundary — with honest tradeoffs.",
      },
      { property: "og:title", content: "Repo-owner onboarding checklist — LoopOver docs" },
      {
        property: "og:description",
        content:
          "A pre-flight checklist for repo owners: registration, config quality, labels, issue quality, contribution lanes, validation, maintainer capacity, and the public/private boundary — with honest tradeoffs.",
      },
      { property: "og:url", content: "/docs/owner-checklist" },
    ],
    links: [{ rel: "canonical", href: "/docs/owner-checklist" }],
  }),
  component: OwnerChecklist,
});

function OwnerChecklist() {
  return (
    <DocsPage
      eyebrow="Repo owners"
      title="Repo-owner onboarding checklist"
      description="Work through this before you invite LoopOver contribution traffic. It mirrors the readiness report exactly, so each item is something the platform actually checks — and each comes with the honest tradeoff you are opting into."
    >
      <p>
        LoopOver is <strong>quiet by default</strong>: it installs without posting comments or
        adding labels until you turn those surfaces on. This checklist is what to confirm first.
        Everything owner-only runs through the private API or the{" "}
        <Link to="/app/owner">owner console</Link>; readiness is reported as bands and statuses,
        never as a raw private number.
      </p>
      <p>
        Start by pulling your readiness report — it returns <code>ready</code> plus a list of{" "}
        <code>blockers</code>, and drives every item below. You can also wire a review-only agent
        with the <code>repo-owner-intake</code> profile (it explains and drafts setup plans; it
        never pushes config, labels issues, or posts comments).
      </p>
      <CodeBlock
        lang="http"
        code={`GET /v1/repos/:owner/:repo/registration-readiness
GET /v1/repos/:owner/:repo/gittensor-config-recommendation`}
      />
      <CodeBlock
        code={`gittensory-mcp init-client --print claude --agent-profile repo-owner-intake`}
      />

      <h2>1. Repository registration</h2>
      <p>
        Confirm the repo is in the current LoopOver registry. If it is not, that is the first{" "}
        <code>blocker</code> in the readiness report and nothing else applies yet. Register and
        review from the <Link to="/app/owner">owner console</Link>.
      </p>

      <h2>2. Repo policy &amp; config quality</h2>
      <p>
        Your policy lives in <code>.loopover.yml</code> (or legacy <code>.gittensory.yml</code>,
        #4773; sections: <code>settings</code>, <code>gate</code>, <code>review</code>). The
        readiness report grades it as <code>configQuality</code> (excellent / good / needs_attention
        / fragile); a <strong>fragile</strong> config is a hard blocker. Preview exactly what a
        given config would do on a real PR before you commit it:
      </p>
      <CodeBlock lang="http" code={`POST /v1/repos/:owner/:repo/settings-preview`} />

      <h2>3. Labels &amp; trusted pipeline</h2>
      <p>
        The report checks <code>labelPolicy.trustedPipelineReady</code> and lists missing or unused
        registry labels. Configure the labels you actually use before turning on{" "}
        <code>labelMultipliers</code>.
      </p>
      <Callout variant="warn">
        Honest tradeoff: enabling trusted-label multipliers before your labels are real and applied
        consistently incentivizes the wrong work. Start without them and add them once the label
        pipeline is verified.
      </Callout>

      <h2>4. Issue quality</h2>
      <p>
        Clear, reproducible, well-scoped issues are the cheapest way to reduce low-quality PR
        pressure: contributors aim at real targets instead of guessing. The issue-quality signal
        feeds the contribution lanes below, so tidy your open issues before broadening intake.
      </p>

      <h2>5. Contribution lanes</h2>
      <p>
        A repo&apos;s lane is configured (not chosen by contributors) and the config recommendation
        endpoint suggests one with its tradeoffs. The lane is one of:
      </p>
      <ul>
        <li>
          <code>direct_pr</code> — implementation PRs only (<code>issueDiscoveryShare</code> = 0).
        </li>
        <li>
          <code>issue_discovery</code> — discovery/reporting only (<code>issueDiscoveryShare</code>{" "}
          = 1).
        </li>
        <li>
          <code>split</code> — both lanes active (0 &lt; <code>issueDiscoveryShare</code> &lt; 1).
        </li>
        <li>
          <code>inactive</code> — registered but with no current allocation.
        </li>
        <li>
          <code>unknown</code> — not registered or no config yet.
        </li>
      </ul>
      <Callout variant="warn">
        Honest tradeoff: the <code>split</code> lane is recommended only when contributor intake is
        healthy and config quality is excellent. Adding an issue-discovery slice surfaces more
        outside work but adds triage load and duplicate risk — default to <code>direct_pr</code>{" "}
        until you have capacity.
      </Callout>

      <h2>6. Validation expectations &amp; gate readiness</h2>
      <p>
        Declare your validation commands in <code>.loopover.yml</code> so contributors know what
        &quot;done&quot; means, and so the gate can run. The report reports{" "}
        <code>testCoverageHealth</code> as <code>gate_ready</code> or <code>gate_unknown</code>;
        gate checks only run when you have explicitly configured them. Until then the gate stays
        advisory.
      </p>

      <h2>7. Maintainer capacity &amp; queue health</h2>
      <p>
        The report grades <code>queueHealth</code> (low / medium / high / critical) from your open
        PR/issue burden, and <code>maintainerCutReadiness</code> tells you whether the repo is calm
        enough to reserve a maintainer lane.
      </p>
      <Callout variant="warn">
        Honest tradeoffs: opening more lanes means more triage. A maintainer cut credits upkeep but
        reduces the miner share. Requiring a linked issue improves traceability but deters quick
        drive-by PRs. Pick deliberately for the capacity you actually have.
      </Callout>

      <h2>8. Public/private boundaries</h2>
      <p>
        Decide what becomes visible: <code>publicSurface</code> (comments + labels),{" "}
        <code>commentMode</code>, and <code>publicAudienceMode</code>. Everything that can reach a
        public GitHub surface is run through the sanitizer first, so economic and identity signals
        are stripped — along with local file paths — and nothing is framed as a guaranteed outcome.
      </p>
      <Callout variant="safety">
        Turning on public comments and labels increases visibility — and the volume of drive-by PRs.
        Keep surfaces quiet until items 1–7 are green. See{" "}
        <Link to="/docs/privacy-security">privacy &amp; security</Link> for the full boundary and
        the <Link to="/docs/beta-onboarding">owner workflow</Link> for the end-to-end setup path.
      </Callout>
    </DocsPage>
  );
}
