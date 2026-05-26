---
layout: home

hero:
  name: Gittensory
  text: Know the Gittensor lane before you submit.
  tagline: MCP branch analysis and GitHub App context for score blockers, queue pressure, lane fit, and maintainer review load. Not a Gittensor frontend.
  image:
    src: /logo.svg
    alt: Gittensory logo
  actions:
    - theme: brand
      text: Install MCP
      link: /guide/install
    - theme: alt
      text: Miner Workflow
      link: /guide/miners
    - theme: alt
      text: GitHub App
      link: /guide/github-app-setup

features:
  - title: MCP branch preflight
    details: Local metadata-only checks for lane fit, stale base risk, validation evidence, and score blockers.
  - title: Quiet maintainer surface
    details: Confirmed-miner comments and labels without public check-run noise or private signal leakage.
  - title: Private scoreability context
    details: Current, ungated, and scenario-based scoreability reasoning stays in authenticated MCP/API output.
---

<!-- markdownlint-disable MD041 MD033 -->

<section class="gtn-install-strip" aria-label="Start with Gittensory MCP">
  <div class="gtn-install-copy">
    <p class="gtn-eyebrow">Start now</p>
    <h2>Analyze the branch before it becomes review load.</h2>
    <p>One local command gives your agent lane fit, queue pressure, score blockers, and a public-safe PR packet.</p>
  </div>
  <div class="gtn-install-command" aria-label="Recommended Gittensory command">
    <span>Metadata-only branch analysis</span>
    <code>gittensory-mcp analyze-branch --login YOUR_GITHUB_LOGIN --json</code>
  </div>
</section>

Prefer a full setup first? Start with [install](/guide/install), run `gittensory-mcp login`, then add `gittensory-mcp --stdio` to Codex, Claude, or Cursor.

## Pick A Path

- [Install the MCP package](/guide/install): get the CLI, authenticate with GitHub Device Flow, and verify local setup with `doctor`.
- [Connect an MCP client](/guide/mcp): print Codex, Claude Desktop, or Cursor config without mutating local files.
- [Check miner work](/guide/miners): run branch analysis, scenario projections, and preflight before opening a PR.
- [Set up the GitHub App](/guide/github-app-setup): give maintainers confirmed-miner comments and labels without noisy checks.
- [Review maintainer behavior](/guide/maintainers): understand quiet-by-default PR visibility and public-safe output boundaries.
- [Read the API contract](/reference/api): inspect the modern private API for decision packs, branch analysis, reviewability, and readiness.

## Where It Fits

| Audience | What Gittensory adds |
| --- | --- |
| Gittensor miners | Scoreability blockers, lane fit, queue pressure, local diff quality, and cleanup-first guidance. |
| Maintainers | Confirmed-miner context, sticky public-safe comments, configured labels, and private reviewability packets. |
| Coding agents | Structured MCP tools for repo context, current branch preflight, next actions, and PR packet drafting. |
| Repo owners | Config quality, label readiness, maintainer-lane handling, and contribution intake health. |

<section class="gtn-context-media" aria-labelledby="gtn-context-title">
  <div class="gtn-context-media__copy">
    <p class="gtn-eyebrow">Gittensor context</p>
    <h2 id="gtn-context-title">Built around the live contribution market, not another dashboard.</h2>
    <p>
      Gittensory reads the Gittensor and GitHub signals that affect contribution quality:
      registered repo lanes, miner history, open PR pressure, linked issue context, and maintainer friction.
    </p>
    <p class="gtn-context-media__links">
      <a href="https://gittensor.io/" target="_blank" rel="noreferrer">Open Gittensor</a>
      <a href="/guide/miners">Miner workflow</a>
      <a href="/guide/maintainers">Maintainer workflow</a>
    </p>
  </div>
  <a class="gtn-context-media__frame" href="https://gittensor.io/" target="_blank" rel="noreferrer" aria-label="Open Gittensor">
    <img
      src="/images/gittensor-home-signal.webp"
      alt="Gittensor homepage showing live miner, reward, and repository activity."
      width="1180"
      height="660"
    />
  </a>
</section>

## Guardrails

Gittensory is not a Gittensor frontend, public leaderboard, wallet tool, or auto-review bot. Public GitHub output stays sanitized. Private scoreability and reward/risk context stays in authenticated MCP/API surfaces.
