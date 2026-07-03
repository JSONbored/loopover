import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("self-host Sentry release wiring", () => {
  it("keeps source-map uploads in the maintainer release workflow only", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");
    expect(releaseWorkflow).toContain('sourcemaps inject dist');
    expect(releaseWorkflow).toContain(
      'sourcemaps upload --release="$SENTRY_RELEASE" --validate --wait --strict dist',
    );
    // `sentry-cli releases set-commits --commit` can silently leave a release with zero associated
    // commits against a repo connected via the modern GitHub App integration -- a direct PUT to the
    // release resource with an inline `commits` array is what actually satisfies the later
    // SENTRY_REQUIRE_COMMITS=true validation (confirmed empirically cutting the first beta release).
    expect(releaseWorkflow).not.toContain('"$SENTRY_CLI_PACKAGE" releases set-commits');
    expect(releaseWorkflow).toContain(
      "/api/0/organizations/${SENTRY_ORG}/releases/",
    );
    expect(releaseWorkflow).toContain(
      "commits:[{repository: process.env.SENTRY_REPOSITORY, id: process.env.SENTRY_COMMIT_SHA}]",
    );
    expect(releaseWorkflow).toContain('SENTRY_CLI_PACKAGE: "@sentry/cli@3.6.0"');
    expect(releaseWorkflow).toContain('npx -y "$SENTRY_CLI_PACKAGE"');
    expect(releaseWorkflow).not.toContain("@sentry/cli@latest");
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
      "docker pull ghcr.io/${REPOSITORY_OWNER_LOWER}/gittensory-selfhost:${RELEASE_TAG}",
    );
    expect(releaseWorkflow).not.toContain('"selfhost-v*"');
    expect(releaseWorkflow).not.toContain('VERSION="${REF_NAME#selfhost-v}"');
    expect(releaseWorkflow).not.toContain("type=raw,value=${{ steps.version.outputs.v }}");
    expect(releaseWorkflow).toContain("Validate Sentry release");
    expect(releaseWorkflow).toContain('SENTRY_REQUIRE_FINALIZED: "true"');

    const edgeDeployScript = read("scripts/deploy-selfhost-prebuilt.sh");
    expect(edgeDeployScript).toContain(
      'SENTRY_CLI_PACKAGE="${SENTRY_CLI_PACKAGE:-@sentry/cli@3.6.0}"',
    );
    expect(edgeDeployScript).toContain(
      'SENTRY_RELEASE="${SENTRY_RELEASE:-gittensory-selfhost@$(git rev-parse --short=8 HEAD)}"',
    );
    expect(edgeDeployScript).not.toContain('env_get SENTRY_RELEASE');
    expect(edgeDeployScript).not.toContain("@sentry/cli@latest");
    expect(releaseWorkflow).toContain("target: runtime-prebuilt");
    expect(releaseWorkflow).toContain(
      "GITTENSORY_VERSION=${{ steps.version.outputs.release }}",
    );

    for (const path of [
      "scripts/build-selfhost.mjs",
      "Dockerfile",
      ".github/workflows/selfhost.yml",
    ]) {
      expect(read(path)).not.toContain("sourcemaps upload");
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
