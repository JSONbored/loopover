// Units for the deprecated/unmaintained-dependency analyzer (#1511). Own file (not enrichment.test.ts) so concurrent
// analyzer PRs do not collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanDeprecatedDependencies,
  normalizeName,
} from "../dist/analyzers/deprecated-dep.js";
import { renderBrief } from "../dist/render.js";

// A package.json patch that ADDS each [name, version] as a new dependency line inside the dependencies block.
const npmAdd = (deps) =>
  `@@ -1,3 +1,${3 + deps.length} @@\n   "dependencies": {\n${deps
    .map(([n, v]) => `+    "${n}": "^${v}",`)
    .join("\n")}\n   }`;

// A package.json patch that UPGRADES one dependency from -> to.
const npmChange = (name, from, to) =>
  `@@ -1,3 +1,3 @@\n   "dependencies": {\n-    "${name}": "^${from}",\n+    "${name}": "^${to}",\n   }`;

const pkg = (patch) => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch }],
});

test("normalizeName: npm case-folds; PyPI applies PEP 503 separator collapse", () => {
  assert.equal(normalizeName("npm", "Node-SASS"), "node-sass");
  assert.equal(normalizeName("PyPI", "Nose"), "nose");
  assert.equal(normalizeName("PyPI", "Foo_Bar.Baz"), "foo-bar-baz");
  assert.equal(normalizeName("npm", "Foo_Bar.Baz"), "foo_bar.baz");
});

test("scanDeprecatedDependencies: flags a newly-added deprecated npm dependency with its successor", async () => {
  const findings = await scanDeprecatedDependencies(pkg(npmAdd([["request", "2.88.2"]])));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "request");
  assert.equal(findings[0].ecosystem, "npm");
  assert.equal(findings[0].version, "2.88.2");
  assert.equal(findings[0].direction, "add");
  assert.equal(findings[0].replacement, "got or axios");
  assert.match(findings[0].reason, /deprecated/);
});

test("scanDeprecatedDependencies: reports an upgrade of a still-deprecated package as direction 'change'", async () => {
  const findings = await scanDeprecatedDependencies(pkg(npmChange("request", "2.88.0", "2.88.2")));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].direction, "change");
  assert.equal(findings[0].version, "2.88.2");
});

test("scanDeprecatedDependencies: ignores a maintained dependency", async () => {
  const findings = await scanDeprecatedDependencies(pkg(npmAdd([["axios", "1.7.0"]])));
  assert.deepEqual(findings, []);
});

test("scanDeprecatedDependencies: matches a PyPI package case-insensitively via normalization", async () => {
  const findings = await scanDeprecatedDependencies({
    repoFullName: "o/r",
    prNumber: 1,
    files: [{ path: "requirements.txt", patch: "@@ -1 +1,2 @@\n+Nose==1.3.7\n+BeautifulSoup==3.2.2" }],
  });
  const names = findings.map((f) => f.package).sort();
  assert.deepEqual(names, ["BeautifulSoup", "Nose"]);
  const nose = findings.find((f) => f.package === "Nose");
  assert.equal(nose.ecosystem, "PyPI");
  assert.equal(nose.replacement, "pytest or nose2");
});

test("scanDeprecatedDependencies: flags a package retired without a standard successor (null replacement)", async () => {
  const findings = await scanDeprecatedDependencies(pkg(npmAdd([["gulp-util", "3.0.8"]])));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].package, "gulp-util");
  assert.equal(findings[0].replacement, null);
});

test("scanDeprecatedDependencies: fail-safe on no files and on an already-aborted signal", async () => {
  assert.deepEqual(await scanDeprecatedDependencies({ repoFullName: "o/r", prNumber: 1 }), []);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await scanDeprecatedDependencies(pkg(npmAdd([["request", "2.88.2"]])), controller.signal),
    [],
  );
});

test("renderBrief: renders deprecatedDep findings with and without a replacement", () => {
  const { promptSection } = renderBrief({
    deprecatedDep: [
      {
        ecosystem: "npm",
        package: "request",
        version: "2.88.2",
        direction: "add",
        replacement: "got or axios",
        reason: "deprecated — no longer maintained since 2020",
      },
      {
        ecosystem: "npm",
        package: "gulp-util",
        version: "3.0.8",
        direction: "add",
        replacement: null,
        reason: "deprecated — the bundled utility set was unpublished",
      },
    ],
  });
  assert.match(promptSection, /Deprecated or unmaintained dependencies/);
  assert.match(promptSection, /request@2\.88\.2/);
  assert.match(promptSection, /consider .*got or axios/);
  assert.match(promptSection, /gulp-util@3\.0\.8/);
});

test("renderBrief: emits nothing for an empty deprecatedDep list", () => {
  const { promptSection } = renderBrief({ deprecatedDep: [] });
  assert.doesNotMatch(promptSection, /Deprecated or unmaintained/);
});
