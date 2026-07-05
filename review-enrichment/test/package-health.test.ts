// Units for the package maintenance-health analyzer (#1511). Own file to avoid shared analyzer-test collisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNpmPackageHealth,
  classifyPypiPackageHealth,
  scanPackageHealth,
} from "../dist/analyzers/package-health.js";
import { buildBrief } from "../dist/brief.js";
import { renderBrief } from "../dist/render.js";

const NOW = Date.parse("2026-07-05T00:00:00.000Z");

const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);

const npmAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [
    {
      path: "package.json",
      patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"`,
    },
  ],
});

const npmChange = (name, from = "0.9.0", to = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [
    {
      path: "package.json",
      patch: `@@ -1,1 +1,1 @@\n-  "${name}": "^${from}"\n+  "${name}": "^${to}"`,
    },
  ],
});

const pypiAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [
    {
      path: "requirements.txt",
      patch: `@@ -1,0 +1,1 @@\n+${name}==${version}`,
    },
  ],
});

const pypiChange = (name, from = "0.9.0", to = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [
    {
      path: "requirements.txt",
      patch: `@@ -1,1 +1,1 @@\n-${name}==${from}\n+${name}==${to}`,
    },
  ],
});

const npmPackument = (overrides = {}) => ({
  versions: { "1.0.0": {} },
  time: {
    created: "2020-01-01T00:00:00.000Z",
    modified: "2026-07-01T00:00:00.000Z",
    "1.0.0": "2026-07-01T00:00:00.000Z",
  },
  maintainers: [{ name: "a" }, { name: "b" }],
  ...overrides,
});

const pypiProject = (overrides = {}) => ({
  info: { version: "1.0.0" },
  releases: {
    "1.0.0": [{ upload_time_iso: "2026-07-01T00:00:00.000Z" }],
  },
  ...overrides,
});

function sequenceFetch(...bodies) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const body = bodies.shift();
    if (body instanceof Response) return body;
    return jsonResponse(body ?? {});
  };
  fetchImpl.urls = urls;
  return fetchImpl;
}

test("classifyNpmPackageHealth: reports deprecated version metadata", () => {
  const signals = classifyNpmPackageHealth(
    "old-lib",
    "1.0.0",
    npmPackument({ versions: { "1.0.0": { deprecated: "Use new-lib instead.\nPlease migrate." } } }),
    null,
    NOW,
  );

  assert.deepEqual(signals.map((signal) => signal.kind), ["deprecated"]);
  assert.equal(signals[0].details, "Use new-lib instead. Please migrate.");
});

test("classifyNpmPackageHealth: boolean deprecation still reports a useful detail", () => {
  const signals = classifyNpmPackageHealth(
    "old-lib",
    "1.0.0",
    npmPackument({ versions: { "1.0.0": { deprecated: true } } }),
    null,
    NOW,
  );

  assert.deepEqual(signals, [{ kind: "deprecated", details: "version is deprecated" }]);
});

test("classifyNpmPackageHealth: ignores deprecation for a different version", () => {
  const signals = classifyNpmPackageHealth(
    "old-lib",
    "1.0.0",
    npmPackument({ versions: { "2.0.0": { deprecated: "old" } } }),
    null,
    NOW,
  );

  assert.deepEqual(signals, []);
});

test("classifyNpmPackageHealth: reports stale latest release using package time map", () => {
  const signals = classifyNpmPackageHealth(
    "quiet-lib",
    "1.0.0",
    npmPackument({
      time: {
        created: "2018-01-01T00:00:00.000Z",
        modified: "2026-07-01T00:00:00.000Z",
        "1.0.0": "2021-01-01T00:00:00.000Z",
      },
    }),
    null,
    NOW,
  );

  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "stale-release");
  assert.equal(signals[0].lastReleaseAt, "2021-01-01T00:00:00.000Z");
  assert.match(signals[0].details, /days old/);
});

test("classifyNpmPackageHealth: ignores created and modified timestamps for stale release", () => {
  const signals = classifyNpmPackageHealth(
    "quiet-lib",
    "1.0.0",
    npmPackument({
      time: {
        created: "2018-01-01T00:00:00.000Z",
        modified: "2026-07-01T00:00:00.000Z",
      },
    }),
    null,
    NOW,
  );

  assert.deepEqual(signals, []);
});

