import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-releases")({
  head: () => ({
    meta: [
      { title: "Self-host releases and images — LoopOver docs" },
      {
        name: "description",
        content:
          "Use official LoopOver self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
      },
      { property: "og:title", content: "Self-host releases and images — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Use official LoopOver self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
      },
      { property: "og:url", content: "/docs/self-hosting-releases" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-releases" }],
  }),
  component: SelfHostingReleases,
});

function SelfHostingReleases() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Releases and images"
      description="How to consume official self-host images, pin versions, build custom images, and keep source maps aligned."
    >
      <h2>Image tags</h2>
      <FeatureRow
        items={[
          {
            title: "version",
            description: "Pinned release tag. Use this in production.",
          },
          {
            title: "latest",
            description:
              "Moves with the newest STABLE release only — never a prerelease. Useful for trials, not for controlled production.",
          },
          {
            title: "sha",
            description: "Immutable commit-derived tag for exact provenance and rollback.",
          },
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`docker pull ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0
docker pull ghcr.io/jsonbored/loopover-selfhost:latest`}
      />
      <Callout variant="note" title="Renamed from gittensory-selfhost">
        <code>ghcr.io/jsonbored/loopover-selfhost</code> is the only name new releases publish
        under. The pre-rename <code>ghcr.io/jsonbored/gittensory-selfhost</code> is no longer
        published to, but an existing pin to a specific tag or digest under that name keeps
        resolving — pull it and switch to the new name at your convenience.
      </Callout>

      <h2>Prerelease (beta/rc) images</h2>
      <p>
        A tag like <code>orb-v0.1.0-rc.1</code> or <code>orb-v0.1.0-beta.1</code> runs the identical
        build/provenance/SBOM/Sentry pipeline as a stable release, but is marked prerelease on
        GitHub and is never pushed under <code>latest</code>. External beta testers should pull the
        exact prerelease tag, not <code>latest</code>.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker pull ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0-rc.1`}
      />
      <Callout variant="note">
        Stable release behavior is unchanged: a plain <code>X.Y.Z</code> tag still moves{" "}
        <code>latest</code> and publishes an unmarked (non-prerelease) GitHub Release.
      </Callout>
      <Callout variant="safety">
        Before tagging any <code>orb-v*</code> release or prerelease, run the{" "}
        <Link to="/docs/self-hosting-release-checklist">release checklist</Link> against the built
        image — CI only smoke-tests the plain SQLite + Redis + direct-App default, not brokered
        mode, air-gapped mode, or any AI provider.
      </Callout>

      <h2>Upgrade flow</h2>
      <ol>
        <li>Read release notes for env, migration, or behavior changes.</li>
        <li>Back up the database or confirm Litestream health.</li>
        <li>
          Pull and restart with <code>scripts/deploy-selfhost-image.sh</code> (or rebuild the
          checkout with <code>scripts/deploy-selfhost-prebuilt.sh</code>) — both restart only the{" "}
          <code>loopover</code> service (<code>--no-deps</code>) and wait for it to report{" "}
          <code>healthy</code> before returning, instead of a bare <code>docker compose up -d</code>{" "}
          that returns as soon as the container starts.
        </li>
        <li>
          Check <code>/ready</code>, logs, queue metrics, and one test PR.
        </li>
      </ol>
      <CodeBlock
        lang="bash"
        code={`# Recommended: pull a published tag, restart, wait for healthy
./scripts/deploy-selfhost-image.sh ghcr.io/jsonbored/loopover-selfhost:orb-v0.1.0
curl http://localhost:8787/ready

# Building from the current checkout instead of pulling
./scripts/deploy-selfhost-prebuilt.sh`}
      />
      <Callout variant="note">
        Both scripts pin a version: the image script accepts a tag/digest argument or{" "}
        <code>LOOPOVER_IMAGE</code>; the prebuilt script derives <code>SENTRY_RELEASE</code>/
        <code>LOOPOVER_VERSION</code> from the checked-out commit (
        <code>git rev-parse --short=8 HEAD</code>) unless you set <code>SENTRY_RELEASE</code>{" "}
        yourself. A plain{" "}
        <code>docker compose pull loopover &amp;&amp; docker compose up -d loopover</code> still
        works, but skips the health-check wait loop and input validation both scripts provide.
      </Callout>

      <h2>Custom images</h2>
      <p>
        Custom builds are useful for testing local changes, including subscription CLIs, or trimming
        the image. They should not contain secrets. <code>INSTALL_AI_CLIS</code> (default{" "}
        <code>true</code>) installs the Claude Code and Codex CLIs; a sibling build-arg,{" "}
        <code>INSTALL_VISUAL_REVIEW</code> (default <code>false</code>), adds{" "}
        <code>puppeteer-core</code> for visual capture.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose build --build-arg INSTALL_AI_CLIS=true loopover
docker compose up -d loopover`}
      />

      <h2>Sentry source maps</h2>
      <Callout variant="note">
        Official releases align <code>LOOPOVER_VERSION</code>, Sentry release ids, and uploaded
        source maps. For custom images, leave <code>SENTRY_RELEASE</code> unset unless you uploaded
        source maps for that exact built bundle.
      </Callout>

      <h2>Rollback</h2>
      <p>
        There is no dedicated rollback command. Roll back by re-running{" "}
        <code>scripts/deploy-selfhost-image.sh</code> pinned to the prior image tag or digest (or{" "}
        <code>scripts/deploy-selfhost-prebuilt.sh</code> against an older checkout) — the same
        script you upgrade with, pointed backward.
      </p>
      <Callout variant="warn" title="Migrations are forward-only">
        This repo has no down-migration convention (<code>scripts/check-migrations.mjs</code> and{" "}
        <code>migrations/</code> only ever add forward). If a migration already ran forward before
        you need to roll back, reverting the app image does not revert the schema — the rolled-back
        code now runs against a newer schema than it expects. Keep backups and read release notes
        for migration changes before upgrading a live maintainer instance, and treat a
        post-migration rollback as a case that needs a manual schema/data plan, not just an image
        swap.
      </Callout>
    </DocsPage>
  );
}
