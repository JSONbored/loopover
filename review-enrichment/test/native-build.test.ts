// Units for the native-build / install-cost analyzer (#1512). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  npmNativeBuild,
  pypiSdistOnly,
  scanNativeBuild,
} from "../dist/analyzers/native-build.js";
import { renderBrief } from "../dist/render.js";

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
const jsonResponse = (body, init) => new Response(JSON.stringify(body), init);
const npmFetch = (meta) => async () => jsonResponse({ versions: { "1.0.0": meta } });
const pypiFetch = (urls) => async () => jsonResponse({ urls });
const status = (code) => async () => jsonResponse({}, { status: code });
const throwingFetch = async () => {
  throw new Error("network down");
};

test("npmNativeBuild: gypfile compiles without a prebuilt fallback", () => {
  const hit = npmNativeBuild({ gypfile: true });
  assert.equal(hit?.prebuiltFallback, false);
  assert.match(hit.reason, /compiles a native addon/);
});

test("npmNativeBuild: install script running node-gyp flags a compile", () => {
  assert.ok(npmNativeBuild({ scripts: { install: "node-gyp rebuild" } }));
  assert.ok(npmNativeBuild({ scripts: { postinstall: "cmake-js compile" } }));
});

test("npmNativeBuild: a prebuilt-binary path is reported as a fallback compile", () => {
  const viaBinary = npmNativeBuild({ gypfile: true, binary: { module_name: "x" } });
  assert.equal(viaBinary?.prebuiltFallback, true);
  assert.match(viaBinary.reason, /prebuilt/);
  const viaScript = npmNativeBuild({ scripts: { install: "node-pre-gyp install --fallback-to-build" } });
  assert.equal(viaScript?.prebuiltFallback, true);
});

test("npmNativeBuild: a pure-JS package is not flagged", () => {
  assert.equal(npmNativeBuild({ scripts: { build: "tsc", postinstall: "echo hi" } }), null);
  assert.equal(npmNativeBuild({}), null);
});

test("pypiSdistOnly: true only when an sdist exists and no wheel does", () => {
  assert.equal(pypiSdistOnly([{ packagetype: "sdist" }]), true);
  assert.equal(pypiSdistOnly([{ packagetype: "sdist" }, { packagetype: "bdist_wheel" }]), false);
  assert.equal(pypiSdistOnly([{ packagetype: "bdist_wheel" }]), false); // wheel present
  assert.equal(pypiSdistOnly([{ packagetype: "bdist_egg" }]), false); // no sdist → not "sdist-only"
  assert.equal(pypiSdistOnly([]), false); // undeterminable → no finding
});

test("scanNativeBuild: npm gypfile dependency is flagged native-addon", async () => {
  const findings = await scanNativeBuild(npmAdd("bcrypt"), npmFetch({ gypfile: true }));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "native-addon");
  assert.equal(findings[0].package, "bcrypt");
  assert.equal(findings[0].prebuiltFallback, false);
});

test("scanNativeBuild: a pure-JS npm dependency is not flagged", async () => {
  assert.deepEqual(await scanNativeBuild(npmAdd("lodash"), npmFetch({ scripts: { build: "tsc" } })), []);
});

test("scanNativeBuild: PyPI sdist-only release is flagged", async () => {
  const findings = await scanNativeBuild(pypiAdd("ujson"), pypiFetch([{ packagetype: "sdist" }]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sdist-only");
  assert.match(findings[0].reason, /compiles from source/);
});

test("scanNativeBuild: a PyPI release with a wheel is not flagged", async () => {
  assert.deepEqual(
    await scanNativeBuild(pypiAdd("requests"), pypiFetch([{ packagetype: "bdist_wheel" }])),
    [],
  );
});

test("scanNativeBuild: unsupported ecosystems and invalid names/versions are never queried", async () => {
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,1 @@\n+require example.com/x v1.0.0` }, // Go — unsupported
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "BadCaps": "^1.0.0"` }, // invalid npm name
    ],
  };
  let called = false;
  const out = await scanNativeBuild(req, async () => {
    called = true;
    return status(200)();
  });
  assert.deepEqual(out, []);
  assert.equal(called, false); // nothing queryable → no registry call
});

test("scanNativeBuild: the query cap counts only queryable changes (skips don't starve a later native dep)", async () => {
  // 25 unsupported Go changes precede one native npm dep; with filter-before-cap the npm dep is still queried.
  const goLines = Array.from({ length: 25 }, (_, i) => `+require example.com/m${i} v1.0.0`).join("\n");
  const req = {
    repoFullName: "o/r",
    prNumber: 1,
    files: [
      { path: "go.mod", patch: `@@ -1,0 +1,25 @@\n${goLines}` },
      { path: "package.json", patch: `@@ -1,0 +1,1 @@\n+  "bcrypt": "^1.0.0"` },
    ],
  };
  const findings = await scanNativeBuild(req, npmFetch({ gypfile: true }), { limits: { maxQueries: 25 } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "bcrypt");
});

test("scanNativeBuild: a PyPI PEP 440 (non-semver) sdist-only version is flagged", async () => {
  const findings = await scanNativeBuild(pypiAdd("ujson", "24.1"), pypiFetch([{ packagetype: "sdist" }]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "sdist-only");
  assert.equal(findings[0].version, "24.1");
});

test("scanNativeBuild fails safe on a non-ok or throwing fetch", async () => {
  assert.deepEqual(await scanNativeBuild(npmAdd("bcrypt"), status(404)), []);
  assert.deepEqual(await scanNativeBuild(npmAdd("bcrypt"), throwingFetch), []);
});

test("scanNativeBuild fails safe before parsing registry JSON with an oversized Content-Length", async () => {
  let bodyRead = false;
  const findings = await scanNativeBuild(npmAdd("bcrypt"), async () => ({
    ok: true,
    headers: new Headers({ "content-length": String(2 * 1024 * 1024 + 1) }),
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
  }));

  assert.deepEqual(findings, []);
  assert.equal(bodyRead, false);
});

test("scanNativeBuild fails safe when streamed registry JSON exceeds the byte cap", async () => {
  const bigMetadata = `${" ".repeat(2 * 1024 * 1024)}{"versions":{"1.0.0":{"gypfile":true}}}`;
  const findings = await scanNativeBuild(npmAdd("bcrypt"), async () => new Response(bigMetadata));

  assert.deepEqual(findings, []);
});

test("scanNativeBuild stops on an already-aborted signal", async () => {
  const findings = await scanNativeBuild(npmAdd("bcrypt"), npmFetch({ gypfile: true }), {
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe native-build block", () => {
  const { promptSection } = renderBrief({
    nativeBuild: [
      { ecosystem: "npm", package: "bcrypt", version: "5.1.0", kind: "native-addon", prebuiltFallback: false, reason: "compiles a native addon (node-gyp) on install — cold-CI build cost and a cross-platform breakage source" },
      { ecosystem: "PyPI", package: "ujson", version: "5.0.0", kind: "sdist-only", reason: "no prebuilt wheel for this version — pip compiles from source (sdist) on install" },
    ],
  });
  assert.match(promptSection, /Native-build \/ install-cost dependencies/);
  assert.match(promptSection, /bcrypt@5\.1\.0/);
  assert.match(promptSection, /ujson@5\.0\.0/);
});
