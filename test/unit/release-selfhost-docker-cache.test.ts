import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release-selfhost.yml Docker layer caching (#2502, isolated after a cache-poisoning finding)", () => {
  it("caches the multi-arch build-push-action step in a scope isolated from selfhost.yml's CI build", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");
    const selfhostWorkflow = read(".github/workflows/selfhost.yml");

    const buildStep = releaseWorkflow.slice(
      releaseWorkflow.indexOf("- name: Build + push (linux/amd64 + linux/arm64)"),
      releaseWorkflow.indexOf("- name: Finalize Sentry release"),
    );
    // #2502 originally had this step share selfhost.yml's DEFAULT (unscoped) GHA cache bucket for speed.
    // A release/publish path reading from a bucket that regular CI writes to on every push/PR to this
    // repo is a cache-poisoning vector into an officially published, public image -- caught reviewing
    // the first cut release. `scope=release-orb` fixes this properly instead of going cold forever: a
    // completely separate GHA cache namespace that ONLY this workflow ever reads from or writes to.
    expect(buildStep).toContain("cache-from: type=gha,scope=release-orb");
    expect(buildStep).toContain("cache-to: type=gha,mode=max,scope=release-orb");

    // selfhost.yml's own CI build must stay on the default (unscoped) bucket -- if it ever also wrote to
    // `scope=release-orb`, the isolation this fix depends on would be gone.
    expect(selfhostWorkflow).toContain("--cache-from type=gha");
    expect(selfhostWorkflow).toContain("--cache-to type=gha,mode=max");
    expect(selfhostWorkflow).not.toContain("release-orb");
  });
});
