import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-quickstart")({
  head: () => ({
    meta: [
      { title: "Self-hosting quickstart — LoopOver docs" },
      {
        name: "description",
        content:
          "Bring up the LoopOver self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:title", content: "Self-hosting quickstart — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Bring up the LoopOver self-host review service, run readiness checks, and choose the first safe rollout mode.",
      },
      { property: "og:url", content: "/docs/self-hosting-quickstart" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-quickstart" }],
  }),
  component: SelfHostingQuickstart,
});

function SelfHostingQuickstart() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Quickstart"
      description="A minimal self-host boot path for maintainers: start the service, verify readiness, and keep the first rollout safe."
    >
      <h2>1. Copy the sample env</h2>
      <p>
        <code>.env.selfhost.example</code> is the short path: required secrets plus a conservative
        first-boot config, with nothing about the Cloudflare Worker deploy. Copy it and fill in the
        placeholders — keep your real <code>.env</code> out of git and prefer mounted secret files
        for multiline values like the GitHub App private key.
      </p>
      <CodeBlock
        lang="bash"
        code={`cp .env.selfhost.example .env
# edit .env`}
      />
      <Callout variant="warn">
        The webhook secret and static bearer tokens (<code>GITHUB_WEBHOOK_SECRET</code>,{" "}
        <code>GITTENSORY_API_TOKEN</code>, <code>GITTENSORY_MCP_TOKEN</code>,{" "}
        <code>INTERNAL_JOB_TOKEN</code>, <code>SELFHOST_SETUP_TOKEN</code>) ship commented out on
        purpose. Generate a distinct random value for each one (e.g.{" "}
        <code>openssl rand -hex 32</code>) — never reuse the same string across more than one of
        them. The app refuses to boot if any of these is left at a known-placeholder or too-short
        value.
      </Callout>
      <Callout variant="note">
        <code>.env.selfhost.example</code> already ships a conservative starting config —{" "}
        <code>dry-run</code> mode, a small repo allowlist, unified comments, safety, and grounding,
        with AI, RAG, and REES left off. Switch to live only after webhook delivery, logs, and
        review output match expectations. For every optional env var (observability, backup,
        additional AI providers) see <code>.env.example</code>'s self-host section or the{" "}
        <Link to="/docs/self-hosting-configuration">generated reference table</Link>.
      </Callout>

      <h2>2. Choose your AI provider (optional)</h2>
      <p>
        Skip this step for a fully deterministic review (no AI). Otherwise set{" "}
        <code>AI_PROVIDER</code> to one provider or a fallback chain. The self-host image bundles
        both CLIs by default; credentials and provider choice are runtime-only.
      </p>
      <CodeBlock
        filename=".env — Claude Code only"
        code={`AI_PROVIDER=claude-code
CLAUDE_AI_EFFORT=medium
CLAUDE_CODE_OAUTH_TOKEN=          # from \`claude setup-token\``}
      />
      <CodeBlock
        filename=".env — Codex only"
        code={`AI_PROVIDER=codex
CODEX_AI_EFFORT=medium
GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1   # required opt-in; see Callout below`}
      />
      <CodeBlock
        filename=".env — Codex primary, Claude Code fallback"
        code={`AI_PROVIDER=codex,claude-code
CODEX_AI_EFFORT=medium
CLAUDE_AI_EFFORT=medium
CLAUDE_CODE_OAUTH_TOKEN=
GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1`}
      />
      <p>
        Set <code>AI_DUAL_REVIEW=1</code> only when you deliberately want the first two providers to
        run as independent reviewers instead of a fallback chain.
      </p>
      <Callout variant="warn" title="Codex is fail-closed by default">
        Codex stores its OAuth credential in <code>auth.json</code> on the same filesystem that
        prompt-influenced reviews can read, so it requires explicit opt-in (
        <code>GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1</code>) and a mounted{" "}
        <code>/data/codex</code> auth volume. Claude Code has no equivalent restriction. See{" "}
        <Link to="/docs/self-hosting-ai-providers">AI providers</Link> for the full reference.
      </Callout>

      <h2>3. Boot the stack</h2>
      <p>
        <strong>Recommended: pull the published image.</strong> No local build, no Node toolchain —
        the script pulls, restarts, and waits for the health check to pass.
      </p>
      <CodeBlock
        lang="bash"
        code={`./scripts/deploy-selfhost-image.sh
curl http://localhost:8787/health
curl http://localhost:8787/ready`}
      />
      <p>
        Pin a specific release instead of <code>:latest</code>, or point at your own registry:
      </p>
      <CodeBlock
        lang="bash"
        code={`./scripts/deploy-selfhost-image.sh ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0
GITTENSORY_IMAGE=ghcr.io/jsonbored/loopover-selfhost@sha256:... ./scripts/deploy-selfhost-image.sh`}
      />
      <p>
        <code>ghcr.io/jsonbored/gittensory-selfhost</code> (the pre-rename name) remains available
        as a deprecated alias of the identical image during the deprecation window — existing pins
        keep working unmodified.
      </p>
      <Callout variant="note" title="Building from source instead">
        Contributors and anyone customizing the Dockerfile can still build locally —{" "}
        <code>docker compose up -d --build</code> builds the <code>gittensory</code> service from
        the checkout instead of pulling a published image. Everything else in this quickstart (env,
        health checks, GitHub App) is identical either way. Two build-args trim the image:{" "}
        <code>--build-arg INSTALL_AI_CLIS=false</code> skips the Claude Code/Codex CLIs (default{" "}
        <code>true</code>), and <code>--build-arg INSTALL_VISUAL_REVIEW=true</code> adds{" "}
        <code>puppeteer-core</code> for visual capture (default <code>false</code> — needs a{" "}
        <code>BROWSER_WS_ENDPOINT</code> at runtime).
      </Callout>
      <FeatureRow
        items={[
          {
            title: "/health",
            description: "Liveness. It confirms the HTTP process is up.",
          },
          {
            title: "/ready",
            description:
              "Readiness. It returns 200 only after database access, migrations, and every configured backend (Redis, GitHub App auth, the AI provider, and any of Qdrant/Postgres you've enabled) are healthy.",
          },
          {
            title: "/metrics",
            description: "Prometheus metrics for queue, jobs, HTTP traffic, uptime, and AI usage.",
          },
        ]}
      />

      <h2>4. Install or connect the GitHub App</h2>
      <p>
        Point your App webhook to <code>https://your-host.example/v1/github/webhook</code>, set the
        same webhook secret in <code>GITHUB_WEBHOOK_SECRET</code>, install the App on one test repo,
        and open a small PR. The direct App and Orb modes are covered in{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>.
      </p>
      <Callout variant="note">
        Set <code>ADMIN_GITHUB_LOGINS</code> to a comma/whitespace-separated list of GitHub logins
        before signing in to the control panel — it's the only allowlist for the operator role
        (operator dashboard, drift status). No login is authorized as operator without it.
      </Callout>

      <h2>5. Watch the first review</h2>
      <p>Look for these logs during boot and the first webhook:</p>
      <CodeBlock
        code={`selfhost_listening
selfhost_migrations_applied
selfhost_ai_provider          # only when AI_PROVIDER is set
selfhost_job_dead             # investigate immediately if present
review_context_fetch_failed   # REES/RAG/grounding context failure`}
      />
      <p>
        A cold first boot on SQLite commonly logs a one-time{" "}
        <code>selfhost_migrations_applied</code> burst and a brief Redis connection retry while the
        sidecar finishes starting — both are expected and stop once the stack is warm. Anything else
        that looks wrong, or a <code>/ready</code> that stays unhealthy past a couple minutes, is
        covered in <Link to="/docs/self-hosting-troubleshooting">Troubleshooting</Link>.
      </p>
      <p>
        After the deterministic path is stable, continue with{" "}
        <Link to="/docs/self-hosting-configuration">Configuration</Link> and then layer in AI, REES,
        or RAG deliberately.
      </p>

      <h2>6. Activate your first repo</h2>
      <p>
        Three separate knobs are easy to conflate — each does something different, and all three
        matter for a smooth first rollout:
      </p>
      <FeatureRow
        items={[
          {
            title: "GITTENSORY_REVIEW_REPOS (env allowlist)",
            description:
              "Turns on the per-PR converged review path (unified comment, safety, grounding, RAG, etc.) for named repos. Empty means none — even when the global GITTENSORY_REVIEW_* flags are true.",
          },
          {
            title: "Gate activation (DB or private config)",
            description:
              "Turns on the LoopOver check-run and deterministic gate rules for a repo. One-click via the control panel or POST /v1/repos/:owner/:repo/activation; or set gate.checkMode / gate.enabled in a mounted private .loopover.yml (legacy .gittensory.yml also still works, #4773).",
          },
          {
            title: "is_registered (Gittensor registry)",
            description:
              "Set automatically when your repo appears in the GITTENSOR_REGISTRY_URL snapshot. Needed for Gittensor-scored mining/evidence features, not for basic PR review on a self-host.",
          },
        ]}
      />
      <p>
        <strong>Recommended first-repo path today:</strong> add the repo to{" "}
        <code>GITTENSORY_REVIEW_REPOS</code>, seed a private global default, then enable advisory
        gate mode once webhook delivery works.
      </p>
      <CodeBlock
        filename=".env"
        code={`GITTENSORY_REVIEW_REPOS=owner/my-repo
SELFHOST_DEPLOYMENT_MODE=dry-run   # keep shadowing until you trust output`}
      />
      <p>
        Copy the shipped global private default into the compose-mounted config directory (edit your
        copy — never commit real policy to a public repo):
      </p>
      <CodeBlock
        lang="bash"
        code={`mkdir -p gittensory-config
cp config/examples/global.gittensory.yml gittensory-config/.loopover.yml
# legacy: gittensory-config/.gittensory.yml also still works with zero changes (#4773)
# optional per-repo override:
mkdir -p gittensory-config/owner__my-repo
cp config/examples/global.gittensory.yml gittensory-config/owner__my-repo/.loopover.yml`}
      />
      <p>
        Sign in to the control panel (<code>ADMIN_GITHUB_LOGINS</code> must include your GitHub
        login), open the repo workspace, preview what LoopOver would have flagged on recent PRs,
        then enable advisory mode in one click — the same patch as:
      </p>
      <CodeBlock
        lang="bash"
        code={`curl -X POST "https://reviews.example.com/v1/repos/owner/my-repo/activation" \\
  -H "Authorization: Bearer <session-or-api-token>" \\
  -H "Content-Type: application/json" \\
  -d '{}'`}
      />
      <Callout variant="note">
        That activation endpoint turns on the gate check plus deterministic rules in{" "}
        <strong>advisory</strong> mode (non-blocking, no auto-merge) — a CodeRabbit-style ramp. AI
        review stays off until you configure it separately. Full semantics in{" "}
        <Link to="/docs/self-hosting-configuration">Configuration</Link>.
      </Callout>
      <Callout variant="warn" title="Checks: write on the GitHub App">
        If reviews compute but no <code>Gittensory Orb Review Agent</code> check-run appears, open
        your App&apos;s permissions page and confirm <strong>Checks: write</strong> is granted —
        <code>checks: read</code> alone 403s the write silently. New permissions also require a
        one-time re-approval on each installation; see{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>.
      </Callout>
      <p>
        When output looks right, switch <code>SELFHOST_DEPLOYMENT_MODE</code> from{" "}
        <code>dry-run</code> to unset (live writes). For a shorter future path, see the onboarding
        proposal on <Link to="/docs/maintainer-self-hosting">Self-hosted reviews</Link>.
      </p>

      <h2>Defaults at a glance</h2>
      <p>
        Nothing below needs a flag to start; everything past the first row needs an explicit{" "}
        <code>--profile</code> (combine freely) or an explicit <code>AI_PROVIDER</code>.
      </p>
      <CodeBlock
        lang="text"
        code={`ENABLED BY DEFAULT (no flags needed)
  gittensory app + Redis        SQLite database, dry-run-friendly, Orb telemetry (see Callout below)

RECOMMENDED FOR PRODUCTION (opt-in)
  --profile postgres             shared/multi-instance database (pgvector-capable)
  --profile pgbouncer            connection pooling in front of Postgres
  --profile caddy                automatic HTTPS via Let's Encrypt
  --profile litestream            continuous SQLite backup to S3-compatible storage
  --profile observability        Prometheus + Alertmanager + Loki + Grafana

OPT-IN, NOT REQUIRED FOR A TRIAL INSTANCE
  --profile qdrant                dedicated RAG vector store (else sqlite-vec/pgvector)
  --profile ollama                local model for AI review or embeddings
  --profile tailscale             private network sidecar
  --profile runners               self-hosted GitHub Actions runner
  --profile backup                scheduled backup + backup-exporter jobs
  AI_PROVIDER=...                 off by default; reviews are deterministic-only until set`}
      />
      <Callout variant="safety">
        Orb fleet-calibration telemetry (verdict, outcome, cycle time — never repo names, code, or
        logins) starts automatically once your GitHub App is configured — this is the self-hosting
        contract, not a flag you turn on. The one way to disable it is the explicit air-gap flag:
        set <code>ORB_AIR_GAP=true</code> for an instance that sends nothing.
      </Callout>
      <p>
        <code>--profile caddy</code> gets you real public HTTPS; <code>--profile tailscale</code>{" "}
        adds private tailnet reachability (it does not remove the default public port on its own —
        see the callout below) — see <Link to="/docs/self-hosting-security">Security</Link>'s TLS
        termination section for the full walkthrough of each (Caddyfile setup, DNS prerequisites,
        hardening Tailscale for real isolation, and when to pick one over the other).
      </p>
    </DocsPage>
  );
}
