// Units for the maintenance-health / deprecated-dep analyzer (#1511). Own file (not enrichment.test.ts) so
// concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newestNpmPublishMs,
  newestPypiUploadMs,
  npmHealth,
  pypiHealth,
  scanDepMaintenanceHealth,
} from "../dist/analyzers/dep-maintenance-health.js";
import { renderBrief } from "../dist/render.js";

const NOW = Date.parse("2026-06-29T00:00:00Z");
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const STALE_MS = 2 * YEAR_MS;
const iso = (ms) => new Date(ms).toISOString();

// A package.json diff that ADDS one dependency (a single `+` line → from === null).
const npmAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"` }],
});
const pypiAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "requirements.txt", patch: `@@ -1,0 +1,1 @@\n+${name}==${version}` }],
});
const npmFetch = (packument) => async () => ({ ok: true, json: async () => packument });
const pypiFetch = (data) => async () => ({ ok: true, json: async () => data });
const status = (code) => async () => ({ ok: code >= 200 && code < 300, status: code, json: async () => ({}) });
const throwingFetch = async () => {
  throw new Error("network down");
};
// A fresh npm `time` map whose newest publish is `recent` — used as the healthy/non-stale baseline.
const freshNpmTime = { "1.0.0": iso(NOW - 30 * 24 * 60 * 60 * 1000) };
const freshPypiReleases = { "1.0.0": [{ upload_time_iso_8601: iso(NOW - 30 * 24 * 60 * 60 * 1000) }] };

test("npmHealth: a non-empty deprecated STRING is flagged deprecated with its reason", () => {
  const hit = npmHealth({ deprecated: "use foo instead", time: freshNpmTime }, STALE_MS, NOW);
  assert.equal(hit?.kind, "deprecated");
  assert.match(hit.reason, /use foo instead/);
});

test("npmHealth: deprecated false/boolean/empty/whitespace is NOT a deprecation (fail safe)", () => {
  assert.equal(npmHealth({ deprecated: false, time: freshNpmTime }, STALE_MS, NOW), null);
  assert.equal(npmHealth({ deprecated: true, time: freshNpmTime }, STALE_MS, NOW), null);
  assert.equal(npmHealth({ deprecated: "", time: freshNpmTime }, STALE_MS, NOW), null);
  assert.equal(npmHealth({ deprecated: "   ", time: freshNpmTime }, STALE_MS, NOW), null);
});

test("npmHealth: a package with no release in >2y is flagged stale", () => {
  const hit = npmHealth({ time: { "1.0.0": iso(NOW - 3 * YEAR_MS) } }, STALE_MS, NOW);
  assert.equal(hit?.kind, "stale");
  assert.match(hit.reason, /no release in ~3y/);
});

test("npmHealth: a recently-published healthy package yields no finding", () => {
  assert.equal(npmHealth({ time: freshNpmTime }, STALE_MS, NOW), null);
});

test("npmHealth: missing time / no parseable date fails safe (no stale finding)", () => {
  assert.equal(npmHealth({}, STALE_MS, NOW), null);
  assert.equal(npmHealth({ time: { "1.0.0": "not-a-date" } }, STALE_MS, NOW), null);
});

test("newestNpmPublishMs: ignores created/modified and unparseable timestamps", () => {
  const ms = newestNpmPublishMs({
    created: iso(NOW),
    modified: iso(NOW),
    "1.0.0": iso(NOW - 5 * YEAR_MS),
    "1.1.0": "garbage",
    "2.0.0": iso(NOW - 3 * YEAR_MS),
  });
  assert.equal(ms, NOW - 3 * YEAR_MS); // newest real publish, not the created/modified pseudo-entries
});

test("pypiHealth: a yanked version is flagged with its reason", () => {
  const hit = pypiHealth(
    { info: { yanked: true, yanked_reason: "security issue" }, releases: freshPypiReleases },
    STALE_MS,
    NOW,
  );
  assert.equal(hit?.kind, "yanked");
  assert.match(hit.reason, /security issue/);
});

test("pypiHealth: a yanked version with no/null reason still flags (no reason appended)", () => {
  const hit = pypiHealth({ info: { yanked: true, yanked_reason: null }, releases: freshPypiReleases }, STALE_MS, NOW);
  assert.equal(hit?.kind, "yanked");
  assert.match(hit.reason, /release yanked from PyPI$/);
});

test("pypiHealth: yanked false / no info is not flagged yanked", () => {
  assert.equal(pypiHealth({ info: { yanked: false }, releases: freshPypiReleases }, STALE_MS, NOW), null);
  assert.equal(pypiHealth({ releases: freshPypiReleases }, STALE_MS, NOW), null);
});

test("pypiHealth: no upload in >2y is flagged stale; falls back to upload_time", () => {
  const hit = pypiHealth({ releases: { "1.0.0": [{ upload_time: iso(NOW - 4 * YEAR_MS) }] } }, STALE_MS, NOW);
  assert.equal(hit?.kind, "stale");
  assert.match(hit.reason, /no release in ~4y/);
});

test("pypiHealth: missing releases / unparseable upload date fails safe", () => {
  assert.equal(pypiHealth({}, STALE_MS, NOW), null);
  assert.equal(pypiHealth({ releases: { "1.0.0": [{ upload_time_iso_8601: "nope" }] } }, STALE_MS, NOW), null);
});

test("newestPypiUploadMs: handles missing/empty file lists and picks the newest", () => {
  assert.equal(newestPypiUploadMs(undefined), null);
  assert.equal(newestPypiUploadMs({ "1.0.0": [] }), null);
  const ms = newestPypiUploadMs({
    "1.0.0": [{ upload_time_iso_8601: iso(NOW - 5 * YEAR_MS) }],
    "2.0.0": [{ upload_time_iso_8601: iso(NOW - 1 * YEAR_MS) }],
  });
  assert.equal(ms, NOW - 1 * YEAR_MS);
});

