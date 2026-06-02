import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { CodeBlock, Callout } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/beta-onboarding")({
  head: () => ({
    meta: [
      { title: "Beta onboarding — Gittensory docs" },
      {
        name: "description",
        content:
          "Role-based beta paths for miners, maintainers, repo owners, and operators — first useful action, not just API reference.",
      },
      { property: "og:title", content: "Beta onboarding — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Role-based beta paths for miners, maintainers, repo owners, and operators — first useful action, not just API reference.",
      },
      { property: "og:url", content: "/docs/beta-onboarding" },
    ],
    links: [{ rel: "canonical", href: "/docs/beta-onboarding" }],
  }),
  component: BetaOnboarding,
});

function BetaOnboarding() {
  return (
    <DocsPage
      eyebrow="Get started"
      title="Beta onboarding by role"
      description="Pick the lane that matches you. Each path ends in a concrete first win — install, configure, or read a report — without treating Gittensory as an official Gittensor product surface."
    >
      <Callout>
        <strong>Product positioning.</strong> Gittensory is a deterministic base-agent and
        control-plane layer for the Gittensor ecosystem. It is{" "}
        <a href="https://github.com/jsonbored/gittensory" target="_blank" rel="noreferrer">
          jsonbored/gittensory
        </a>
        , independent of{" "}
        <a href="https://github.com/entrius/gittensor" target="_blank" rel="noreferrer">
          entrius/gittensor
        </a>
        . Use it to plan work, preflight branches, and keep GitHub review surfaces quiet — not as an
        official Gittensor frontend, wallet UI, or payout dashboard.
      </Callout>

      <h2>Miner journey</h2>
      <p>
        Miners and contributors use the local MCP package. Source contents stay on your machine but
        branch metadata (such as branch names, SHAs, changed file paths, commit messages, validation
        details, labels, body text, linked issues, and scenario notes) is sent to authenticated
        Gittensory MCP/API responses for analysis and packet preparation.
      </p>
      <ol>
        <li>
          <strong>Install the MCP.</strong> Global install or <code>npx</code> — see{" "}
          <Link to="/docs/quickstart">Quickstart</Link>.
          <CodeBlock
            code={`npm i -g @jsonbored/gittensory-mcp@latest
gittensory-mcp --help`}
          />
        </li>
        <li>
          <strong>Sign in.</strong> GitHub Device Flow — no PAT storage.
          <CodeBlock
            code={`gittensory-mcp login
gittensory-mcp whoami`}
          />
        </li>
        <li>
          <strong>Run diagnostics.</strong> Confirms API reachability, auth, source-upload posture,
          and optional local score-preview wiring.
          <CodeBlock code="gittensory-mcp doctor" />
        </li>
        <li>
          <strong>Plan next work.</strong> Ranked actions, lane context, and blockers —
          copilot-only; does not open PRs or post comments.
          <CodeBlock
            code={`gittensory-mcp agent plan --login your-login --json
# optional: --repo owner/repo`}
          />
        </li>
        <li>
          <strong>Preflight the branch.</strong> Branch blockers, queue pressure, and maintainer-fit
          notes before you push.
          <CodeBlock
            code={`gittensory-mcp analyze-branch --login your-login --json
gittensory-mcp preflight --login your-login --json`}
          />
        </li>
        <li>
          <strong>Prepare a public-safe packet.</strong> Maintainer-readable PR description with no
          private scoring language.
          <CodeBlock
            code={`gittensory-mcp agent packet --login your-login --repo owner/repo --json`}
          />
        </li>
      </ol>
      <p>
        Wire the same tools into Codex, Claude Desktop, or Cursor via{" "}
        <Link to="/docs/mcp-clients">MCP client setup</Link>. Signed-in miners can also use the{" "}
        <Link to="/app/workbench">Workbench</Link> and <Link to="/app/miner">Miner dashboard</Link>{" "}
        in the control panel.
      </p>

      <h2>Maintainer journey</h2>
      <p>
        Maintainers install the GitHub App, configure per-repo policy, preview what could appear on
        a confirmed-miner PR, then pull context on demand.
      </p>
      <ol>
        <li>
          <strong>Install the GitHub App.</strong> Choose repositories and approve permissions —
          default posture is silence. See <Link to="/docs/github-app">GitHub App setup</Link>.
        </li>
        <li>
          <strong>Configure settings.</strong> Opt in to at most one configured label and one sticky
          sanitized comment per confirmed-miner PR. Tune repo policy in installation settings or via
          the API.
        </li>
        <li>
          <strong>Preview the public surface.</strong> Dry-run what would be written to GitHub
          without mutating state.
          <CodeBlock
            lang="http"
            code={`POST /v1/repos/:owner/:repo/settings-preview
# body: sample PR fields + desired policy flags`}
          />
          <p>
            The signed-in <Link to="/app/maintainer">Maintainer console</Link> and{" "}
            <Link to="/app/repos">Repos</Link> tab surface the same preview diff when live data is
            available.
          </p>
        </li>
        <li>
          <strong>Use maintainer commands.</strong> On-demand context in the PR thread — output
          stays maintainer-scoped when appropriate.
          <CodeBlock
            code={`@gittensory help
@gittensory preflight
@gittensory blockers
@gittensory duplicate-check
@gittensory miner-context
@gittensory next-action`}
          />
        </li>
      </ol>
      <p>
        Deeper workflow: <Link to="/docs/maintainer-workflow">Maintainer workflow</Link>. Privacy
        rules: <Link to="/docs/privacy-security">Privacy & security</Link>.
      </p>

      <h2>Repo owner journey</h2>
      <p>
        Repo owners care about registration readiness and sensible <code>.gittensor.yml</code>{" "}
        configuration before promoting labels or maintainer-cut policy.
      </p>
      <ol>
        <li>
          <strong>Run a readiness report.</strong> Blockers, warnings, recommended registration
          mode, and issue policy — private API only.
          <CodeBlock lang="http" code={`GET /v1/repos/:owner/:repo/registration-readiness`} />
        </li>
        <li>
          <strong>Review config guidance.</strong> Recommended config diff with reasons and
          tradeoffs — apply via PR when ready.
          <CodeBlock
            lang="http"
            code={`GET /v1/repos/:owner/:repo/gittensor-config-recommendation`}
          />
        </li>
        <li>
          <strong>Use the control panel.</strong> Open <Link to="/app/owner">Repository owner</Link>{" "}
          (or the Owner tab under <Link to="/app/repos">Repos</Link>) to inspect the same signals
          with a live repo selector after you sign in with GitHub.
        </li>
      </ol>
      <p>
        Readiness is separate from upstream drift: a repo can look ready while Gittensor rules are
        stale. Check <Link to="/docs/upstream-drift">Upstream drift</Link> when you change scoring
        assumptions.
      </p>

      <h2>Operator journey</h2>
      <p>
        Operators watch deployment health, product usage, value rollups, and upstream drift across
        installations. These surfaces are private and authenticated — never mirrored to public
        GitHub comments.
      </p>
      <ol>
        <li>
          <strong>Open usage & value.</strong> Weekly rollups, activation status, and
          noise-reduction metrics in the control panel.
          <p>
            <Link to="/app/operator">Operator dashboard</Link> — backed by{" "}
            <code>GET /v1/app/operator-dashboard</code>.
          </p>
        </li>
        <li>
          <strong>Read the weekly value report.</strong> Summary lines plus rollup freshness and
          warnings when backfills lag or fidelity degrades.
        </li>
        <li>
          <strong>Check drift status.</strong> Compare ruleset snapshots and signal fidelity before
          trusting miner or maintainer guidance.
          <CodeBlock
            lang="http"
            code={`GET /v1/upstream/drift
GET /v1/upstream/status
GET /v1/readiness`}
          />
        </li>
      </ol>
      <p>
        When drift is not <code>current</code>, treat MCP and API responses as tied to the printed
        ruleset version. See <Link to="/docs/upstream-drift">Upstream drift</Link> for semantics.
      </p>

      <h2>Public vs private boundaries</h2>
      <p>
        Public GitHub output must never include wallets, hotkeys, payout or reward estimates, raw
        trust scores, public score estimates, private reviewability details, or farming language.
        Private MCP, API, and control-panel surfaces may show authenticated scoreability, blockers,
        projections, and evidence — framed as guidance, not guaranteed outcomes.
      </p>
      <Callout variant="safety">
        If you are unsure whether copy belongs on a PR thread, start with a maintainer packet or MCP
        preflight. Public comments stay advisory and sanitized; richer context stays in private
        channels.
      </Callout>

      <h2>Next steps</h2>
      <ul>
        <li>
          Miners: <Link to="/docs/quickstart">Quickstart</Link> →{" "}
          <Link to="/docs/miner-workflow">Miner workflow</Link>
        </li>
        <li>
          Maintainers: <Link to="/docs/github-app">GitHub App</Link> →{" "}
          <Link to="/docs/maintainer-workflow">Maintainer workflow</Link>
        </li>
        <li>
          Repo owners: <Link to="/app/owner">Owner console</Link> +{" "}
          <Link to="/docs/privacy-security">Privacy & security</Link>
        </li>
        <li>
          Operators: <Link to="/app/operator">Operator dashboard</Link> +{" "}
          <Link to="/docs/upstream-drift">Upstream drift</Link>
        </li>
      </ul>
    </DocsPage>
  );
}
