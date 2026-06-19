import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/miner-quickstart")({
  head: () => ({
    meta: [
      { title: "Miner quickstart by lane — Gittensory docs" },
      {
        name: "description",
        content:
          "Pick a contribution lane, install @jsonbored/gittensory-mcp, sign in, and run plan → preflight → packet. Lane-by-lane commands with JSON output and redaction notes.",
      },
      { property: "og:title", content: "Miner quickstart by lane — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Pick a contribution lane, install @jsonbored/gittensory-mcp, sign in, and run plan → preflight → packet. Lane-by-lane commands with JSON output and redaction notes.",
      },
      { property: "og:url", content: "/docs/miner-quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/miner-quickstart" }],
  }),
  component: MinerQuickstart,
});

function MinerQuickstart() {
  return (
    <DocsPage
      eyebrow="Get started"
      title="Miner quickstart by contribution lane"
      description="Choose how you want to contribute, then follow the same loop — install, sign in, doctor, plan, preflight, packet — with the flags that fit your lane. About five minutes per lane."
    >
      <p>
        Gittensory is copilot-only. It ranks and explains your options and drafts public-safe PR
        packets. It does not edit code, open PRs, or post comments for you, it makes no earnings
        promises, and it never predicts a public number. Every command below also accepts{" "}
        <code>--json</code> for machine-readable output, and your source never leaves your machine —
        only branch metadata (changed file paths, commit messages) is sent to authenticated
        Gittensory MCP/API responses.
      </p>

      <h2>0. Install and sign in (every lane)</h2>
      <p>
        The MCP is published as <code>@jsonbored/gittensory-mcp</code>. Run it with <code>npx</code>{" "}
        or install it globally, then authenticate with GitHub Device Flow — Gittensory never asks
        for a Personal Access Token.
      </p>
      <CodeBlock
        code={`# install (one-off, or global)
npx -y @jsonbored/gittensory-mcp@latest --help
npm i -g @jsonbored/gittensory-mcp@latest

# sign in, confirm identity, check the session
gittensory-mcp login
gittensory-mcp whoami --json
gittensory-mcp status --json

# verify API, auth, and the local scorer before any analysis
gittensory-mcp doctor --json`}
      />
      <Callout variant="safety">
        Session tokens are <strong>Gittensory tokens backed by GitHub identity</strong>, not your
        GitHub PATs. Source upload stays disabled (<code>GITTENSORY_UPLOAD_SOURCE=false</code>) and
        local absolute paths are redacted from anything that leaves your machine. Log out anytime
        with <code>gittensory-mcp logout</code>.
      </Callout>

      <h2>1. Choose your lane</h2>
      <p>
        Lanes describe <em>how</em> you contribute. Pick the one that matches the work in front of
        you, then read what the target repo actually supports: <code>agent plan</code> and{" "}
        <code>repo-decision</code> report the repo&apos;s configured lane so you can align before
        you start.
      </p>
      <CodeBlock
        code={`# what should I work on next, and what lane does this repo support?
gittensory-mcp agent plan --login your-login --repo owner/repo --json
gittensory-mcp repo-decision --login your-login --repo owner/repo --json`}
      />
      <p>
        The repo&apos;s configured lane comes back as one of these (it is set by the repo&apos;s
        registry config, not by you):
      </p>
      <ul>
        <li>
          <code>direct_pr</code> — implementation PRs only. Prefer focused PRs with clear evidence,
          linked context, and low review churn.
        </li>
        <li>
          <code>issue_discovery</code> — discovery work only. Focus on high-proof issue reports and
          avoid self-resolved issue loops.
        </li>
        <li>
          <code>split</code> — both paths are active. Pick one intentionally: issue discovery for
          reports, direct PR for implementation.
        </li>
        <li>
          <code>inactive</code> — registered but with no current allocation. Treat it as normal
          upstream contribution work unless the registry changes.
        </li>
        <li>
          <code>unknown</code> — not registered (or no config yet). Do not assume the repo is ready
          for Gittensor-specific contribution guidance.
        </li>
      </ul>

      <h2>2. Direct PR lane</h2>
      <p>
        You are implementing a change and opening a PR directly. Use this in a{" "}
        <code>direct_pr</code> or <code>split</code> repo. Plan, preflight your branch metadata,
        then generate the public-safe packet to paste into the PR body.
      </p>
      <CodeBlock
        code={`gittensory-mcp agent plan --login your-login --repo owner/repo --json
gittensory-mcp preflight --login your-login --repo owner/repo --base origin/main --validation "passed|npm test|summary" --json
gittensory-mcp agent packet --login your-login --repo owner/repo --base origin/main --json`}
      />

      <h2>3. Issue-solving PR lane</h2>
      <p>
        You are fixing a specific open issue. Same loop as a direct PR, but link the issue in your
        branch so preflight can credit the linked context. Confirm the linked-issue signal in the
        preflight output before opening the PR.
      </p>
      <CodeBlock
        code={`# branch named/described so the linked issue is detected, e.g. "Fixes #123"
gittensory-mcp agent plan --login your-login --repo owner/repo --json
gittensory-mcp preflight --login your-login --repo owner/repo --base origin/main --branch-eligibility eligible --validation "passed|npm test|summary" --json
gittensory-mcp agent packet --login your-login --repo owner/repo --base origin/main --json`}
      />

      <h2>4. Issue discovery lane</h2>
      <p>
        You are reporting a high-proof issue rather than opening a PR. Use this in an{" "}
        <code>issue_discovery</code> or <code>split</code> repo. Start from the plan to see which
        discovery work is worth it, and keep reports specific and reproducible — avoid self-resolved
        loops.
      </p>
      <CodeBlock
        code={`gittensory-mcp agent plan --login your-login --repo owner/repo --objective "find a high-proof issue" --json
gittensory-mcp decision-pack --login your-login --json`}
      />

      <h2>5. Docs and context work</h2>
      <p>
        Documentation and context contributions still ship as PRs, so they follow the direct PR
        loop. Run preflight on the branch metadata and generate a packet — the packet is the same
        public-safe artifact regardless of whether the change is code or docs.
      </p>
      <CodeBlock
        code={`gittensory-mcp agent plan --login your-login --repo owner/repo --json
gittensory-mcp preflight --login your-login --repo owner/repo --base origin/main --validation "passed|docs build|summary" --json
gittensory-mcp agent packet --login your-login --repo owner/repo --base origin/main --json`}
      />

      <h2>6. Repo-specific lanes</h2>
      <p>
        Some repos run their own lane policy. Always let the repo tell you:{" "}
        <code>repo-decision</code> returns the configured lane plus contributor guidance, and{" "}
        <code>analyze-branch</code> lets you model a scenario (pending merges, expected open PRs)
        before you commit to a path.
      </p>
      <CodeBlock
        code={`gittensory-mcp repo-decision --login your-login --repo owner/repo --json
gittensory-mcp analyze-branch --login your-login --repo owner/repo --base origin/main --pending-merged-prs 3 --expected-open-prs 0 --scenario-note "after the queue clears" --json`}
      />

      <h2>Validation expectations (every lane)</h2>
      <p>
        Before you open anything, the loop should be clean: <code>doctor</code> green, your branch
        metadata preflighted, and a validation note attached. Pass what you actually ran via{" "}
        <code>--validation &quot;status|command|summary&quot;</code> (for example{" "}
        <code>&quot;passed|npm test|all green&quot;</code>) so the preflight verdict reflects real
        validation, not a guess.
      </p>
      <CodeBlock
        code={`gittensory-mcp doctor --json
gittensory-mcp preflight --login your-login --repo owner/repo --base origin/main --validation "passed|npm test|summary" --json`}
      />
      <Callout variant="safety">
        The PR packet from <code>agent packet</code> is <strong>public-safe</strong>: it is scrubbed
        of economic and identity signals (wallet/hotkey, payout, trust-score, ranking, and
        public-prediction language) before it can be pasted into a public GitHub surface. Pair this
        page with the <a href="/docs/miner-workflow">miner workflow</a> for the full loop and{" "}
        <a href="/docs/privacy-security">privacy &amp; security</a> for the boundary details.
      </Callout>
    </DocsPage>
  );
}
