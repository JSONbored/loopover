import { describe, expect, it } from "vitest";
import { isNpmLockfilePath, lockfileTamperRiskFinding } from "../../src/review/lockfile-tamper";
import type { PullRequestFileRecord } from "../../src/types";

function fileRecord(over: Partial<PullRequestFileRecord> & { path: string }): PullRequestFileRecord {
  return { repoFullName: "acme/widgets", pullNumber: 3, status: "modified", additions: 1, deletions: 0, changes: 1, payload: {}, ...over };
}

function lockfilePatch(body: string): PullRequestFileRecord {
  return fileRecord({ path: "package-lock.json", payload: { patch: body } });
}

function manifestPatch(body: string): PullRequestFileRecord {
  return fileRecord({ path: "package.json", payload: { patch: body } });
}

describe("isNpmLockfilePath", () => {
  it("matches package-lock.json at any depth", () => {
    expect(isNpmLockfilePath("package-lock.json")).toBe(true);
    expect(isNpmLockfilePath("review-enrichment/package-lock.json")).toBe(true);
    expect(isNpmLockfilePath("apps/gittensory-ui/package-lock.json")).toBe(true);
    expect(isNpmLockfilePath("PACKAGE-LOCK.JSON")).toBe(true); // case-insensitive
  });

  it("does not match other lockfiles or unrelated files", () => {
    expect(isNpmLockfilePath("yarn.lock")).toBe(false);
    expect(isNpmLockfilePath("pnpm-lock.yaml")).toBe(false);
    expect(isNpmLockfilePath("src/package-lock.json.ts")).toBe(false);
    expect(isNpmLockfilePath("package.json")).toBe(false);
  });
});

