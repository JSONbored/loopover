import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock, FeatureRow } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-releases")({
  head: () => ({
    meta: [
      { title: "Self-host releases and images — Gittensory docs" },
      {
        name: "description",
        content:
          "Use official Gittensory self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
      },
      { property: "og:title", content: "Self-host releases and images — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Use official Gittensory self-host images, tags, source maps, custom builds, release notes, and upgrade checks.",
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
              "Moves with the newest release. Useful for trials, not for controlled production.",
          },
          {
            title: "sha",
            description: "Immutable commit-derived tag for exact provenance and rollback.",
          },
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`docker pull ghcr.io/jsonbored/gittensory-selfhost:0.1.0
docker pull ghcr.io/jsonbored/gittensory-selfhost:latest`}
      />

      <h2>Upgrade flow</h2>
      <ol>
        <li>Read release notes for env, migration, or behavior changes.</li>
        <li>Back up the database or confirm Litestream health.</li>
        <li>Pull the new image tag.</li>
        <li>Recreate the app container.</li>
        <li>
          Check <code>/ready</code>, logs, queue metrics, and one test PR.
        </li>
      </ol>
      <CodeBlock
        lang="bash"
        code={`docker compose pull gittensory
docker compose up -d gittensory
curl http://localhost:8787/ready`}
      />

      <h2>Custom images</h2>
      <p>
        Custom builds are useful for testing local changes or including subscription CLIs. They
        should not contain secrets.
      </p>
      <CodeBlock
        lang="bash"
        code={`docker compose build --build-arg INSTALL_AI_CLIS=true gittensory
docker compose up -d gittensory`}
      />

      <h2>Sentry source maps</h2>
      <Callout variant="note">
        Official releases align <code>GITTENSORY_VERSION</code>, Sentry release ids, and uploaded
        source maps. For custom images, leave <code>SENTRY_RELEASE</code> unset unless you uploaded
        source maps for that exact built bundle.
      </Callout>

      <h2>Rollback</h2>
      <p>
        Roll back by pinning the prior image tag and recreating the container. Database migrations
        can make rollback harder, so keep backups and read release notes before upgrading a live
        maintainer instance.
      </p>
    </DocsPage>
  );
}