test("classifyNpmPackageHealth: respects the stale-days threshold", () => {
  assert.deepEqual(
    classifyNpmPackageHealth(
      "active-lib",
      "1.0.0",
      npmPackument({ time: { "1.0.0": "2025-12-01T00:00:00.000Z" } }),
      null,
      NOW,
      730,
    ),
    [],
  );
  assert.equal(
    classifyNpmPackageHealth(
      "active-lib",
      "1.0.0",
      npmPackument({ time: { "1.0.0": "2025-12-01T00:00:00.000Z" } }),
      null,
      NOW,
      30,
    )[0].kind,
    "stale-release",
  );
});

test("classifyNpmPackageHealth: reports sole maintainer from npm maintainers", () => {
  const signals = classifyNpmPackageHealth(
    "single-lib",
    "1.0.0",
    npmPackument({ maintainers: [{ name: "solo" }] }),
    null,
    NOW,
  );

  assert.deepEqual(signals, [
    {
      kind: "sole-maintainer",
      maintainerCount: 1,
      details: "package metadata lists a single maintainer",
    },
  ]);
});

test("classifyNpmPackageHealth: falls back to npm users count when maintainers are absent", () => {
  const signals = classifyNpmPackageHealth(
    "single-lib",
    "1.0.0",
    npmPackument({ maintainers: undefined, users: { alice: true } }),
    null,
    NOW,
  );

  assert.equal(signals[0].kind, "sole-maintainer");
  assert.equal(signals[0].maintainerCount, 1);
});

test("classifyNpmPackageHealth: ecosyste.ms maintainer count overrides npm packument count", () => {
  const signals = classifyNpmPackageHealth(
    "single-lib",
    "1.0.0",
    npmPackument({ maintainers: [{ name: "a" }, { name: "b" }] }),
    { maintainers_count: 1 },
    NOW,
  );

  assert.equal(signals[0].kind, "sole-maintainer");
});

test("classifyNpmPackageHealth: reports archived packages from package or repository metadata", () => {
  assert.equal(
    classifyNpmPackageHealth("archived-lib", "1.0.0", npmPackument(), { archived: true }, NOW)[0].kind,
    "archived",
  );
  assert.equal(
    classifyNpmPackageHealth("archived-lib", "1.0.0", npmPackument(), { repository: { archived: true } }, NOW)[0]
      .kind,
    "archived",
  );
  assert.equal(
    classifyNpmPackageHealth("archived-lib", "1.0.0", npmPackument(), { status: "archived" }, NOW)[0].kind,
    "archived",
  );
  assert.equal(
    classifyNpmPackageHealth(
      "archived-lib",
      "1.0.0",
      npmPackument(),
      { repository: { status: "archived" } },
      NOW,
    )[0].kind,
    "archived",
  );
});

test("classifyNpmPackageHealth: can return several independent signals in stable order", () => {
  const signals = classifyNpmPackageHealth(
    "risky-lib",
    "1.0.0",
    npmPackument({
      versions: { "1.0.0": { deprecated: "deprecated" } },
      time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
      maintainers: [{ name: "solo" }],
    }),
    { archived: true },
    NOW,
  );

  assert.deepEqual(signals.map((signal) => signal.kind), [
    "deprecated",
    "stale-release",
    "sole-maintainer",
    "archived",
  ]);
});

test("classifyPypiPackageHealth: reports yanked releases from release-file metadata", () => {
  const signals = classifyPypiPackageHealth(
    "badpkg",
    "1.0.0",
    pypiProject({
      releases: {
        "1.0.0": [{ upload_time_iso: "2026-01-01T00:00:00.000Z", yanked: true, yanked_reason: "bad wheel" }],
      },
    }),
    null,
    NOW,
  );

  assert.deepEqual(signals, [{ kind: "yanked", details: "bad wheel" }]);
});

test("classifyPypiPackageHealth: reports yanked releases from info metadata", () => {
  const signals = classifyPypiPackageHealth(
    "badpkg",
    "1.0.0",
    pypiProject({ info: { version: "1.0.0", yanked: true, yanked_reason: "removed" } }),
    null,
    NOW,
  );

  assert.deepEqual(signals, [{ kind: "yanked", details: "removed" }]);
});

