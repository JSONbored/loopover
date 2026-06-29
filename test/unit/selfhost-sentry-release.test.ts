import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("self-host Sentry release wiring", () => {
  it("keeps source-map uploads in the maintainer release workflow only", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");
    expect(releaseWorkflow).toContain('sourcemaps inject dist');
    expect(releaseWorkflow).toContain(
      'sourcemaps upload --release="$SENTRY_RELEASE" dist',
    );
    expect(releaseWorkflow).toContain(
      'releases set-commits "$SENTRY_RELEASE" --auto',
    );
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
