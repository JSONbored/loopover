import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression pins for #8525: the reconcile self-heal dispatches publish-*.yml bare (against main
// head), and the tag-creation path used to tag-and-pack HEAD -- during a runner backlog that placed
// ui-kit-v1.1.2 two commits late, silently sweeping the would-be 1.1.3 fix into the 1.1.2 tag and
// published artifact, and zombifying the open v1.1.3 release PR (release-please saw "No commits for
// path" behind the misplaced tag and could neither regenerate nor prune it). Every publish workflow
// must resolve the commit that INTRODUCED the current version into its package.json and tag/pack
// THERE; an unresolvable release commit must abort, never fall back to head.

const WORKFLOWS = [
  ".github/workflows/publish-engine.yml",
  ".github/workflows/publish-mcp.yml",
  ".github/workflows/publish-miner.yml",
  ".github/workflows/publish-ui-kit.yml",
] as const;

const read = (path: string) => readFileSync(path, "utf8");

describe("publish workflows tag the resolved release commit, never HEAD (#8525)", () => {
  it.each(WORKFLOWS)("%s resolves the version-introducing commit and aborts when it cannot", (path) => {
    const workflow = read(path);
    // The resolver: newest main commit whose diff introduced this exact version string into the
    // package's own package.json (the release PR's merge commit).
    expect(workflow).toContain('-S "\\"version\\": \\"${VERSION}\\"" refs/remotes/origin/main --');
    // Fail-loud contract: no resolved commit ⇒ hard exit before any tag work.
    expect(workflow).toContain("refusing to guess (would tag main head). (#8525)");
    // The resolved commit must be verified reachable from main before use.
    expect(workflow).toContain('git merge-base --is-ancestor "$RELEASE_SHA" refs/remotes/origin/main');
    // The artifact is packed from the release commit's own tree, not the dispatch head.
    expect(workflow).toContain('git checkout --detach "$RELEASE_SHA"');
  });

  it.each(WORKFLOWS)("%s creates the annotated tag at $RELEASE_SHA and never at bare HEAD", (path) => {
    const workflow = read(path);
    // The tag object is anchored to the resolved release commit passed across the job boundary.
    expect(workflow).toContain("RELEASE_SHA: ${{ needs.validate.outputs.release_sha }}");
    expect(workflow).toMatch(/git tag -a "\$TAG" -m "[^"]+" "\$RELEASE_SHA"/);
    // The old head-tagging form must stay dead in both jobs.
    expect(workflow).not.toContain("Creating tag $TAG at HEAD");
    expect(workflow).not.toMatch(/git tag -a "\$TAG" -m "[^"]+"\s*\n/);
  });

  it.each(WORKFLOWS)("%s's pre-existing-tag check compares against the release commit, not HEAD", (path) => {
    const workflow = read(path);
    expect(workflow).toContain('if [ "$TAG_SHA" != "$RELEASE_SHA" ]; then');
    expect(workflow).not.toContain('if [ "$TAG_SHA" != "$HEAD_SHA" ]; then');
  });
});
