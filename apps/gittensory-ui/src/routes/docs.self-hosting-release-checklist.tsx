import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-release-checklist")({
  head: () => ({
    meta: [
      { title: "Beta release checklist — Gittensory docs" },
      {
        name: "description",
        content:
          "The smoke matrix to run before publishing a self-host RC image: direct App, brokered, air-gapped, each AI provider, SQLite/Postgres, Redis/Qdrant. Portable commands, expected log events, known-warnings table.",
      },
      { property: "og:title", content: "Beta release checklist — Gittensory docs" },
      {
        property: "og:description",
        content:
          "The smoke matrix to run before publishing a self-host RC image: direct App, brokered, air-gapped, each AI provider, SQLite/Postgres, Redis/Qdrant.",
      },
      { property: "og:url", content: "/docs/self-hosting-release-checklist" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-release-checklist" }],
  }),
  component: SelfHostingReleaseChecklist,
});

function SelfHostingReleaseChecklist() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Beta release checklist"
      description="Run this smoke matrix against a candidate image before tagging it orb-vX.Y.Z or an -rc/-beta prerelease. Each scenario is a mode a real operator will run; CI only exercises the plain SQLite + Redis + direct-App default."
    >
      <p>
        Every scenario below shares the same core check — <code>scripts/smoke-selfhost.sh</code>{" "}
        boots one container against a fresh Redis on an isolated network, waits for it to become
        healthy, and asserts on <code>/health</code>, <code>/ready</code>, <code>/metrics</code>,
        and startup log events. What changes per scenario is the env you pass in and which events
        you expect (or forbid).
      </p>
      <CodeBlock
        lang="bash"
        code={`# Build (or use a published tag) once, then run each scenario against the same image:
docker buildx build --load -t gittensory:rc-candidate .
./scripts/smoke-selfhost.sh gittensory:rc-candidate`}
      />

      <h2>1. Direct GitHub App mode (default)</h2>
      <p>
        No <code>ORB_ENROLLMENT_SECRET</code> — the container uses its own GitHub App private key.
        Telemetry export is always-on in this mode too; a clean run produces no export error.
      </p>
      <CodeBlock
        lang="bash"
        code={`# A private key is multiline PEM -- mount it as a file instead of an env value (SELFHOST_SMOKE_EXTRA_ENV
# is line-delimited and would truncate it). GITHUB_APP_PRIVATE_KEY_FILE is loaded into
# GITHUB_APP_PRIVATE_KEY at startup, same as every other *_FILE variable.
SELFHOST_SMOKE_EXTRA_VOLUMES="\${TEST_APP_PRIVATE_KEY_PATH}:/run/secrets/github-app-private-key.pem:ro" \\
SELFHOST_SMOKE_EXTRA_ENV="GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github-app-private-key.pem" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_orb_export_error,selfhost_orb_relay_register" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate`}
      />
      <p>
        <code>selfhost_orb_relay_register</code> must NOT appear here — relay registration is
        brokered-only and silently skips in direct mode (see{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>).
      </p>

      <h2>2. Brokered mode (private / managed-beta only)</h2>
      <p>
        <code>ORB_ENROLLMENT_SECRET</code> set — the container gets tokens from the central Orb
        instead of its own App key. A working push-mode registration logs{" "}
        <code>selfhost_orb_relay_register</code>; a broken one is fatal for push mode (logged at{" "}
        <code>error</code>, not <code>warn</code>).
      </p>
      <CodeBlock
        lang="bash"
        code={`SELFHOST_SMOKE_EXTRA_ENV="ORB_ENROLLMENT_SECRET=\${TEST_ENROLLMENT_SECRET}
PUBLIC_API_ORIGIN=https://selfhost-smoke.example" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_orb_relay_register" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_orb_relay_register_failed" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate`}
      />

      <h2>3. Air-gapped / no-telemetry mode</h2>
      <p>
        <code>ORB_AIR_GAP=true</code> disables the fleet-calibration export entirely. There is no
        "air-gap confirmed" log event — the export function returns before doing anything, so
        silence (no export error, no export attempt) is the signal. Confirm at the network level
        too: no outbound request to the collector URL.
      </p>
      <CodeBlock
        lang="bash"
        code={`SELFHOST_SMOKE_EXTRA_ENV="ORB_AIR_GAP=true" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_orb_export_error,selfhost_orb_relay_register" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate`}
      />

      <h2>4. AI provider: Claude Code / Codex / both</h2>
      <p>
        Each provider choice must log <code>selfhost_ai_provider</code> and must NOT log{" "}
        <code>selfhost_ai_cli_missing</code> (a CLI-subscription provider whose binary isn't on{" "}
        <code>PATH</code> silently produces no review output — this must be caught here, not in
        production).
      </p>
      <CodeBlock
        lang="bash"
        code={`# Claude Code only
SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=claude-code
CLAUDE_CODE_OAUTH_TOKEN=\${TEST_CLAUDE_TOKEN}" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate

# Codex only (requires the fail-closed opt-in)
SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=codex
GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate

# Codex primary, Claude Code fallback
SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=codex,claude-code
CODEX_AI_EFFORT=medium
CLAUDE_AI_EFFORT=medium
CLAUDE_CODE_OAUTH_TOKEN=\${TEST_CLAUDE_TOKEN}
GITTENSORY_ENABLE_UNSAFE_CODEX_REVIEWER=1" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate`}
      />
      <Callout variant="note">
        These need real credentials to reach a genuinely healthy <code>/ready</code> (it probes the
        configured AI provider). Where credentials aren't available for a given RC run, at minimum
        confirm <code>selfhost_ai_cli_missing</code> does NOT appear — that alone catches the
        release-blocking case (image built without <code>INSTALL_AI_CLIS=true</code>).
      </Callout>

      <h2>5. SQLite trial mode / Postgres production mode</h2>
      <p>
        SQLite is the default — the base smoke command above already covers it (no{" "}
        <code>DATABASE_URL</code> set). For Postgres, boot a Postgres container on the same network
        first and point <code>DATABASE_URL</code> at it.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker network create gt-pg-smoke
docker run -d --name gt-pg --network gt-pg-smoke -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=gittensory postgres:16-alpine
SELFHOST_SMOKE_NETWORK=gt-pg-smoke \\
SELFHOST_SMOKE_EXTRA_ENV="DATABASE_URL=postgres://postgres:devpw@gt-pg:5432/gittensory" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate
docker rm -f gt-pg && docker network rm gt-pg-smoke`}
      />
      <Callout variant="safety">
        SQLite is the trial/single-node default; recommend Postgres for production in release notes
        whenever this mode is what beta testers actually validated.
      </Callout>

      <h2>6. Redis cache + optional Qdrant RAG</h2>
      <p>
        Redis is always-on in every scenario above (the base script already boots it) — confirm{" "}
        <code>selfhost_redis_ready</code> appears with <code>githubResponseCacheEnabled</code>{" "}
        matching whatever <code>GITHUB_CACHE_TTL_SECONDS</code> you set. For the optional Qdrant RAG
        path, boot Qdrant on the same network and point <code>QDRANT_URL</code> at it.
      </p>
      <CodeBlock
        lang="bash"
        code={`SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_redis_ready" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate

# With Qdrant RAG:
docker network create gt-rag-smoke
docker run -d --name gt-qdrant --network gt-rag-smoke qdrant/qdrant:v1.18.2
SELFHOST_SMOKE_NETWORK=gt-rag-smoke \\
SELFHOST_SMOKE_EXTRA_ENV="QDRANT_URL=http://gt-qdrant:6333" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_vectorize" \\
./scripts/smoke-selfhost.sh gittensory:rc-candidate
docker rm -f gt-qdrant && docker network rm gt-rag-smoke`}
      />

      <h2>Expected startup events</h2>
      <FeatureRow
        items={[
          {
            title: "selfhost_listening",
            description: "Always. HTTP server bound and accepting connections.",
          },
          {
            title: "selfhost_migrations_applied",
            description: "Always. The smoke script asserts this on every scenario.",
          },
          {
            title: "selfhost_redis_ready",
            description: "Always. Confirms the mandatory Redis dependency is reachable.",
          },
          {
            title: "selfhost_ai_provider",
            description: "Only when AI_PROVIDER is set. Confirms the provider chain resolved.",
          },
          {
            title: "selfhost_vectorize",
            description: "Only when QDRANT_URL is set. Confirms the Qdrant RAG backend is wired.",
          },
          {
            title: "selfhost_orb_relay_register",
            description: "Only in brokered mode. Confirms relay registration with the central Orb.",
          },
        ]}
      />

      <h2>Known warnings: acceptable in beta vs. release-blocking</h2>
      <FeatureRow
        items={[
          {
            title: "selfhost_orb_relay_register_failed (pull mode)",
            description:
              "Acceptable in beta. Logged at warn — pull-mode relay still drains events outbound even when the announce fails.",
          },
          {
            title: "selfhost_orb_relay_register_failed (push mode)",
            description:
              "Release-blocking. Logged at error — a failed push-mode announce means the container looks alive but never receives events.",
          },
          {
            title: "selfhost_ai_cli_missing",
            description:
              "Release-blocking. A CLI-subscription provider that can't run silently produces zero review output in production.",
          },
          {
            title: "selfhost_orb_export_error (isolated, one-off)",
            description:
              "Acceptable in beta if transient (e.g. a single collector timeout) — the hourly retry recovers. Persistent recurrence across the whole smoke run is release-blocking.",
          },
        ]}
      />

      <p>
        After every applicable scenario passes, continue with the normal{" "}
        <Link to="/docs/self-hosting-releases">upgrade flow</Link> to cut the tag and publish the
        image.
      </p>
    </DocsPage>
  );
}
