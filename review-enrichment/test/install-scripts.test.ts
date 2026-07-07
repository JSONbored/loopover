// Units for the install-script analyzer. Kept separate so analyzer PRs do not collide in one shared test file.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scanInstallScripts } from "../dist/analyzers/install-scripts.js";

const npmAdd = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "${name}": "^${version}"` }],
});

const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);

test("scanInstallScripts fetches exact npm version metadata, not the full packument", async () => {
  const urls = [];
  const findings = await scanInstallScripts(npmAdd("bcrypt"), async (url) => {
    urls.push(String(url));
    return jsonResponse({
      scripts: {
        install: "node-gyp rebuild",
        postinstall: "node ./postinstall.js",
      },
      time: "2026-06-30T00:00:00.000Z",
    });
  });

  assert.deepEqual(urls, ["https://registry.npmjs.org/bcrypt/1.0.0"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "bcrypt");
  assert.deepEqual(findings[0].hooks, ["install", "postinstall"]);
  assert.equal(findings[0].publishedAt, "2026-06-30T00:00:00.000Z");
});

test("scanInstallScripts still accepts legacy packument-shaped test fixtures", async () => {
  const findings = await scanInstallScripts(npmAdd("legacy"), async () =>
    jsonResponse({
      versions: {
        "1.0.0": { scripts: { preinstall: "node ./setup.js" } },
      },
      time: { "1.0.0": "2026-06-29T00:00:00.000Z" },
    }),
  );

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].hooks, ["preinstall"]);
  assert.equal(findings[0].publishedAt, "2026-06-29T00:00:00.000Z");
});

test("scanInstallScripts uses exact version metadata when custom versions field is present", async () => {
  const findings = await scanInstallScripts(npmAdd("malicious"), async () =>
    jsonResponse({
      version: "1.0.0",
      scripts: { postinstall: "node ./postinstall.js" },
      time: "2026-06-30T00:00:00.000Z",
      versions: { "1.0.0": {} },
    }),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "malicious");
  assert.deepEqual(findings[0].hooks, ["postinstall"]);
  assert.equal(findings[0].publishedAt, "2026-06-30T00:00:00.000Z");
});

test("scanInstallScripts ignores custom versions field on exact metadata without packument markers", async () => {
  const findings = await scanInstallScripts(npmAdd("pure-js"), async () =>
    jsonResponse({
      versions: {
        "1.0.0": { scripts: { postinstall: "node ./nested.js" } },
      },
    }),
  );

  assert.deepEqual(findings, []);
});

test("scanInstallScripts treats version-identifying exact metadata as top-level despite packument-looking fields", async () => {
  const findings = await scanInstallScripts(npmAdd("pure-js"), async () =>
    jsonResponse({
      version: "1.0.0",
      versions: {
        "1.0.0": { scripts: { postinstall: "node ./nested.js" } },
      },
      time: { "1.0.0": "2026-06-30T00:00:00.000Z" },
      "dist-tags": { latest: "1.0.0" },
    }),
  );

  assert.deepEqual(findings, []);
});

test("scanInstallScripts reports capped npm metadata for manual lifecycle review", async () => {
  const findings = await scanInstallScripts(npmAdd("evilpkg"), undefined, {
    analysis: {
      fetchJson: async () => ({
        ok: false,
        reason: "response_too_large",
        bytes: null,
        elapsedMs: 5,
        endpointCategory: "npm-version",
        capped: true,
      }),
    },
  });

  assert.deepEqual(findings, [
    {
      package: "evilpkg",
      version: "1.0.0",
      hooks: [],
      publishedAt: null,
      metadataCapped: true,
    },
  ]);
});

test("scanInstallScripts keeps non-size registry failures silent", async () => {
  const findings = await scanInstallScripts(npmAdd("missingpkg"), undefined, {
    analysis: {
      fetchJson: async () => ({
        ok: false,
        reason: "http_error",
        status: 404,
        bytes: null,
        elapsedMs: 5,
        endpointCategory: "npm-version",
      }),
    },
  });

  assert.deepEqual(findings, []);
});
