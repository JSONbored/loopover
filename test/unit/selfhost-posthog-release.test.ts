import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("self-host PostHog release wiring", () => {
  it("keeps source-map uploads in the maintainer release workflow only", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");
    // Explicit --release-name AND --release-version, never a bare --release-version: posthog-cli
    // auto-derives its own release-name from git/package.json when --release-name is omitted (this repo
    // resolves to "loopover"), silently doubling the stored release id into
    // "loopover@loopover-orb@$VERSION" -- which the "Validate PostHog release" step below would never find.
    expect(releaseWorkflow).toContain(
      'sourcemap inject --directory dist --release-name "$POSTHOG_RELEASE_NAME" --release-version "$POSTHOG_RELEASE_VERSION"',
    );
    expect(releaseWorkflow).toContain(
      'sourcemap upload --directory dist --release-name "$POSTHOG_RELEASE_NAME" --release-version "$POSTHOG_RELEASE_VERSION"',
    );
    expect(releaseWorkflow).toContain("POSTHOG_RELEASE_NAME: loopover-orb");
    expect(releaseWorkflow).toContain("POSTHOG_RELEASE_VERSION: ${{ steps.version.outputs.v }}");
    // No separate "create release"/"set-commits"/"finalize" steps -- PostHog release metadata is a
    // byproduct of the inject/upload calls themselves, unlike Sentry's releases/commits/deploys/finalize
    // lifecycle this replaced.
    expect(releaseWorkflow).not.toContain("releases new");
    expect(releaseWorkflow).not.toContain("releases set-commits");
    expect(releaseWorkflow).not.toContain("releases finalize");
    expect(releaseWorkflow).not.toContain("Finalize");
    expect(releaseWorkflow).toContain('POSTHOG_CLI_PACKAGE: "@posthog/cli@0.9.1"');
    expect(releaseWorkflow).toContain('npx -y "$POSTHOG_CLI_PACKAGE"');
    expect(releaseWorkflow).not.toContain("@posthog/cli@latest");
    expect(releaseWorkflow).toContain("node review-enrichment/scripts/validate-posthog-release.mjs");
    expect(releaseWorkflow).not.toContain("review-enrichment/scripts/validate-sentry-release.mjs");
    expect(releaseWorkflow).toContain('"orb-v*"');
    expect(releaseWorkflow).toContain('orb-v*) VERSION="${REF_NAME#orb-v}"');
    expect(releaseWorkflow).toContain("tag=orb-v${VERSION}");
    // #1937: the resolved version tag flows steps.version.outputs.tag -> VERSION_TAG env -> the "Resolve
    // image tags" step's bash, not inlined directly into docker/metadata-action's `tags:` anymore (that
    // step now needs to conditionally omit `latest` for a prerelease, which a plain multi-line literal
    // can't express).
    expect(releaseWorkflow).toContain("VERSION_TAG: ${{ steps.version.outputs.tag }}");
    expect(releaseWorkflow).toContain("type=raw,value=${VERSION_TAG}");
    expect(releaseWorkflow).toContain("tags: ${{ steps.tags.outputs.list }}");
    // Docker rejects a mixed-case image reference client-side -- `github.repository_owner` preserves
    // the org's actual casing ("JSONbored"), so the release-notes pull command must lowercase it itself
    // (docker/metadata-action does this automatically for the real image tags, but this hand-written
    // notes block doesn't go through it).
    expect(releaseWorkflow).toContain('REPOSITORY_OWNER_LOWER="${REPOSITORY_OWNER,,}"');
    expect(releaseWorkflow).toContain(
      "docker pull ghcr.io/${REPOSITORY_OWNER_LOWER}/loopover-selfhost:${RELEASE_TAG}",
    );
    // #4777: the "Image metadata" step must only push the renamed image now -- publishing under the
    // pre-rename "gittensory-selfhost" name has stopped.
    expect(releaseWorkflow).toContain(
      "ghcr.io/${{ github.repository_owner }}/loopover-selfhost",
    );
    expect(releaseWorkflow).not.toContain(
      "ghcr.io/${{ github.repository_owner }}/gittensory-selfhost",
    );
    expect(releaseWorkflow).not.toContain('"selfhost-v*"');
    expect(releaseWorkflow).not.toContain('VERSION="${REF_NAME#selfhost-v}"');
    expect(releaseWorkflow).not.toContain("type=raw,value=${{ steps.version.outputs.v }}");
    expect(releaseWorkflow).toContain("Validate PostHog release");
    expect(releaseWorkflow).toContain("Require PostHog token for official release");
    expect(releaseWorkflow).not.toContain("SENTRY_");

    const edgeDeployScript = read("scripts/deploy-selfhost-prebuilt.sh");
    expect(edgeDeployScript).toContain(
      'POSTHOG_CLI_PACKAGE="${POSTHOG_CLI_PACKAGE:-@posthog/cli@0.9.1}"',
    );
    expect(edgeDeployScript).toContain(
      'POSTHOG_RELEASE="${POSTHOG_RELEASE:-loopover-selfhost@$(git rev-parse --short=8 HEAD)}"',
    );
    expect(edgeDeployScript).not.toContain("env_get SENTRY_RELEASE");
    expect(edgeDeployScript).not.toContain("@posthog/cli@latest");
    expect(edgeDeployScript).not.toContain("SENTRY_");
    expect(releaseWorkflow).toContain("target: runtime-prebuilt");
    expect(releaseWorkflow).toContain(
      "LOOPOVER_VERSION=${{ steps.version.outputs.release }}",
    );

    for (const path of [
      "scripts/build-selfhost.ts",
      "Dockerfile",
      ".github/workflows/selfhost.yml",
    ]) {
      expect(read(path)).not.toContain("sourcemap upload");
    }
  });

  it("does not copy source maps into the runtime image", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("npm install -g --foreground-scripts");
    expect(dockerfile).not.toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).toContain(
      "COPY --from=build --chown=node:node /app/dist/server.mjs ./dist/server.mjs",
    );
    expect(dockerfile).toContain(
      "COPY --chown=node:node dist/server.mjs ./dist/server.mjs",
    );

    const dockerignore = read(".dockerignore");
    expect(dockerignore).toContain("dist/*");
    expect(dockerignore).toContain("!dist/server.mjs");
    expect(dockerignore).not.toContain("!dist/server.mjs.map");
  });
});
