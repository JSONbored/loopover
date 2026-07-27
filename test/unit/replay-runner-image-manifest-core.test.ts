import { describe, expect, it } from "vitest";

import {
  buildReplayRunnerImageManifest,
  checkReplayRunnerImageManifestDrift,
  type ReplayRunnerImageManifest,
} from "../../scripts/replay-runner-image-manifest-core";

const BASE_INPUT = {
  baseImageRef: "node:22-slim@sha256:" + "a".repeat(64),
  dockerfileContent: "FROM node:22-slim\nCOPY . .\n",
  packageLockContent: '{"name":"loopover","lockfileVersion":3}',
  sourceFileContents: {
    "scripts/a.ts": "export const a = 1;",
    "scripts/b.ts": "export const b = 2;",
  },
};

describe("buildReplayRunnerImageManifest", () => {
  it("hashes every source file individually and produces a single top-level digest", () => {
    const manifest = buildReplayRunnerImageManifest(BASE_INPUT);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.baseImageRef).toBe(BASE_INPUT.baseImageRef);
    expect(manifest.dockerfileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.packageLockSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.sourceFiles)).toEqual(["scripts/a.ts", "scripts/b.ts"]);
    expect(manifest.sourceFiles["scripts/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: identical inputs produce a byte-identical manifest", () => {
    expect(buildReplayRunnerImageManifest(BASE_INPUT)).toEqual(buildReplayRunnerImageManifest(BASE_INPUT));
  });

  it("sorts sourceFiles by path regardless of input object key order", () => {
    const manifest = buildReplayRunnerImageManifest({
      ...BASE_INPUT,
      sourceFileContents: { "scripts/z.ts": "z", "scripts/a.ts": "a" },
    });
    expect(Object.keys(manifest.sourceFiles)).toEqual(["scripts/a.ts", "scripts/z.ts"]);
  });

  it("changes the digest when the Dockerfile content changes but nothing else does", () => {
    const a = buildReplayRunnerImageManifest(BASE_INPUT);
    const b = buildReplayRunnerImageManifest({ ...BASE_INPUT, dockerfileContent: BASE_INPUT.dockerfileContent + "\n# comment" });
    expect(a.dockerfileSha256).not.toBe(b.dockerfileSha256);
    expect(a.digest).not.toBe(b.digest);
  });

  it("changes the digest when a single source file's content changes", () => {
    const a = buildReplayRunnerImageManifest(BASE_INPUT);
    const b = buildReplayRunnerImageManifest({
      ...BASE_INPUT,
      sourceFileContents: { ...BASE_INPUT.sourceFileContents, "scripts/a.ts": "export const a = 2;" },
    });
    expect(a.sourceFiles["scripts/b.ts"]).toBe(b.sourceFiles["scripts/b.ts"]); // unaffected file unchanged
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("checkReplayRunnerImageManifestDrift", () => {
  it("reports no drift when comparing a manifest to itself", () => {
    const manifest = buildReplayRunnerImageManifest(BASE_INPUT);
    expect(checkReplayRunnerImageManifestDrift(manifest, manifest)).toEqual({ drifted: false });
  });

  it("reports baseImageRef, Dockerfile, and lockfile drift by name", () => {
    const committed = buildReplayRunnerImageManifest(BASE_INPUT);
    const fresh = buildReplayRunnerImageManifest({ ...BASE_INPUT, baseImageRef: "node:22-slim@sha256:" + "b".repeat(64), dockerfileContent: "changed", packageLockContent: "changed" });
    const result = checkReplayRunnerImageManifestDrift(committed, fresh);
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.reasons.some((r) => r.startsWith("baseImageRef:"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("Dockerfile changed:"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("package-lock.json changed:"))).toBe(true);
  });

  it("reports a schemaVersion mismatch (a stale on-disk manifest read after a future schema bump)", () => {
    const committed = buildReplayRunnerImageManifest(BASE_INPUT);
    // `schemaVersion` is a numeric-literal-1 type by construction; a manifest read back from disk after a
    // real schema migration would parse in with a DIFFERENT number, which the type system can't express here
    // without a cast -- exactly what this branch exists to catch at runtime instead.
    const fresh: ReplayRunnerImageManifest = { ...committed, schemaVersion: 2 as 1 };
    const result = checkReplayRunnerImageManifestDrift(committed, fresh);
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.reasons).toContain("schemaVersion: committed 1, fresh 2");
  });

  it("reports a changed source file by path, distinct from an added or removed one", () => {
    const committed = buildReplayRunnerImageManifest(BASE_INPUT);
    const fresh = buildReplayRunnerImageManifest({
      ...BASE_INPUT,
      sourceFileContents: { "scripts/a.ts": "export const a = 999;", "scripts/c.ts": "export const c = 3;" }, // a changed, b removed, c added
    });
    const result = checkReplayRunnerImageManifestDrift(committed, fresh);
    expect(result.drifted).toBe(true);
    if (!result.drifted) return;
    expect(result.reasons).toContain("source file changed: scripts/a.ts");
    expect(result.reasons).toContain("source file removed: scripts/b.ts");
    expect(result.reasons).toContain("source file added: scripts/c.ts");
  });
});