test("scanDepMaintenanceHealth: npm deprecated dependency is flagged", async () => {
  const findings = await scanDepMaintenanceHealth(
    npmAdd("request"),
    npmFetch({ deprecated: "no longer supported", time: freshNpmTime }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "deprecated");
  assert.equal(findings[0].package, "request");
  assert.equal(findings[0].version, "1.0.0");
});

test("scanDepMaintenanceHealth: PyPI yanked release is flagged", async () => {
  const findings = await scanDepMaintenanceHealth(
    pypiAdd("badpkg"),
    pypiFetch({ info: { yanked: true, yanked_reason: "broken" }, releases: freshPypiReleases }),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "yanked");
  assert.equal(findings[0].ecosystem, "PyPI");
});

test("scanDepMaintenanceHealth: a healthy, recently-released dependency is not flagged", async () => {
  assert.deepEqual(
    await scanDepMaintenanceHealth(npmAdd("lodash"), npmFetch({ time: freshNpmTime })),
    [],
  );
  assert.deepEqual(
    await scanDepMaintenanceHealth(pypiAdd("requests"), pypiFetch({ info: { yanked: false }, releases: freshPypiReleases })),
    [],
  );
});

test("scanDepMaintenanceHealth: a scoped npm name is URL-encoded and still queryable", async () => {
  let requested = "";
  const findings = await scanDepMaintenanceHealth(npmAdd("@scope/pkg"), async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ deprecated: "gone", time: freshNpmTime }) };
  });
  assert.equal(findings.length, 1);
  assert.match(requested, /%40scope%2Fpkg/); // encodeURIComponent applied to the scoped name
});

test("scanDepMaintenanceHealth: malformed package names and unsupported ecosystems are never queried", async () => {
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,1 @@\n+require example.com/x v1.0.0` }, // Go — unsupported
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "BadCaps": "^1.0.0"` }, // invalid npm name
    ],
  };
  let called = false;
  const out = await scanDepMaintenanceHealth(req, async () => {
    called = true;
    return status(200)();
  });
  assert.deepEqual(out, []);
  assert.equal(called, false); // nothing queryable → no registry call
});

test("scanDepMaintenanceHealth: only DIRECT added/upgraded deps are scanned (an upgrade is queried)", async () => {
  const upgrade = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      {
        path: "package.json",
        patch: `@@ -1,1 +1,1 @@\n-  "request": "^1.0.0"\n+  "request": "^2.0.0"`,
      },
    ],
  };
  let requestedVersion = "";
  const findings = await scanDepMaintenanceHealth(upgrade, async () => ({
    ok: true,
    json: async () => ({ deprecated: "use a maintained fork", time: freshNpmTime }),
  }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].version, "2.0.0"); // the upgraded-to version is reported
  void requestedVersion;
});

test("scanDepMaintenanceHealth: the query cap counts only queryable changes (skips don't starve a real dep)", async () => {
  const goLines = Array.from({ length: 25 }, (_, i) => `+require example.com/m${i} v1.0.0`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,25 @@\n${goLines}` },
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "request": "^1.0.0"` },
    ],
  };
  const findings = await scanDepMaintenanceHealth(
    req,
    npmFetch({ deprecated: "gone", time: freshNpmTime }),
    { limits: { maxQueries: 25 } },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "request");
});

test("scanDepMaintenanceHealth: the query cap bounds total fetches", async () => {
  const lines = Array.from({ length: 5 }, (_, i) => `+  "pkg${i}": "^1.0.0"`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "package.json", patch: `@@ -1,0 +1,5 @@\n${lines}` }],
  };
  let calls = 0;
  await scanDepMaintenanceHealth(
    req,
    async () => {
      calls += 1;
      return { ok: true, json: async () => ({ time: freshNpmTime }) };
    },
    { limits: { maxQueries: 2 } },
  );
  assert.equal(calls, 2); // capped at maxQueries even though 5 deps were added
});

test("scanDepMaintenanceHealth fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), status(404)), []);
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), throwingFetch), []);
});

test("scanDepMaintenanceHealth fails safe on malformed registry JSON", async () => {
  const malformed = async () => ({ ok: true, json: async () => ({ unexpected: "shape" }) });
  assert.deepEqual(await scanDepMaintenanceHealth(npmAdd("request"), malformed), []);
  assert.deepEqual(await scanDepMaintenanceHealth(pypiAdd("requests"), malformed), []);
});

test("scanDepMaintenanceHealth stops on an already-aborted signal", async () => {
  const findings = await scanDepMaintenanceHealth(npmAdd("request"), npmFetch({ deprecated: "gone", time: freshNpmTime }), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe deprecated/stale block and escapes registry-supplied reasons", () => {
  const { promptSection } = renderBrief({
    depMaintenanceHealth: [
      { ecosystem: "npm", package: "request", version: "2.88.2", kind: "deprecated", reason: "deprecated by maintainer — use `axios`*injected*" },
      { ecosystem: "PyPI", package: "oldpkg", version: "0.1.0", kind: "stale", reason: "no release in ~5y (last upload 2020-01-01)" },
    ],
  });
  assert.match(promptSection, /Deprecated \/ stale dependencies/);
  assert.match(promptSection, /request@2\.88\.2/);
  assert.match(promptSection, /oldpkg@0\.1\.0/);
  assert.doesNotMatch(promptSection, /\*injected\*/); // markdown metacharacters from registry text are escaped
});
