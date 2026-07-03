import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("release-selfhost.yml Docker layer caching (#2502, reverted for cache-poisoning)", () => {
  it("does NOT share selfhost.yml's GHA cache scope in the release build-push-action step", () => {
    const releaseWorkflow = read(".github/workflows/release-selfhost.yml");

    const buildStep = releaseWorkflow.slice(
      releaseWorkflow.indexOf("- name: Build + push (linux/amd64 + linux/arm64)"),
      releaseWorkflow.indexOf("- name: Finalize Sentry release"),
    );
    // #2502 originally had this step share selfhost.yml's CI build's GHA cache scope for speed. A
    // release/publish path inheriting layers from that shared, more broadly-writable cache (written to
    // by every push/PR to this repo) is a cache-poisoning vector into an officially published, public
    // image -- removed once that risk surfaced reviewing the first cut release. The release build must
    // stay cold: no cache-from/cache-to at all.
    expect(buildStep).not.toContain("cache-from: type=gha");
    expect(buildStep).not.toContain("cache-to: type=gha,mode=max");
  });
});
