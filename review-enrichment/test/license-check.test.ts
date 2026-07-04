// Units for the license-check analyzer (#1475/#2114). Runs against compiled dist/ and stubs deps.dev.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanLicenses } from "../dist/analyzers/license-check.js";

const npmAdd = (name, version = "1.0.0") => ({
  path: "package.json",
  patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"`,
});

const pypiAdd = (name, version = "1.0.0") => ({
  path: "requirements.txt",
  patch: `@@ -1,0 +1,1 @@\n+${name}==${version}`,
});

const goAdd = (name, version = "1.0.0") => ({
  path: "go.mod",
  patch: `@@ -1,0 +1,1 @@\n+require ${name} v${version}`,
});

const req = (files) => ({
  repoFullName: "o/r",
  prNumber: 1,
  files,
});

const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);

test("scanLicenses flags copyleft and unknown licenses while ignoring permissive licenses", async () => {
  const responses = new Map([
    ["permissive-lib", ["MIT", "Apache-2.0"]],
    ["copyleft-lib", ["GPL-3.0-only"]],
    ["unknown-lib", ["NOASSERTION"]],
    ["@scope/encoded", ["BSD-3-Clause"]],
  ]);
  const urls = [];

  const findings = await scanLicenses(
    req([
      npmAdd("permissive-lib"),
      npmAdd("copyleft-lib"),
      npmAdd("unknown-lib"),
      npmAdd("@scope/encoded", "2.0.0"),
    ]),
    async (url) => {
      urls.push(String(url));
      const match = /\/packages\/([^/]+)\/versions\//.exec(String(url));
      const packageName = decodeURIComponent(match?.[1] ?? "");
      return jsonResponse({ licenses: responses.get(packageName) ?? [] });
    },
  );

  assert.deepEqual(urls, [
    "https://api.deps.dev/v3/systems/npm/packages/permissive-lib/versions/1.0.0",
    "https://api.deps.dev/v3/systems/npm/packages/copyleft-lib/versions/1.0.0",
    "https://api.deps.dev/v3/systems/npm/packages/unknown-lib/versions/1.0.0",
    "https://api.deps.dev/v3/systems/npm/packages/%40scope%2Fencoded/versions/2.0.0",
  ]);
  assert.deepEqual(findings, [
    {
      ecosystem: "npm",
      package: "copyleft-lib",
      version: "1.0.0",
      licenses: ["GPL-3.0-only"],
      classification: "copyleft",
    },
    {
      ecosystem: "npm",
      package: "unknown-lib",
      version: "1.0.0",
      licenses: ["NOASSERTION"],
      classification: "unknown",
    },
  ]);
});

test("scanLicenses flags GFDL/CC-BY-SA/QPL/Sleepycat copyleft families but not permissive CC-BY", async () => {
  const responses = new Map([
    ["gfdl-lib", ["GFDL-1.3-or-later"]],
    ["ccbysa-lib", ["CC-BY-SA-4.0"]],
    ["qpl-lib", ["QPL-1.0"]],
    ["sleepycat-lib", ["Sleepycat"]],
    ["ccby-lib", ["CC-BY-4.0"]], // attribution-only, NOT ShareAlike → permissive, must stay unflagged
  ]);

  const findings = await scanLicenses(
    req([npmAdd("gfdl-lib"), npmAdd("ccbysa-lib"), npmAdd("qpl-lib"), npmAdd("sleepycat-lib"), npmAdd("ccby-lib")]),
    async (url) => {
      const match = /\/packages\/([^/]+)\/versions\//.exec(String(url));
      return jsonResponse({ licenses: responses.get(decodeURIComponent(match?.[1] ?? "")) ?? [] });
    },
  );

  assert.deepEqual(
    findings.map((finding) => [finding.package, finding.classification]),
    [
      ["gfdl-lib", "copyleft"],
      ["ccbysa-lib", "copyleft"],
      ["qpl-lib", "copyleft"],
      ["sleepycat-lib", "copyleft"],
    ],
  );
  assert.ok(!findings.some((finding) => finding.package === "ccby-lib"));
});

test("scanLicenses treats an empty or absent license list as unknown", async () => {
  const findings = await scanLicenses(
    req([npmAdd("mystery-lib"), npmAdd("empty-license-lib")]),
    async (url) =>
      jsonResponse(
        String(url).includes("empty-license-lib") ? { licenses: [] } : {},
      ),
  );

  assert.deepEqual(findings, [
    {
      ecosystem: "npm",
      package: "mystery-lib",
      version: "1.0.0",
      licenses: [],
      classification: "unknown",
    },
    {
      ecosystem: "npm",
      package: "empty-license-lib",
      version: "1.0.0",
      licenses: [],
      classification: "unknown",
    },
  ]);
});

test("scanLicenses resolves PyPI and Go systems and flags only the copyleft result", async () => {
  const urls = [];
  const findings = await scanLicenses(
    req([pypiAdd("django", "5.0.1"), goAdd("github.com/acme/lib", "1.2.3")]),
    async (url) => {
      urls.push(String(url));
      if (String(url).includes("/systems/pypi/")) {
        return jsonResponse({ licenses: ["LGPL-3.0-or-later"] });
      }
      return jsonResponse({ licenses: ["BSD-3-Clause"] });
    },
  );

  assert.deepEqual(urls, [
    "https://api.deps.dev/v3/systems/pypi/packages/django/versions/5.0.1",
    "https://api.deps.dev/v3/systems/go/packages/github.com%2Facme%2Flib/versions/1.2.3",
  ]);
  assert.deepEqual(findings, [
    {
      ecosystem: "PyPI",
      package: "django",
      version: "5.0.1",
      licenses: ["LGPL-3.0-or-later"],
      classification: "copyleft",
    },
  ]);
});

test("scanLicenses does not fetch or flag when no dependency version changed", async () => {
  let called = false;
  const findings = await scanLicenses(
    req([
      {
        path: "package.json",
        patch:
          '@@ -1,1 +1,1 @@\n-  "same-lib": "^1.0.0"\n+  "same-lib": "^1.0.0"',
      },
      {
        path: "package.json",
        patch: '@@ -1,1 +0,0 @@\n-  "removed-lib": "^1.0.0"',
      },
      {
        path: "README.md",
        patch: "@@ -1,0 +1,1 @@\n+not a manifest",
      },
      {
        path: "package.json",
        patch: '@@ -1,0 +1,1 @@\n+  "workspace-lib": "workspace:*"',
      },
    ]),
    async () => {
      called = true;
      return jsonResponse({ licenses: ["GPL-3.0-only"] });
    },
  );

  assert.deepEqual(findings, []);
  assert.equal(called, false);
});

test("scanLicenses fails safe when deps.dev cannot resolve a package", async () => {
  const findings = await scanLicenses(
    req([npmAdd("network-flake")]),
    async () => jsonResponse({ error: "temporary" }, { status: 503 }),
  );

  assert.deepEqual(findings, []);

  const thrown = await scanLicenses(req([npmAdd("throws")]), async () => {
    throw new Error("network down");
  });

  assert.deepEqual(thrown, []);
});