test("classifyPypiPackageHealth: ignores info.yanked for a different version", () => {
  const signals = classifyPypiPackageHealth(
    "badpkg",
    "1.0.0",
    pypiProject({ info: { version: "2.0.0", yanked: true, yanked_reason: "removed" } }),
    null,
    NOW,
  );

  assert.deepEqual(signals, []);
});

test("classifyPypiPackageHealth: reports stale latest release from release uploads", () => {
  const signals = classifyPypiPackageHealth(
    "quietpkg",
    "1.0.0",
    pypiProject({
      releases: {
        "0.9.0": [{ upload_time: "2019-01-01T00:00:00" }],
        "1.0.0": [{ upload_time_iso: "2020-01-01T00:00:00.000Z" }],
      },
    }),
    null,
    NOW,
  );

  assert.equal(signals[0].kind, "stale-release");
  assert.equal(signals[0].lastReleaseAt, "2020-01-01T00:00:00.000Z");
});

test("classifyPypiPackageHealth: ignores malformed release dates", () => {
  const signals = classifyPypiPackageHealth(
    "quietpkg",
    "1.0.0",
    pypiProject({ releases: { "1.0.0": [{ upload_time_iso: "not-a-date" }] } }),
    null,
    NOW,
  );

  assert.deepEqual(signals, []);
});

test("classifyPypiPackageHealth: reports ecosyste.ms archive and sole-maintainer signals", () => {
  const signals = classifyPypiPackageHealth(
    "quietpkg",
    "1.0.0",
    pypiProject(),
    { repository: { archived: true }, maintainers_count: 1 },
    NOW,
  );

  assert.deepEqual(signals.map((signal) => signal.kind), ["sole-maintainer", "archived"]);
});

