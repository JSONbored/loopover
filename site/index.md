---
layout: home
---

<section class="gtn-hero" aria-labelledby="gtn-home-title">
  <div class="gtn-hero__copy">
    <p class="gtn-eyebrow">Gittensor contribution intelligence</p>
    <h1 id="gtn-home-title">Gittensory</h1>
    <p class="gtn-hero__lead">Decision intelligence for Gittensor contributors and maintainers.</p>
    <p class="gtn-hero__body">
      Use MCP and GitHub App signals to help Gittensor miners choose better work, understand score blockers,
      reduce maintainer noise, and ship cleaner Gittensor submissions.
    </p>
    <div class="gtn-hero__actions">
      <a class="gtn-button gtn-button--primary" href="/guide/install">Install MCP</a>
      <a class="gtn-button" href="/guide/github-app-setup">GitHub App Setup</a>
    </div>
  </div>
  <figure class="gtn-hero__media">
    <img
      src="/images/gittensor-home-signal.webp"
      alt="Gittensor homepage showing live miner, reward, and repository activity."
      width="540"
      height="560"
    />
    <figcaption>
      <a href="https://gittensor.io/" target="_blank" rel="noreferrer">Context: Gittensor Subnet 74</a>
    </figcaption>
  </figure>
</section>

<section class="gtn-proof-strip" aria-label="Where Gittensory helps">
  <article>
    <span>01 / Gittensor miners</span>
    <h2>Pick work with fewer blind spots.</h2>
    <p>Score blockers, lane fit, queue pressure, and local branch preflight before opening another PR.</p>
  </article>
  <article>
    <span>02 / Maintainers</span>
    <h2>See signal without noisy checks.</h2>
    <p>Confirmed-miner comments, configured labels, reviewability context, and public-safe next steps.</p>
  </article>
  <article>
    <span>03 / Agents</span>
    <h2>Ask for repo-aware guidance.</h2>
    <p>Metadata-only MCP branch analysis for Codex, Claude, Cursor, and local automation.</p>
  </article>
  <article>
    <span>04 / Repo Owners</span>
    <h2>Tune intake before it gets loud.</h2>
    <p>Config quality, label readiness, maintainer-lane handling, and contribution intake health.</p>
  </article>
</section>

<section class="gtn-when">
  <div>
    <p class="gtn-eyebrow">When to use it</p>
    <h2>Before the work becomes review load.</h2>
  </div>
  <div class="gtn-when__grid">
    <p>Before opening a PR, check lane fit, linked issue expectations, validation evidence, and duplicate risk.</p>
    <p>After approvals, rerun scoreability projections with realistic pending-merge assumptions.</p>
    <p>When open PR pressure is high, decide whether cleanup beats opening new work.</p>
    <p>When a maintainer wants confirmed-miner context, keep the public surface quiet and sanitized.</p>
  </div>
</section>

<section class="gtn-signal-panel">
  <div>
    <p class="gtn-eyebrow">What Gittensory is</p>
    <h2>Not a Gittensor frontend.</h2>
    <p>
      Gittensory is not a Gittensor frontend. It is the private signal layer behind better Gittensor contributions:
      official miner context, registry lanes, queue pressure, scoreability projections,
      maintainer friction, and public-safe PR packets.
    </p>
  </div>
  <div class="gtn-terminal" aria-label="Gittensory signal example">
    <div><b>lane</b><span>direct_pr / issue_discovery / maintainer</span></div>
    <div><b>scoreability</b><span>current, ungated, and scenario-gated</span></div>
    <div><b>risk</b><span>open PR pressure, credibility, stale base</span></div>
    <div><b>output</b><span>private MCP JSON + sanitized PR packet</span></div>
  </div>
</section>
