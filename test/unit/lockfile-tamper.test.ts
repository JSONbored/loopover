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
    expect(isNpmLockfilePath("apps/loopover-ui/package-lock.json")).toBe(true);
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

  it("triggers on a hand-edited resolved/integrity with NO corresponding lockfile-entry version bump", () => {
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

  it("flags a non-http remote resolved URL outside the npm registry, even with a version bump", () => {
    const lockPatch = [
      '@@ -100,8 +100,8 @@',
      '     "node_modules/lodash": {',
      '-      "version": "4.17.20",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "version": "4.17.21",',
      '+      "resolved": "git+ssh://git@attacker.example.com/lodash.git#deadbeef",',
      '+      "integrity": "sha512-newnewnew=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("lodash");
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });

  it("scans review-enrichment/package-lock.json and apps/loopover-ui/package-lock.json the same way", () => {
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

    const findingUi = lockfileTamperRiskFinding([fileRecord({ path: "apps/loopover-ui/package-lock.json", payload: { patch: lockPatch } })]);
    expect(findingUi).not.toBeNull();
    expect(findingUi?.detail).toContain("apps/loopover-ui/package-lock.json");
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
      '     "packages/loopover-mcp": {',
      '-      "version": "0.6.0",',
      '-      "resolved": "packages/loopover-mcp",',
      "       \"link\": true",
      '+      "version": "0.7.0",',
      '+      "resolved": "packages/loopover-mcp",',
      "       \"link\": true",
      "     },",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).toBeNull();
  });

  // REGRESSION (#2563 gate-review follow-up on #2692): two DISTINCT lockfileVersion 2/3 entries can share the
  // same bare package name (npm nests a second copy under a dependent's own node_modules when versions
  // conflict) -- keying candidates by bare name merged them into one shared record, so a legitimate bump on
  // ONE entry masked an unbumped, tampered resolved/integrity edit on the OTHER. Keying by the full entry path
  // fixes this; both orderings are tested since the old bug's masking depended on which block was processed last.
  it("does NOT let a legitimate bump on one nested copy of a package mask a tampered edit on ANOTHER nested copy of the SAME package name", () => {
    const lockPatch = [
      '@@ -1,16 +1,16 @@',
      '     "node_modules/foo": {',
      '-      "version": "1.0.0",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '-      "integrity": "sha512-old1=="',
      '+      "version": "1.1.0",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.1.0.tgz",',
      '+      "integrity": "sha512-new1=="',
      '     },',
      '     "node_modules/bar/node_modules/foo": {',
      '       "version": "2.0.0",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz",',
      '-      "integrity": "sha512-old2=="',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz",',
      '+      "integrity": "sha512-tampered2=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
  });

  it("still catches the masking scenario in the REVERSE order (tampered entry processed before the legitimately-bumped one)", () => {
    const lockPatch = [
      '@@ -1,16 +1,16 @@',
      '     "node_modules/bar/node_modules/foo": {',
      '       "version": "2.0.0",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz",',
      '-      "integrity": "sha512-old2=="',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-2.0.0.tgz",',
      '+      "integrity": "sha512-tampered2=="',
      '     },',
      '     "node_modules/foo": {',
      '-      "version": "1.0.0",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '-      "integrity": "sha512-old1=="',
      '+      "version": "1.1.0",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.1.0.tgz",',
      '+      "integrity": "sha512-new1=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
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

  // #5837: a nested "dependencies" sub-object inside a node_modules/... entry must not permanently drop
  // tracking — resolved/integrity/version lines AFTER that sub-object must still attribute to the outer entry.
  it("still flags tampered resolved/integrity when a nested dependencies sub-object precedes those fields (#5837)", () => {
    const lockPatch = [
      '@@ -1,14 +1,14 @@',
      '     "node_modules/foo": {',
      '       "dependencies": {',
      '         "bar": {',
      '           "version": "1.0.0"',
      '         }',
      '       },',
      '-      "version": "1.0.0",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '-      "integrity": "sha512-old=="',
      '+      "version": "1.0.0",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '+      "integrity": "sha512-tampered=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("foo");
  });

  it("composes nested-dependencies tracking with full-path entry keying for two nested copies of the same package (#5837)", () => {
    const lockPatch = [
      '@@ -1,24 +1,24 @@',
      '     "node_modules/foo": {',
      '       "dependencies": {',
      '         "left-pad": {',
      '           "version": "1.0.0"',
      '         }',
      '       },',
      '       "version": "1.0.0",',
      '-      "integrity": "sha512-old1=="',
      '+      "integrity": "sha512-new1=="',
      '     },',
      '     "node_modules/bar/node_modules/foo": {',
      '       "devDependencies": {',
      '         "left-pad": {',
      '           "version": "2.0.0"',
      '         }',
      '       },',
      '       "version": "2.0.0",',
      '-      "integrity": "sha512-old2=="',
      '+      "integrity": "sha512-tampered2=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("foo");
  });

  // #7778: a resolved/integrity/version change can land in a hunk whose leading context (git's default
  // 3 lines) doesn't reach back far enough to include its entry's own opening "node_modules/<pkg>": {
  // line -- before the fix, `activeEntry`/`currentEntryKey` stayed null for the whole hunk and the
  // change was silently dropped rather than flagged.
  it("still flags a changed integrity when the entry's own header line falls outside the diff's 3-line context window (#7778)", () => {
    const lockPatch = [
      '@@ -50,10 +50,10 @@',
      '       "version": "1.0.0",',
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old=="',
      '+      "integrity": "sha512-tampered=="',
      '       "dependencies": {',
      '         "bar": "^1.0.0"',
      '       }',
      '     }',
    ].join("\n");
    // No `"node_modules/foo": {` header anywhere in this patch: it sits 4 lines above the changed
    // integrity line, one line further back than git's default 3-line context window reaches.
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.code).toBe("lockfile_tamper_risk");
    expect(finding?.title).toContain("unattributed lockfile entry");
  });

  it("does not flag an unrelated field change when no entry header is in view at all (#7778 fallback stays scoped to tracked fields)", () => {
    const lockPatch = ['@@ -50,4 +50,4 @@', '       "license": "MIT",', '-      "dev": true', '+      "dev": false', '     }'].join("\n");
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("does not flag a version-only change with no entry header in view (no resolved/integrity touched)", () => {
    const lockPatch = [
      '@@ -50,4 +50,4 @@',
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '       "license": "MIT",',
      '-      "version": "1.0.0",',
      '+      "version": "1.0.1",',
      '     }',
    ].join("\n");
    // The unattributed fallback bucket is still created (a version line is a tracked field), but since
    // resolved/integrity were never touched, resolvedOrIntegrityChanged stays false -- proves the
    // fallback bucket tracks versionChanged correctly rather than always flagging once created.
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("flags an off-registry resolved URL with no entry header in view", () => {
    const lockPatch = [
      '@@ -50,4 +50,4 @@',
      '       "license": "MIT",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '+      "resolved": "https://evil.example.com/foo-1.0.0.tgz",',
      '     }',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });

  it("does not merge an unattributed change into a later, properly-attributed entry once a real header appears (#7778)", () => {
    const lockPatch = [
      '@@ -50,13 +50,13 @@',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old-unattributed=="',
      '+      "integrity": "sha512-new-unattributed=="',
      '     },',
      '     "node_modules/bar": {',
      '-      "version": "2.0.0",',
      '-      "resolved": "https://registry.npmjs.org/bar/-/bar-2.0.0.tgz",',
      '-      "integrity": "sha512-old-bar=="',
      '+      "version": "2.1.0",',
      '+      "resolved": "https://registry.npmjs.org/bar/-/bar-2.1.0.tgz",',
      '+      "integrity": "sha512-new-bar=="',
      '     },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    // "bar" is a legitimate, fully-bumped dependency and must not be swept into the unattributed
    // bucket's tamper signal (nor let its own version bump mask the earlier unattributed one) --
    // only the truly unattributed integrity change should be flagged.
    expect(finding?.detail).toContain("unattributed lockfile entry");
    expect(finding?.detail).not.toContain("bar");
  });

  it("tracks tamper signals inside a packages root wrapper and through optionalDependencies sub-objects", () => {
    const lockPatch = [
      '@@ -1,12 +1,12 @@',
      ' "packages": {',
      '     "node_modules/lodash": {',
      '       "optionalDependencies": {',
      '         "left-pad": {',
      '           "version": "1.0.0"',
      '         }',
      '       },',
      '-      "integrity": "sha512-old=="',
      '+      "integrity": "sha512-tampered=="',
      '     }',
      ' },',
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("lodash");
  });

  // #8351: git's ~3-line context often splits a single entry's version bump and its resolved/integrity
  // change into SEPARATE hunks, each closing with a depth-0 `}`. Resetting the unattributed bucket on
  // every such brace used to mint a fresh `#unattributed-N` per hunk, so the integrity-only bucket
  // false-flagged even though the version hunk recorded a real bump for the same package.
  it("REGRESSION (#8351): does NOT flag a legitimate version+integrity bump split across two header-less hunks for the same package", () => {
    const lockPatch = [
      "@@ -50,6 +50,6 @@",
      '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '       "license": "MIT",',
      '-      "version": "4.17.20",',
      '+      "version": "4.17.21",',
      "     }",
      "@@ -60,7 +60,7 @@",
      '       "version": "4.17.21",',
      '       "license": "MIT",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz",',
      '+      "integrity": "sha512-newnewnew=="',
      "     }",
    ].join("\n");
    // No `"node_modules/lodash": {` header in either hunk — package identity comes from the registry
    // resolved URL in context / changed lines, so both hunks share one unattributed bucket.
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("REGRESSION (#8351): still flags a genuine cross-hunk tamper (integrity changed, version NOT changed) for the same header-less package", () => {
    const lockPatch = [
      "@@ -50,6 +50,6 @@",
      '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-oldoldold=="',
      '+      "integrity": "sha512-tamperedtampered=="',
      "     }",
      "@@ -70,6 +70,6 @@",
      '       "version": "4.17.20",',
      '       "license": "MIT",',
      '-      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20-mirror.tgz",',
      "     }",
    ].join("\n");
    // Integrity in hunk 1 + resolved swap in hunk 2, neither hunk bumps version — correlation must
    // still produce a single candidate with resolvedOrIntegrityChanged && !versionChanged.
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.code).toBe("lockfile_tamper_risk");
    expect(finding?.title).toContain("unattributed lockfile entry");
  });

  it("REGRESSION (#8351): two different header-less packages in one patch never share an unattributed bucket", () => {
    const lockPatch = [
      "@@ -50,6 +50,6 @@",
      '       "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old-lodash=="',
      '+      "integrity": "sha512-tampered-lodash=="',
      "     }",
      "@@ -80,6 +80,6 @@",
      '       "resolved": "https://registry.npmjs.org/express/-/express-4.18.0.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old-express=="',
      '+      "integrity": "sha512-tampered-express=="',
      "     }",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    // Both packages are independently tampered; collapsing them into one bucket would still flag, but
    // the title/detail must keep the anonymous unattributed label (not a merged bare name) and the
    // finding must fire — pinning that distinct registry URLs mint distinct correlation keys.
    expect(finding?.title).toContain("unattributed lockfile entry");
    expect(finding?.detail).toContain("unattributed lockfile entry");
  });

  it("REGRESSION (#8351): upgrades a sequence-keyed unattributed bucket when a resolved URL appears later in the same header-less block", () => {
    // No leading context resolved URL — version lines mint `#unattributed-N` first; the following
    // resolved URL recovers the package name and must re-key so a PRIOR hunk's package-keyed integrity
    // signal (and this block's version bump) still correlate into one candidate.
    const lockPatch = [
      "@@ -40,6 +40,6 @@",
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old=="',
      '+      "integrity": "sha512-new=="',
      "     }",
      "@@ -55,8 +55,8 @@",
      '-      "version": "1.0.0",',
      '+      "version": "1.0.1",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",',
      '-      "integrity": "sha512-new=="',
      '+      "integrity": "sha512-newer=="',
      "     }",
    ].join("\n");
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("REGRESSION (#8351): in-block sequence→package re-key works even with no prior package-keyed candidate", () => {
    const lockPatch = [
      "@@ -55,8 +55,8 @@",
      '-      "version": "1.0.0",',
      '+      "version": "1.0.1",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",',
      '-      "integrity": "sha512-old=="',
      '+      "integrity": "sha512-new=="',
      "     }",
    ].join("\n");
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });

  it("REGRESSION (#8351): sequence→package upgrade merges an off-registry resolved URL onto the prior package-keyed candidate", () => {
    const lockPatch = [
      "@@ -10,5 +10,5 @@",
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '       "license": "MIT",',
      '-      "version": "1.0.0",',
      '+      "version": "1.0.1",',
      "     }",
      "@@ -20,6 +20,6 @@",
      '-      "resolved": "https://evil.example.com/foo-old.tgz",',
      '+      "resolved": "https://evil.example.com/foo-new.tgz",',
      // A second resolved line (invalid JSON, but the line scanner is not a JSON parser) supplies the
      // registry URL that recovers the package name and triggers the sequence→package upgrade merge.
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      "     }",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });

  it("REGRESSION (#8351): merge keeps a prior off-registry URL when the sequence bucket has none", () => {
    // Hunk 1 records an off-registry resolved under the package key. Hunk 2 starts with a version-only
    // sequence bucket that later promotes and must NOT clear the prior off-registry URL (?? left arm).
    const lockPatch = [
      "@@ -10,6 +10,6 @@",
      '       "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '       "license": "MIT",',
      '-      "resolved": "https://evil.example.com/foo-old.tgz",',
      '+      "resolved": "https://evil.example.com/foo-new.tgz",',
      "     }",
      "@@ -30,6 +30,6 @@",
      '-      "version": "1.0.0",',
      '+      "version": "1.0.1",',
      '-      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz",',
      '+      "resolved": "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",',
      "     }",
    ].join("\n");
    const finding = lockfileTamperRiskFinding([lockfilePatch(lockPatch)]);
    expect(finding).not.toBeNull();
    expect(finding?.detail).toContain("outside registry.npmjs.org");
  });

  it("REGRESSION (#8351): correlates a scoped package across hunks via its registry resolved URL", () => {
    const lockPatch = [
      "@@ -50,6 +50,6 @@",
      '       "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz",',
      '       "license": "MIT",',
      '-      "version": "7.0.0",',
      '+      "version": "7.0.1",',
      "     }",
      "@@ -60,6 +60,6 @@",
      '       "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz",',
      '       "license": "MIT",',
      '-      "integrity": "sha512-old=="',
      '+      "integrity": "sha512-new=="',
      "     }",
    ].join("\n");
    expect(lockfileTamperRiskFinding([lockfilePatch(lockPatch)])).toBeNull();
  });
});
