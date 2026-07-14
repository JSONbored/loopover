import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-release-checklist")({
  head: () => ({
    meta: [
      { title: "First release checklist — LoopOver docs" },
      {
        name: "description",
        content:
          "Versioning and trigger for the first stable self-host image, the smoke-test matrix (direct App, brokered, air-gapped, each AI provider, SQLite/Postgres, Redis/Qdrant), an image-contents audit, the full-vs-minimal variant decision, and the GitHub Release notes template.",
      },
      { property: "og:title", content: "First release checklist — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Versioning, the smoke-test matrix, an image-contents audit, the image-variant decision, and the GitHub Release notes template for the first stable self-host image.",
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
      title="First release checklist"
      description="Everything to confirm before cutting orb-v0.1.0 — the first stable (non-prerelease) self-host image — after two beta cuts already validated the pipeline end to end. Run the smoke matrix against a candidate image before tagging any orb-vX.Y.Z or -rc/-beta prerelease; CI only exercises the plain SQLite + Redis + direct-App default."
    >
      <h2>Versioning and release trigger</h2>
      <p>
        <code>orb-v0.1.0-beta.1</code> and <code>orb-v0.1.0-beta.2</code> already exercised the full
        release pipeline — multi-arch build, provenance, SBOM, Sentry source-map upload and release
        validation, and GitHub Release creation — twice, successfully. Neither moved{" "}
        <code>latest</code> or produced an unmarked GitHub Release, because{" "}
        <Link to="/docs/self-hosting-releases">a prerelease tag never does</Link>. The natural next
        step is <strong>not a third beta</strong>: it is <code>orb-v0.1.0</code>, a plain{" "}
        <code>X.Y.Z</code> tag with no <code>-rc</code>/<code>-beta</code> suffix.
      </p>
      <p>
        The release workflow (<code>.github/workflows/release-selfhost.yml</code>) resolves this
        distinction itself from the tag text, not from a separate flag — pushing{" "}
        <code>orb-v0.1.0</code> runs through the identical build/provenance/SBOM/Sentry steps the
        two betas already proved out, but the <code>PRERELEASE</code> value it computes flips to{" "}
        <code>false</code>, which (per the release-image-tags guard added for this exact reason) is
        what allows the run to push the <code>latest</code> image tag and create a non-prerelease
        GitHub Release:
      </p>
      <CodeBlock
        lang="bash"
        code={`git fetch origin main
git tag orb-v0.1.0 origin/main   # only a commit reachable from main is accepted (verified in-workflow)
git push origin orb-v0.1.0`}
      />
      <Callout variant="safety">
        Only a non-prerelease <code>X.Y.Z</code> tag ever moves <code>latest</code> or the
        repo&apos;s unmarked &quot;Latest release&quot; — a <code>-rc</code>/<code>-beta</code> tag
        runs the same pipeline but is always excluded from both. Confirm the tag has no prerelease
        suffix before pushing it; there is no undo for <code>latest</code> once an operator has
        pulled it.
      </Callout>
      <p>
        Going forward, the scheme is ordinary semver under the <code>orb-v</code> prefix:{" "}
        <code>orb-v0.1.1</code> for a patch, the next minor version for a feature bump, and an{" "}
        <code>-rc.N</code>/<code>-beta.N</code> suffix on any tag that should run the pipeline
        without touching <code>latest</code> or the default GitHub Release. This checklist and the
        smoke matrix below apply to every future cut, not just the first.
      </p>

      <h2>First-release checklist</h2>
      <p>
        Work through this list once, in order, before pushing the <code>orb-v0.1.0</code> tag.
      </p>
      <FeatureRow
        items={[
          {
            title: "1. Smoke matrix green",
            description:
              "Every applicable scenario in the matrix below passes against a locally built candidate image (docker buildx build --load -t loopover:rc-candidate .).",
          },
          {
            title: "2. Image-contents audit reviewed",
            description:
              "The audit below (or a fresh re-read of the Dockerfile's runtime-prebuilt stage) confirms no source maps, .env, local auth, private config, secrets, or data volumes are baked in.",
          },
          {
            title: "3. Sentry behavior confirmed",
            description:
              "SENTRY_DSN unset boots cleanly with zero Sentry activity (initSentry short-circuits before importing @sentry/node); the release workflow still uploads source maps and validates the Sentry release regardless of what any operator's runtime DSN is set to.",
          },
          {
            title: "4. Variant decision applied",
            description:
              "Ship one default (full, INSTALL_AI_CLIS=true) image for this release — see the variant decision below.",
          },
          {
            title: "5. Release notes drafted",
            description:
              "The GitHub Release template below is filled in with what's supported, experimental, optional, and operator-owned for this version.",
          },
          {
            title: "6. Tag pushed from a commit on main",
            description:
              'git tag orb-v0.1.0 <sha-on-main> && git push origin orb-v0.1.0 — the workflow rejects any commit not reachable from main with "Self-host releases must be cut from a commit reachable from main."',
          },
          {
            title: "7. Release environment approved",
            description:
              "The release job runs under the release GitHub Environment; if reviewer approval is configured, approve the pending run so the build/push/Sentry/notes steps proceed.",
          },
          {
            title: "8. Post-publish verification",
            description:
              "docker pull the published orb-v0.1.0 and latest tags, confirm both resolve to the same digest, and re-run the fresh-install smoke scenario against the pulled (not locally built) image.",
          },
        ]}
      />
      <h2>Smoke-test matrix</h2>
      <p>
        Every scenario below shares the same core check — <code>scripts/smoke-selfhost.sh</code>{" "}
        boots one container against a fresh Redis on an isolated network, waits for it to become
        healthy, and asserts on <code>/health</code>, <code>/ready</code>, <code>/metrics</code>,
        and startup log events. What changes per scenario is the env you pass in and which events
        you expect (or forbid).
      </p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-token-sm">
          <thead>
            <tr className="border-hairline text-left text-token-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Scenario</th>
              <th className="py-2 pr-4 font-medium">Steps</th>
              <th className="py-2 font-medium">Pass criteria</th>
            </tr>
          </thead>
          <tbody className="divide-hairline">
            <tr>
              <td className="py-2 pr-4 align-top">Direct GitHub App (default)</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Run the base smoke command with no <code>ORB_ENROLLMENT_SECRET</code>.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>/health</code>, <code>/ready</code> ok;{" "}
                <code>selfhost_migrations_applied</code> logged;{" "}
                <code>selfhost_orb_relay_register</code> does NOT appear (relay is brokered-only).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Brokered — push mode</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Set <code>ORB_ENROLLMENT_SECRET</code> and a real, internet-reachable{" "}
                <code>PUBLIC_API_ORIGIN</code>.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>selfhost_orb_relay_register</code> logged;{" "}
                <code>selfhost_orb_relay_register_failed</code> does NOT appear (failure here is{" "}
                <code>error</code>-level and release-blocking).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Brokered — pull mode</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Set <code>ORB_ENROLLMENT_SECRET</code> and <code>ORB_RELAY_MODE=pull</code>, no
                inbound origin needed.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>selfhost_orb_relay_register</code> logged; a failed announce (
                <code>warn</code>-level) is tolerated since the drain loop keeps retrying.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Air-gapped / no telemetry</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Set <code>ORB_AIR_GAP=true</code>.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                No export attempt or export error logged; no outbound request to the collector URL
                at the network level.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">AI provider (Claude Code / Codex / both)</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Set <code>AI_PROVIDER</code> to each supported value with real credentials.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>selfhost_ai_provider</code> logged; <code>selfhost_ai_cli_missing</code> does
                NOT appear (release-blocking if it does — the image was built without{" "}
                <code>INSTALL_AI_CLIS=true</code>).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">SQLite (default) / Postgres</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Base command covers SQLite; boot a Postgres container and set{" "}
                <code>DATABASE_URL</code> for the Postgres path.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Both boot healthy and apply migrations; note in release notes which mode beta
                testers actually validated.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Redis (always-on) + optional Qdrant RAG</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Base command covers Redis; set <code>QDRANT_URL</code> against a booted Qdrant
                container for the RAG path.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>selfhost_redis_ready</code> always logged; <code>selfhost_vectorize</code>{" "}
                logged only when <code>QDRANT_URL</code> is set.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Fresh install</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Pull the published <code>orb-v0.1.0</code> tag on a clean host (no prior volumes)
                and boot via compose.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Container reports <code>healthy</code>; <code>/ready</code> returns 200 without any
                manual migration step.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Upgrade from a source-built deploy</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                On an instance previously deployed via{" "}
                <code>scripts/deploy-selfhost-prebuilt.sh</code>, run{" "}
                <code>
                  scripts/deploy-selfhost-image.sh
                  ghcr.io/&lt;owner&gt;/loopover-selfhost:orb-v0.1.0
                </code>
                .
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Only the <code>loopover</code> service restarts (<code>--no-deps</code>);{" "}
                <code>.env</code>, data volumes, and <code>loopover-config/</code> are untouched;{" "}
                <code>/ready</code> returns 200 after the health-check wait.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Rollback to prior tag</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Re-run <code>scripts/deploy-selfhost-image.sh</code> pinned to the prior tag/digest
                (e.g. <code>orb-v0.1.0-beta.2</code>).
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Service restarts healthy on the older image; confirmed safe only when nothing since
                the prior tag added a forward-only migration the older code can&apos;t tolerate (see{" "}
                <Link to="/docs/self-hosting-operations">Updating and rolling back</Link>).
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">One-service app restart</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Re-run either deploy script against the same tag with other profile services
                (Postgres, Redis, Qdrant, Grafana) already up.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Only the <code>loopover</code> container recreates; profile-service containers and
                their volumes are never touched.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Sentry release validation</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Confirm the release workflow&apos;s &quot;Validate Sentry release&quot; step passed
                for this tag (source maps uploaded, release finalized, commits attached).
              </td>
              <td className="py-2 align-top text-muted-foreground">
                <code>review-enrichment/scripts/validate-sentry-release.mjs</code> exits 0 within
                its 5-attempt retry-poll; the Sentry release id matches the baked{" "}
                <code>LOOPOVER_VERSION</code>.
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 align-top">Docs links resolve</td>
              <td className="py-2 pr-4 align-top text-muted-foreground">
                Follow every link in the release notes template below (setup guide, releases page,
                this checklist) from the published GitHub Release.
              </td>
              <td className="py-2 align-top text-muted-foreground">
                Every linked docs page loads and matches the version being released.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The scenario-by-scenario commands below give exact env and expected/forbidden log events for
        each row above.
      </p>
      <CodeBlock
        lang="bash"
        code={`# Build (or use a published tag) once, then run each scenario against the same image:
docker buildx build --load -t loopover:rc-candidate .
./scripts/smoke-selfhost.sh loopover:rc-candidate`}
      />

      <h3>Direct GitHub App mode (default)</h3>
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
./scripts/smoke-selfhost.sh loopover:rc-candidate`}
      />
      <p>
        <code>selfhost_orb_relay_register</code> must NOT appear here — relay registration is
        brokered-only and silently skips in direct mode (see{" "}
        <Link to="/docs/self-hosting-github-app">GitHub App and Orb</Link>).
      </p>

      <h3>Brokered mode (private / managed-beta only)</h3>
      <p>
        <code>ORB_ENROLLMENT_SECRET</code> set — the container gets tokens from the central Orb
        instead of its own App key. Relay mode changes what "working" means: push mode (
        <code>ORB_RELAY_MODE</code> unset, the default) needs a real public{" "}
        <code>PUBLIC_API_ORIGIN</code> and a failed registration is release-blocking (logged at{" "}
        <code>error</code>); pull mode (<code>ORB_RELAY_MODE=pull</code>) needs no inbound endpoint
        at all and tolerates a failed registration (logged at <code>warn</code>) since the drain
        loop keeps retrying regardless. Run BOTH scenarios — they exercise genuinely different code
        paths, not just different env (see{" "}
        <Link to="/docs/self-hosting-github-app">choosing a relay mode</Link>).
      </p>
      <CodeBlock
        lang="bash"
        code={`# Push mode (default) -- requires a real, internet-reachable PUBLIC_API_ORIGIN; the Orb
# SSRF-validates it server-side at registration time, so a loopback/private origin is rejected.
SELFHOST_SMOKE_EXTRA_ENV="ORB_ENROLLMENT_SECRET=\${TEST_ENROLLMENT_SECRET}
PUBLIC_API_ORIGIN=https://selfhost-smoke.example" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_orb_relay_register" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_orb_relay_register_failed" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate

# Pull mode -- no PUBLIC_API_ORIGIN needed; the container polls the broker outbound instead of
# exposing an inbound endpoint. The right fit for NAT/tailnet operators with no public ingress.
SELFHOST_SMOKE_EXTRA_ENV="ORB_ENROLLMENT_SECRET=\${TEST_ENROLLMENT_SECRET}
ORB_RELAY_MODE=pull" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_orb_relay_register" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_orb_relay_register_failed" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate`}
      />

      <h3>Air-gapped / no-telemetry mode</h3>
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
./scripts/smoke-selfhost.sh loopover:rc-candidate`}
      />

      <h3>AI provider: Claude Code / Codex / both</h3>
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
./scripts/smoke-selfhost.sh loopover:rc-candidate

# Codex only (requires the fail-closed opt-in)
SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=codex
LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER=1" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate

# Codex primary, Claude Code fallback
SELFHOST_SMOKE_EXTRA_ENV="AI_PROVIDER=codex,claude-code
CODEX_AI_EFFORT=medium
CLAUDE_AI_EFFORT=medium
CLAUDE_CODE_OAUTH_TOKEN=\${TEST_CLAUDE_TOKEN}
LOOPOVER_ENABLE_UNSAFE_CODEX_REVIEWER=1" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_ai_provider" \\
SELFHOST_SMOKE_FORBID_EVENTS="selfhost_ai_cli_missing" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate`}
      />
      <Callout variant="note">
        These need real credentials to reach a genuinely healthy <code>/ready</code> (it probes the
        configured AI provider). Where credentials aren't available for a given RC run, at minimum
        confirm <code>selfhost_ai_cli_missing</code> does NOT appear — that alone catches the
        release-blocking case (image built without <code>INSTALL_AI_CLIS=true</code>).
      </Callout>

      <h3>SQLite trial mode / Postgres production mode</h3>
      <p>
        SQLite is the default — the base smoke command above already covers it (no{" "}
        <code>DATABASE_URL</code> set). For Postgres, boot a Postgres container on the same network
        first and point <code>DATABASE_URL</code> at it.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker network create gt-pg-smoke
docker run -d --name gt-pg --network gt-pg-smoke -e POSTGRES_PASSWORD=devpw -e POSTGRES_DB=loopover postgres:16-alpine
SELFHOST_SMOKE_NETWORK=gt-pg-smoke \\
SELFHOST_SMOKE_EXTRA_ENV="DATABASE_URL=postgres://postgres:devpw@gt-pg:5432/loopover" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate
docker rm -f gt-pg && docker network rm gt-pg-smoke`}
      />
      <Callout variant="safety">
        SQLite is the trial/single-node default; recommend Postgres for production in release notes
        whenever this mode is what beta testers actually validated.
      </Callout>

      <h3>Redis cache + optional Qdrant RAG</h3>
      <p>
        Redis is always-on in every scenario above (the base script already boots it) — confirm{" "}
        <code>selfhost_redis_ready</code> appears with <code>githubResponseCacheEnabled</code>{" "}
        matching whatever <code>GITHUB_CACHE_TTL_SECONDS</code> you set. For the optional Qdrant RAG
        path, boot Qdrant on the same network and point <code>QDRANT_URL</code> at it.
      </p>
      <CodeBlock
        lang="bash"
        code={`SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_redis_ready" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate

# With Qdrant RAG:
docker network create gt-rag-smoke
docker run -d --name gt-qdrant --network gt-rag-smoke qdrant/qdrant:v1.18.2
SELFHOST_SMOKE_NETWORK=gt-rag-smoke \\
SELFHOST_SMOKE_EXTRA_ENV="QDRANT_URL=http://gt-qdrant:6333" \\
SELFHOST_SMOKE_EXPECT_EVENTS="selfhost_vectorize" \\
./scripts/smoke-selfhost.sh loopover:rc-candidate
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

      <h2>Image-contents audit</h2>
      <p>
        The <code>runtime-prebuilt</code> target — what the release workflow actually builds and
        pushes (<code>docker/build-push-action</code> is invoked with{" "}
        <code>target: runtime-prebuilt</code>) — copies exactly three things on top of the{" "}
        <code>runtime-base</code> layer: the pre-bundled <code>dist/server.mjs</code>, the{" "}
        <code>migrations/</code> SQL files, and <code>config/examples/</code> (generic, safe
        reference templates — shipping them activates nothing, since{" "}
        <code>LOOPOVER_REPO_CONFIG_DIR</code> still points at an operator-mounted{" "}
        <code>/config</code>). Nothing else reaches that stage.
      </p>
      <FeatureRow
        items={[
          {
            title: "Source maps — NOT included",
            description:
              "dist/server.mjs.map is produced during the build stage but only dist/server.mjs itself is COPYed into runtime-prebuilt (Dockerfile). The bundle's sourceMappingURL comment points at a file that does not exist in the image — the map is uploaded to Sentry in the release workflow instead and deliberately never ships.",
          },
          {
            title: ".env / secrets — NOT included",
            description:
              ".dockerignore excludes .env, .env.*, and .dev.vars (with .env.example explicitly re-allowed as a template). The Dockerfile never COPYs an env file at all; every secret is supplied at container run time via docker-compose.yml's env_file: .env or a mounted *_FILE path.",
          },
          {
            title: "Local auth / subscription-CLI credentials — NOT included",
            description:
              "The image bakes the Claude Code and Codex CLI binaries (when INSTALL_AI_CLIS=true) but no credentials. auth.json and **/.codex are in .dockerignore, and the Dockerfile symlinks /home/node/.codex to /data/codex — an operator-mounted volume — so any auth an operator sets up at runtime lands on their own persisted volume, never in an image layer.",
          },
          {
            title: "Private repo config — NOT included",
            description:
              "loopover-config and **/loopover-config are excluded via .dockerignore; only the generic config/examples/ reference templates are copied, and LOOPOVER_REPO_CONFIG_DIR is resolved against an operator-mounted /config at runtime.",
          },
          {
            title: "Data volumes — NOT included",
            description:
              "The SQLite database, Redis/Postgres/Qdrant data, and Grafana state are all named docker volumes declared in docker-compose.yml, mounted at runtime — none are part of the image's filesystem layers.",
          },
          {
            title: "Deployment overrides — NOT included",
            description:
              "docker-compose.override.yml(.example) and any host-specific compose profile config live outside the image entirely; the image only ever contains the application bundle plus its declared runtime dependencies.",
          },
          {
            title: "apps/ (loopover-ui) and test/ — excluded from the build context",
            description:
              "Already in .dockerignore alongside the existing exclusions (shipped ahead of this checklist, in the same #1819 hardening pass): the self-host bundle's only entry point is src/server.ts and npm ci only reads the root package*.json, so the UI workspace app and the test suite are never read during the image build (~11MB of this repo's ~22MB tracked-file footprint kept out).",
          },
          {
            title: "npm install cache — trimmed",
            description:
              "npm cache clean --force already runs immediately after the AI-CLI global install in the same RUN layer, removing the ~180MB download cache (~/.npm/_cacache) that npm install -g leaves behind but nothing at runtime ever reads.",
          },
        ]}
      />
      <p>
        Net effect of the two <code>.dockerignore</code>/Dockerfile changes audited above (already
        shipped, not part of this checklist itself): the built image measured <strong>754MB</strong>
        , down from 942MB before them. Re-verify the size on the actual published{" "}
        <code>orb-v0.1.0</code> image as part of the checklist:
      </p>
      <CodeBlock
        lang="bash"
        code={`docker pull ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0
docker images ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0 --format '{{.Size}}'`}
      />
      <Callout variant="note">
        This audit is Dockerfile-derived, not a runtime scan. If a future dependency bump adds a
        postinstall step that writes somewhere unexpected, re-check the{" "}
        <code>runtime-prebuilt</code> stage's <code>COPY</code>/<code>RUN</code> steps directly
        rather than assuming this list still holds.
      </Callout>

      <h2>One default image, not full/minimal variants</h2>
      <p>
        <code>INSTALL_AI_CLIS</code> is already a Dockerfile build-arg toggle (default{" "}
        <code>true</code>), and <code>INSTALL_VISUAL_REVIEW</code> is a second, independent one
        (default <code>false</code>) — see{" "}
        <Link to="/docs/self-hosting-releases">custom images</Link>. That means the
        &quot;minimal&quot; image the requirement asks about is already buildable today by anyone
        who wants it, as a <em>custom</em> build.
      </p>
      <p>
        For this first official release, publish only the one default (
        <code>INSTALL_AI_CLIS=true</code>) image under <code>orb-v0.1.0</code>. Reasons:
      </p>
      <FeatureRow
        items={[
          {
            title: "Every beta cut so far shipped this default",
            description:
              "Both orb-v0.1.0-beta.1 and orb-v0.1.0-beta.2 published the full image; a first stable release that changes what's default would be validating something the betas never tested.",
          },
          {
            title: "A second published tag doubles release surface for no proven demand",
            description:
              "Publishing full and minimal both means twice the build/push/Sentry/SBOM matrix, twice the smoke-test matrix, and twice the tag-naming and docs surface to keep correct — before any operator has asked for a slimmer image.",
          },
          {
            title: "The escape hatch already exists",
            description:
              "An operator who wants a smaller image without the AI CLIs can build it themselves today: docker compose build --build-arg INSTALL_AI_CLIS=false loopover. Nothing about shipping one default image forecloses adding a published minimal tag later.",
          },
        ]}
      />
      <Callout variant="note">
        Defer the full/minimal published-variant question, not the build-arg. If real operator
        demand for a smaller published tag shows up post-release, it's a follow-up release-workflow
        change (a second <code>docker/build-push-action</code> invocation with{" "}
        <code>INSTALL_AI_CLIS=false</code> and its own tag suffix), not a blocker for cutting{" "}
        <code>orb-v0.1.0</code>.
      </Callout>

      <h2>GitHub Release notes template</h2>
      <p>
        The release workflow&apos;s own &quot;GitHub Release&quot; step generates the notes body
        programmatically (see <code>.github/workflows/release-selfhost.yml</code>) — it does not use{" "}
        <code>--generate-notes</code>, specifically to avoid GitHub&apos;s 125,000-character
        release-body limit on a large commit history. The template below matches that generated body
        and extends it with the supported/experimental/optional/operator-owned breakdown this
        checklist calls for. Paste it into the release description in addition to (or in place of)
        the workflow-generated block when publishing <code>orb-v0.1.0</code>.
      </p>
      <CodeBlock
        lang="markdown"
        code={`LoopOver Orb container image:

\`\`\`bash
docker pull ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0
\`\`\`

Multi-arch (linux/amd64 + linux/arm64). See https://gittensory.aethereal.dev/docs/maintainer-self-hosting for setup.
Includes the Claude Code / Codex subscription CLIs by default; credentials stay runtime-only.
Sentry release id baked into the image: \`loopover-orb@0.1.0\`.

## First stable release

This is the first non-beta self-host image, following orb-v0.1.0-beta.1 and orb-v0.1.0-beta.2.
The \`latest\` tag now points here.

## Supported

- Direct GitHub App mode (the container's own GitHub App private key).
- SQLite (trial/single-node) and Postgres (production) database backends.
- Redis cache (required in every mode).
- Claude Code and Codex AI providers, including a provider chain with fallback.
- Health/readiness endpoints (\`/health\`, \`/ready\`, \`/metrics\`) and the documented log-event contract.
- Rollback to a prior image tag and one-service (\`loopover\` only) restart, via
  \`scripts/deploy-selfhost-image.sh\` / \`scripts/deploy-selfhost-prebuilt.sh\`.

## Experimental

- Brokered mode (\`ORB_ENROLLMENT_SECRET\`) — managed-beta / private use; both push and pull relay modes
  are smoke-tested but see less real-world traffic than direct App mode.
- Qdrant-backed RAG indexing.
- Visual review via an external Chrome sidecar (\`INSTALL_VISUAL_REVIEW=true\`).

## Optional

- Sentry error tracking — OFF by default; set your own \`SENTRY_DSN\` to enable. Release source maps
  are uploaded and validated for this image regardless of whether any operator enables runtime
  reporting.
- OpenTelemetry tracing/metrics export.
- Discord/Slack review-outcome notifications.
- The observability profile (Prometheus, Grafana, Loki, Alertmanager) and the backup profile.

## Operator-owned

- \`.env\`, \`loopover-config/\`, and all data volumes (database, Redis, Qdrant, Grafana) — never
  overwritten by an update and never baked into the image.
- GitHub App credentials or \`ORB_ENROLLMENT_SECRET\`, AI-provider credentials, and any \`SENTRY_DSN\`.
- Resource limits and profile selection — see [Resource profiles](https://gittensory.aethereal.dev/docs/self-hosting-operations)
  for measured CPU/memory guidance per profile.
- Backup and restore procedure — see [Backup and scaling](https://gittensory.aethereal.dev/docs/self-hosting-backup-scaling).

Full changelog: compare against \`orb-v0.1.0-beta.2\`.`}
      />

      <p>
        After every applicable scenario passes, continue with the normal{" "}
        <Link to="/docs/self-hosting-releases">upgrade flow</Link> to cut the tag and publish the
        image.
      </p>
    </DocsPage>
  );
}