test("scanPackageHealth: npm deprecated dependency is fetched and reported", async () => {
  const fetchImpl = sequenceFetch(
    {},
    npmPackument({ versions: { "1.0.0": { deprecated: "Use maintained-lib" } } }),
  );
  const findings = await scanPackageHealth(npmAdd("old-lib"), fetchImpl, { now: NOW });

  assert.deepEqual(fetchImpl.urls, [
    "https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/old-lib",
    "https://registry.npmjs.org/old-lib",
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ecosystem, "npm");
  assert.equal(findings[0].package, "old-lib");
  assert.equal(findings[0].version, "1.0.0");
  assert.equal(findings[0].direction, "add");
  assert.equal(findings[0].kind, "deprecated");
});

test("scanPackageHealth: npm upgraded dependency carries from/to direction", async () => {
  const findings = await scanPackageHealth(
    npmChange("old-lib", "0.9.0", "1.0.0"),
    sequenceFetch({}, npmPackument({ versions: { "1.0.0": { deprecated: "old" } } })),
    { now: NOW },
  );

  assert.equal(findings[0].from, "0.9.0");
  assert.equal(findings[0].direction, "change");
});

test("scanPackageHealth: scoped npm names are URL-encoded once", async () => {
  const fetchImpl = sequenceFetch({}, npmPackument({ versions: { "1.0.0": { deprecated: "old" } } }));
  await scanPackageHealth(npmAdd("@scope/pkg"), fetchImpl, { now: NOW });

  assert.deepEqual(fetchImpl.urls, [
    "https://packages.ecosyste.ms/api/v1/registries/npmjs.org/packages/%40scope%2Fpkg",
    "https://registry.npmjs.org/%40scope%2Fpkg",
  ]);
});

test("scanPackageHealth: PyPI yanked dependency is fetched and reported", async () => {
  const fetchImpl = sequenceFetch(
    {},
    pypiProject({
      releases: {
        "1.0.0": [{ upload_time_iso: "2026-01-01T00:00:00.000Z", yanked: true }],
      },
    }),
  );
  const findings = await scanPackageHealth(pypiAdd("badpkg"), fetchImpl, { now: NOW });

  assert.deepEqual(fetchImpl.urls, [
    "https://packages.ecosyste.ms/api/v1/registries/pypi.org/packages/badpkg",
    "https://pypi.org/pypi/badpkg/json",
  ]);
  assert.equal(findings[0].ecosystem, "PyPI");
  assert.equal(findings[0].kind, "yanked");
});

test("scanPackageHealth: PyPI upgraded dependency carries from/to direction", async () => {
  const findings = await scanPackageHealth(
    pypiChange("badpkg", "0.9.0", "1.0.0"),
    sequenceFetch({}, pypiProject({ info: { version: "1.0.0", yanked: true } })),
    { now: NOW },
  );

  assert.equal(findings[0].from, "0.9.0");
  assert.equal(findings[0].direction, "change");
});

test("scanPackageHealth: ecosyste.ms failures do not hide registry findings", async () => {
  const findings = await scanPackageHealth(
    npmAdd("old-lib"),
    sequenceFetch(jsonResponse({}, { status: 503 }), npmPackument({ versions: { "1.0.0": { deprecated: "old" } } })),
    { now: NOW },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "deprecated");
});

test("scanPackageHealth: registry failures still allow ecosyste.ms findings", async () => {
  const findings = await scanPackageHealth(
    npmAdd("archived-lib"),
    sequenceFetch({ archived: true }, jsonResponse({}, { status: 404 })),
    { now: NOW },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "archived");
});

test("scanPackageHealth: unsupported ecosystems and invalid names are never queried", async () => {
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: "@@ -1,0 +1,1 @@\n+require example.com/x v1.0.0" },
      { path: "package.json", patch: '@@ -1,0 +1,1 @@\n+  "BadCaps": "^1.0.0"' },
      { path: "requirements.txt", patch: "@@ -1,0 +1,1 @@\n+bad/pkg==1.0.0" },
    ],
  };
  let called = false;
  const findings = await scanPackageHealth(req, async () => {
    called = true;
    return jsonResponse({});
  });

  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test("scanPackageHealth: query cap counts only queryable dependencies", async () => {
  const goLines = Array.from({ length: 20 }, (_, index) => `+require example.com/m${index} v1.0.0`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,20 @@\n${goLines}` },
      { path: "package.json", patch: '@@ -1,0 +1,1 @@\n+  "old-lib": "^1.0.0"' },
    ],
  };
  const findings = await scanPackageHealth(
    req,
    sequenceFetch({}, npmPackument({ versions: { "1.0.0": { deprecated: "old" } } })),
    { now: NOW, limits: { maxQueries: 1 } },
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "old-lib");
});

test("scanPackageHealth: finding cap truncates multi-signal output", async () => {
  const findings = await scanPackageHealth(
    npmAdd("risky-lib"),
    sequenceFetch(
      { archived: true, maintainers_count: 1 },
      npmPackument({
        versions: { "1.0.0": { deprecated: "old" } },
        time: { "1.0.0": "2020-01-01T00:00:00.000Z" },
      }),
    ),
    { now: NOW, limits: { maxFindings: 2 } },
  );

  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((finding) => finding.kind), ["deprecated", "stale-release"]);
});

test("scanPackageHealth: maxQueries limits network fanout", async () => {
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "package.json", patch: '@@ -1,0 +1,2 @@\n+  "first-lib": "^1.0.0"\n+  "second-lib": "^1.0.0"' },
    ],
  };
  const fetchImpl = sequenceFetch({}, npmPackument({ versions: { "1.0.0": { deprecated: "old" } } }));
  await scanPackageHealth(req, fetchImpl, { now: NOW, limits: { maxQueries: 1 } });

  assert.equal(fetchImpl.urls.length, 2);
  assert.match(fetchImpl.urls[0], /first-lib/);
});

test("scanPackageHealth: already-aborted signal stops before network work", async () => {
  let called = false;
  const findings = await scanPackageHealth(
    npmAdd("old-lib"),
    async () => {
      called = true;
      return jsonResponse({});
    },
    { signal: AbortSignal.abort(), now: NOW },
  );

  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test("scanPackageHealth: aborting after the first dependency stops later dependencies", async () => {
  const controller = new AbortController();
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "package.json", patch: '@@ -1,0 +1,2 @@\n+  "first-lib": "^1.0.0"\n+  "second-lib": "^1.0.0"' },
    ],
  };
  const fetchImpl = async (url) => {
    if (String(url).includes("first-lib")) controller.abort();
    return jsonResponse({});
  };

  await scanPackageHealth(req, fetchImpl, { signal: controller.signal, now: NOW });
  assert.equal(controller.signal.aborted, true);
});

test("scanPackageHealth: non-ok and throwing fetches fail safe", async () => {
  assert.deepEqual(
    await scanPackageHealth(npmAdd("old-lib"), async () => jsonResponse({}, { status: 500 }), { now: NOW }),
    [],
  );
  assert.deepEqual(
    await scanPackageHealth(
      npmAdd("old-lib"),
      async () => {
        throw new Error("network down");
      },
      { now: NOW },
    ),
    [],
  );
});

test("scanPackageHealth: oversized Content-Length fails safe before reading a body", async () => {
  let bodyRead = false;
  const findings = await scanPackageHealth(
    npmAdd("old-lib"),
    async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(3 * 1024 * 1024) }),
      body: {
        getReader() {
          bodyRead = true;
          throw new Error("body should not be read");
        },
      },
      arrayBuffer: async () => {
        bodyRead = true;
        return new ArrayBuffer(0);
      },
    }),
    { now: NOW },
  );

  assert.deepEqual(findings, []);
  assert.equal(bodyRead, false);
});

test("scanPackageHealth: streamed JSON over the byte cap fails safe", async () => {
  const big = `${" ".repeat(3 * 1024 * 1024)}{"versions":{"1.0.0":{"deprecated":"old"}}}`;
  const findings = await scanPackageHealth(npmAdd("old-lib"), async () => new Response(big), { now: NOW });

  assert.deepEqual(findings, []);
});

test("scanPackageHealth: analysis fetch context is used when provided", async () => {
  const urls = [];
  const analysis = {
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes("ecosyste.ms")) return { ok: true, data: {} };
      return {
        ok: true,
        data: npmPackument({ versions: { "1.0.0": { deprecated: "old" } } }),
      };
    },
  };
  const findings = await scanPackageHealth(
    npmAdd("old-lib"),
    async () => {
      throw new Error("direct fetch should not be used");
    },
    { analysis, now: NOW },
  );

  assert.equal(findings.length, 1);
  assert.equal(urls.length, 2);
});

test("scanPackageHealth: explicit analyzer request participates in buildBrief", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("ecosyste.ms")) return jsonResponse({});
    return jsonResponse(npmPackument({ versions: { "1.0.0": { deprecated: "old" } } }));
  };
  try {
    const brief = await buildBrief({
      repoFullName: "o/r",
      prNumber: 1,
      analyzers: ["packageHealth"],
      files: npmAdd("old-lib").files,
    });

    assert.equal(brief.partial, false);
    assert.equal(brief.analyzerStatus.packageHealth, "ok");
    assert.equal(brief.findings.packageHealth?.[0]?.kind, "deprecated");
    assert.match(brief.promptSection, /Package maintenance-health signals/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("renderBrief: package-health output is public-safe and compact", () => {
  const { promptSection } = renderBrief({
    packageHealth: [
      {
        ecosystem: "npm",
        package: "old-lib",
        version: "1.0.0",
        from: null,
        direction: "add",
        kind: "deprecated",
        details: "Use maintained-lib instead",
      },
      {
        ecosystem: "PyPI",
        package: "badpkg",
        version: "2.0.0",
        from: "1.0.0",
        direction: "change",
        kind: "yanked",
        details: "bad release",
      },
    ],
  });

  assert.match(promptSection, /Package maintenance-health signals/);
  assert.match(promptSection, /old-lib@1\.0\.0/);
  assert.match(promptSection, /badpkg@2\.0\.0/);
  assert.match(promptSection, /from 1\.0\.0/);
  assert.doesNotMatch(promptSection, /package\.json/);
  assert.doesNotMatch(promptSection, /requirements\.txt/);
});

test("renderBrief: renderer escapes package names and detail text", () => {
  const { promptSection } = renderBrief({
    packageHealth: [
      {
        ecosystem: "npm",
        package: "evil`pkg",
        version: "1.0.0",
        from: null,
        direction: "add",
        kind: "deprecated",
        details: "line one\nline two",
      },
    ],
  });

  assert.match(promptSection, /evil.pkg@1\.0\.0/);
  assert.doesNotMatch(promptSection, /evil`pkg/);
  assert.match(promptSection, /line one line two/);
});