describe("lockfileTamperRiskFinding", () => {
  it("returns null when no lockfile changed", () => {
    expect(lockfileTamperRiskFinding([fileRecord({ path: "src/index.ts", payload: { patch: "@@\n+const x = 1;" } })])).toBeNull();
  });

  it("returns null for a lockfile change with no patch", () => {
    expect(lockfileTamperRiskFinding([fileRecord({ path: "package-lock.json", payload: {} })])).toBeNull();
  });

  it("does NOT trigger a legitimate dependency bump (version + resolved + integrity all change together)", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.21",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '+      "integrity": "sha512-newnewnew=="',
      '     },',
    ].join("\n");
    const manifestDiff = ['@@ -10,7 +10,7 @@', '   "dependencies": {', '-    "lodash": "^4.17.20",', '+    "lodash": "^4.17.21",'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).toBeNull();
  });

  it("triggers on a hand-edited resolved/integrity with NO corresponding package.json version bump", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.20",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "integrity": "sha512-tamperedtampered=="',
      '     },',
    ].join("\n");
    // No package.json change at all — the resolved tree was hand-edited without any manifest bump.
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.code).toBe("lockfile_tamper_risk");
    expect(finding?.severity).toBe("warning");
    expect(finding?.title).toContain("lodash");
  });

  it("triggers when package.json changed but NOT the flagged package's version", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.20",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "integrity": "sha512-tamperedtampered=="',
      '     },',
    ].join("\n");
    // package.json changed, but for a DIFFERENT package (express), so lodash's unbumped resolved is still suspicious.
    const manifestDiff = ['@@ -10,7 +10,7 @@', '   "dependencies": {', '-    "express": "^4.18.0",', '+    "express": "^4.19.0",'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("lodash");
  });

  it("triggers on a resolved URL outside the npm registry, even with a version bump", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.21",',
      '+      "resolved": "https://evil.example.com/lodash/-/lodash-4.17.21.tgz",',
      '+      "integrity": "sha512-newnewnew=="',
      '     },',
    ].join("\n");
    const manifestDiff = ['@@ -10,7 +10,7 @@', '   "dependencies": {', '-    "lodash": "^4.17.20",', '+    "lodash": "^4.17.21",'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });

  it("scans review-enrichment/package-lock.json and apps/gittensory-ui/package-lock.json the same way", () => {
    const lockPatch = [
      '@@ -1,4 +1,4 @@',
      '     "node_modules/left-pad": {',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "integrity": "sha512-tamperedtampered=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([fileRecord({ path: "review-enrichment/package-lock.json", payload: { patch: lockPatch } })]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("review-enrichment/package-lock.json");

    const findingUi = lockfileTamperRiskFinding([fileRecord({ path: "apps/gittensory-ui/package-lock.json", payload: { patch: lockPatch } })]);
    expect(findingUi).not.toBeNull();
    expect(findingUi?.detail).toContain("apps/gittensory-ui/package-lock.json");
  });

  it("bare (non-node_modules) top-level package key is tracked as a package name (lockfileVersion 1 shape)", () => {
    const lockPatch = ['@@ -1,4 +1,4 @@', '   "dependencies": {', '     "left-pad": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     }'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("left-pad");
  });

  it("ignores unrelated context lines and only reacts to resolved/integrity keys", () => {
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/lodash": {', '       "version": "4.17.21",', '-      "dev": true', '+      "dev": false', '     },'].join("\n");
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("resolves a scoped package name from a node_modules/@scope/name path", () => {
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/@babel/core": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     },'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("@babel/core");
  });

  it("treats a node_modules/ key with nothing after the marker as not a package entry", () => {
    // rest.split("/")[0] is "" (falsy) for a key that is exactly "node_modules/" — npmPackageFromNodeModulesPath
    // returns null, and since "node_modules/" is not in CONTAINER_KEYS but sawPackagesEntry may already be true
    // from a prior real entry, it is skipped rather than mis-tracked as a package named "node_modules/".
    const lockPatch = [
      '@@ -1,8 +1,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '+      "version": "4.17.21",',
      '     },',
      '     "node_modules/": {',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "integrity": "sha512-tamperedtampered=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).toBeNull();
  });

  it("falls back to the literal key for a malformed node_modules/@scope path (no package segment)", () => {
    // npmPackageFromNodeModulesPath returns null for a bare "@scope" segment (no "/name" after it); the parser
    // then falls through to treating the full key as a literal (non-container) package name — still flagged,
    // just under the raw key rather than a resolved "@scope/name".
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/@babel": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     },'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("node_modules/@babel");
  });

  it("ignores a package.json file with no patch at all", () => {
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/lodash": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     },'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), fileRecord({ path: "package.json", payload: {} })]);
    expect(finding).not.toBeNull();
  });

  it("ignores a package.json patch line that is not a string-valued key (not a dependency assignment)", () => {
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/lodash": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     },'].join("\n");
    const manifestDiff = ['@@ -1,3 +1,3 @@', '   "dependencies": {', '-  "private": true,', '+  "private": false,'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).not.toBeNull();
  });

  it("does not flag a package whose manifest range is REMOVED and RE-ADDED with the identical range (no real bump)", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.20",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "integrity": "sha512-tamperedtampered=="',
      '     },',
    ].join("\n");
    // Manifest re-orders (removes + re-adds) lodash at the SAME range, and genuinely bumps express — proves the
    // "identical range" case does not spuriously mark lodash as bumped while a real bump still registers.
    const manifestDiff = [
      '@@ -10,8 +10,8 @@',
      '   "dependencies": {',
      '-    "express": "^4.18.0",',
      '-    "lodash": "^4.17.20",',
      '+    "express": "^4.19.0",',
      '+    "lodash": "^4.17.20",',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("lodash");
  });

  it("still flags a changed integrity with no version bump even when the package is ALSO being dropped from package.json (#2563 gate-review follow-up)", () => {
    // The tamper signal is now self-contained to the lockfile entry's OWN version field (see the module header
    // comment on why this replaced the package.json cross-reference) — a package.json removal is irrelevant to
    // it. If lodash is genuinely being dropped, its lockfile entry should be REMOVED too, not silently have its
    // integrity swapped while the entry stays present with an unchanged version; that is exactly the suspicious
    // shape this check exists to catch.
    const lockPatch = ['@@ -1,4 +1,4 @@', '     "node_modules/lodash": {', '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', '     },'].join("\n");
    const manifestDiff = ['@@ -10,4 +10,3 @@', '   "dependencies": {', '-    "lodash": "^4.17.20",', '     "express": "^4.18.0"'].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch), manifestPatch(manifestDiff)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("lodash");
  });

  it("collapses multiple flagged packages into one finding, capping the title list and reporting the overflow count", () => {
    const packages = ["alpha", "bravo", "charlie", "delta", "echo"];
    const lockPatch = packages
      .map((name) => [`     "node_modules/${name}": {`, '-      "integrity": "sha512-oldoldold=="', '+      "integrity": "sha512-tamperedtampered=="', "     },"].join("\n"))
      .join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.title).toContain("+2 more");
    expect(finding?.detail).toContain("alpha");
    expect(finding?.detail).toContain("echo");
  });

  // #2563 gate-review follow-up: the original package.json-cross-reference signal could never see a
  // TRANSITIVE dependency (never listed in any package.json), so it misfired on every ordinary transitive
  // bump -- the vast majority of any real lockfile diff. The fix compares against the SAME entry's own
  // "version" line instead, which a genuine npm install/update always bumps alongside resolved/integrity.
  it("does NOT flag a transitive dependency bump (own version line changes, no package.json anywhere in the diff)", () => {
    const lockPatch = [
      '@@ -40,6 +40,6 @@',
      '     "node_modules/send": {',
      '-      "version": "0.18.0",',
      '-      "resolved": "https://registry.npmjs.org/send/-/send-0.18.0.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "0.19.0",',
      '+      "resolved": "https://registry.npmjs.org/send/-/send-0.19.0.tgz",',
      '+      "integrity": "sha512-newnewnew=="',
      "     },",
    ].join("\n");
    // No package.json in this diff at all -- "send" is a transitive dependency of a direct dependency, never
    // listed in any manifest, exactly the majority-case shape a real `npm update` produces.
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).toBeNull();
  });

  // #2563 gate-review follow-up: an npm workspace's own local packages have a `resolved` field that is a
  // relative filesystem path, not a URL -- the old exact-registry-prefix check misclassified any such value
  // as off-registry the moment it changed (i.e. on every routine workspace-member version bump).
  it("does NOT flag a workspace-local package's relative-path resolved value as off-registry", () => {
    const lockPatch = [
      "@@ -2,7 +2,7 @@",
      '     "packages/gittensory-mcp": {',
      '-      "version": "0.6.0",',
      '-      "resolved": "packages/gittensory-mcp",',
      "       \"link\": true",
      '+      "version": "0.7.0",',
      '+      "resolved": "packages/gittensory-mcp",',
      "       \"link\": true",
      "     },",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).toBeNull();
  });

  it("still flags a genuine off-registry resolved URL (an http(s) URL outside registry.npmjs.org)", () => {
    const lockPatch = [
      '@@ -10,4 +10,4 @@',
      '     "node_modules/evil-pkg": {',
      '-      "version": "1.0.0",',
      '-      "resolved": "https://registry.npmjs.org/evil-pkg/-/evil-pkg-1.0.0.tgz",',
      '+      "version": "1.0.0",',
      '+      "resolved": "https://attacker.example.com/evil-pkg-1.0.0.tgz",',
      "     },",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("evil-pkg");
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });
});
