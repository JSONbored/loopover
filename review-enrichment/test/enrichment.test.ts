import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDependencyChanges,
  queryOsv,
  scanDependencies,
} from "../dist/analyzers/dependency-scan.js";
import { renderBrief } from "../dist/render.js";
import { buildBrief } from "../dist/brief.js";

const okFetch = (vulns) => async () => ({
  ok: true,
  json: async () => ({ vulns }),
});

test("extractDependencyChanges: npm change vs add, ignores removed + non-version lines", () => {
  const changes = extractDependencyChanges([
    {
      path: "package.json",
      patch: [
        '-    "lodash": "^4.17.20",',
        '+    "lodash": "^4.17.21",',
        '+    "left-pad": "1.0.0",',
        '-    "gone": "1.0.0",',
        '+    "name": "my-app",',
      ].join("\n"),
    },
  ]);
  const byPkg = Object.fromEntries(changes.map((c) => [c.package, c]));
  assert.equal(byPkg.lodash.to, "4.17.21");
  assert.equal(byPkg.lodash.from, "4.17.20");
  assert.equal(byPkg["left-pad"].to, "1.0.0");
  assert.equal(byPkg["left-pad"].from, null);
  assert.equal(byPkg.gone, undefined); // removed-only → not scanned
  assert.equal(byPkg.name, undefined); // not a version string
});

test("extractDependencyChanges: PyPI + Go ecosystems", () => {
  const changes = extractDependencyChanges([
    { path: "requirements.txt", patch: "+requests==2.31.0\n-requests==2.30.0" },
    { path: "go.mod", patch: "+\texample.com/foo v1.2.3" },
  ]);
  const eco = Object.fromEntries(changes.map((c) => [c.ecosystem, c]));
  assert.equal(eco.PyPI.to, "2.31.0");
  assert.equal(eco.Go.package, "example.com/foo");
  assert.equal(eco.Go.to, "1.2.3");
});

test("queryOsv: maps vulns; severity from database_specific; fixedIn from affected; [] on non-ok", async () => {
  const cves = await queryOsv(
    "npm",
    "lodash",
    "4.17.20",
    okFetch([
      {
        id: "GHSA-x",
        summary: "Prototype pollution",
        database_specific: { severity: "HIGH" },
        affected: [
          { ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] },
        ],
      },
    ]),
  );
  assert.equal(cves.length, 1);
  assert.equal(cves[0].severity, "high");
  assert.equal(cves[0].fixedIn, "4.17.21");
  const none = await queryOsv("npm", "x", "1", async () => ({
    ok: false,
    json: async () => ({}),
  }));
  assert.deepEqual(none, []);
});

test("queryOsv: CVSS numeric score bucketed when no database_specific", async () => {
  const cves = await queryOsv(
    "npm",
    "x",
    "1",
    okFetch([{ id: "Y", severity: [{ type: "CVSS_V3", score: "9.8" }] }]),
  );
  assert.equal(cves[0].severity, "critical");
});

test("scanDependencies: only deps with vulns are returned", async () => {
  const findings = await scanDependencies(
    {
      repoFullName: "o/r",
      prNumber: 1,
      files: [{ path: "package.json", patch: '+    "lodash": "4.17.20",' }],
    },
    okFetch([{ id: "GHSA-x", database_specific: { severity: "CRITICAL" } }]),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].direction, "add");
  assert.equal(findings[0].cves[0].severity, "critical");
});

test("renderBrief: sorts by severity, empty when no findings", () => {
  const empty = renderBrief({});
  assert.equal(empty.promptSection, "");
  const rendered = renderBrief({
    dependency: [
      {
        ecosystem: "npm",
        package: "a",
        from: null,
        to: "1",
        direction: "add",
        cves: [{ id: "LOW-1", severity: "low", summary: "x", fixedIn: null }],
      },
      {
        ecosystem: "npm",
        package: "b",
        from: null,
        to: "2",
        direction: "add",
        cves: [
          { id: "CRIT-1", severity: "critical", summary: "y", fixedIn: "3" },
        ],
      },
    ],
  });
  assert.match(rendered.promptSection, /EXTERNAL REVIEW BRIEF/);
  assert.ok(
    rendered.promptSection.indexOf("CRIT-1") <
      rendered.promptSection.indexOf("LOW-1"),
    "critical before low",
  );
  assert.match(rendered.systemSuffix, /verified ground truth/);
});

test("buildBrief: runs dependency analyzer, marks others skipped, partial=false on success", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = okFetch([
    { id: "GHSA-z", database_specific: { severity: "HIGH" } },
  ]);
  try {
    const brief = await buildBrief({
      repoFullName: "o/r",
      prNumber: 7,
      headSha: "abc",
      files: [{ path: "package.json", patch: '+    "lodash": "4.17.20",' }],
    });
    assert.equal(brief.schemaVersion, 1);
    assert.equal(brief.partial, false);
    assert.equal(brief.analyzerStatus.dependency, "ok");
    assert.equal(brief.findings.dependency.length, 1);
    assert.match(brief.promptSection, /GHSA-z/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("buildBrief: analyzer throw → degraded + partial, still returns a brief", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const brief = await buildBrief({
      repoFullName: "o/r",
      prNumber: 8,
      files: [{ path: "package.json", patch: '+    "lodash": "4.17.20",' }],
    });
    assert.equal(brief.partial, true);
    assert.equal(brief.analyzerStatus.dependency, "degraded");
    assert.equal(brief.promptSection, "");
  } finally {
    globalThis.fetch = realFetch;
  }
});
