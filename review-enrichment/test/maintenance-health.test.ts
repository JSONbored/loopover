import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchNpmSignals,
  fetchPypiSignals,
  scanMaintenanceHealth,
} from "../dist/analyzers/maintenance-health.js";
import { renderBrief } from "../dist/render.js";

const NOW = new Date("2026-06-29T00:00:00.000Z").getTime();

const npmPatch = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "package.json", patch: `+    "${name}": "${version}",` }],
});

const pypiPatch = (name, version = "1.0.0") => ({
  repoFullName: "o/r",
  prNumber: 1,
  files: [{ path: "requirements.txt", patch: `+${name}==${version}` }],
});

const okJson =
  (body) =>
  async () => ({
    ok: true,
    json: async () => body,
  });

test("fetchNpmSignals reads deprecation, release date, and maintainer count", async () => {
  const signals = await fetchNpmSignals(
    "left-pad",
    "1.0.0",
    okJson({
      versions: { "1.0.0": { deprecated: "Use pad-left instead" } },
      time: { "1.0.0": "2021-01-01T00:00:00.000Z" },
      maintainers: [{ name: "one" }],
    }),
  );
  assert.equal(signals?.deprecatedMessage, "Use pad-left instead");
  assert.equal(signals?.lastReleaseDate, "2021-01-01T00:00:00.000Z");
  assert.equal(signals?.maintainers, 1);
});

test("fetchPypiSignals reads yanked releases and maintainer hints", async () => {
  const signals = await fetchPypiSignals(
    "demo",
    "2.0.0",
    okJson({
      info: { maintainer: "alice", deprecated: "Project retired" },
      releases: {
        "2.0.0": [
          {
            upload_time_iso_8601: "2020-02-02T00:00:00.000Z",
            yanked: true,
          },
        ],
      },
    }),
  );
  assert.equal(signals?.deprecatedMessage, "Project retired");
  assert.equal(signals?.yanked, true);
  assert.equal(signals?.lastReleaseDate, "2020-02-02T00:00:00.000Z");
  assert.equal(signals?.maintainers, 1);
});

test("scanMaintenanceHealth flags npm dependency risks with low-noise reasons", async () => {
  const findings = await scanMaintenanceHealth(
    npmPatch("legacy-lib"),
    okJson({
      versions: { "1.0.0": { deprecated: "No longer maintained" } },
      time: { "1.0.0": "2021-01-01T00:00:00.000Z" },
      maintainers: [{ name: "solo" }],
    }),
    { now: NOW },
  );
  assert.deepEqual(findings, [
    {
      ecosystem: "npm",
      package: "legacy-lib",
      version: "1.0.0",
      reasons: ["deprecated", "stale-release", "sole-maintainer"],
      deprecatedMessage: "No longer maintained",
      lastReleaseDate: "2021-01-01T00:00:00.000Z",
      maintainers: 1,
    },
  ]);
});

test("scanMaintenanceHealth flags yanked PyPI releases", async () => {
  const findings = await scanMaintenanceHealth(
    pypiPatch("legacy-lib", "2.0.0"),
    okJson({
      info: { maintainer: "alice" },
      releases: {
        "2.0.0": [
          {
            upload_time_iso_8601: "2020-02-02T00:00:00.000Z",
            yanked: true,
          },
        ],
      },
    }),
    { now: NOW },
  );
  assert.deepEqual(findings[0]?.reasons, [
    "yanked",
    "stale-release",
    "sole-maintainer",
  ]);
});

test("scanMaintenanceHealth skips healthy packages and unsupported ecosystems", async () => {
  const findings = await scanMaintenanceHealth(
    {
      repoFullName: "o/r",
      prNumber: 1,
      files: [
        { path: "package.json", patch: '+    "healthy": "1.0.0",' },
        { path: "go.mod", patch: "+example.com/healthy v1.2.3" },
      ],
    },
    okJson({
      versions: { "1.0.0": {} },
      time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
      maintainers: [{}, {}],
    }),
    { now: NOW },
  );
  assert.deepEqual(findings, []);
});

test("scanMaintenanceHealth fails safe on fetch errors", async () => {
  const findings = await scanMaintenanceHealth(
    npmPatch("broken"),
    async () => {
      throw new Error("network down");
    },
    { now: NOW },
  );
  assert.deepEqual(findings, []);
});

test("renderBrief emits a public-safe maintenance-health block", () => {
  const { promptSection } = renderBrief({
    maintenanceHealth: [
      {
        ecosystem: "npm",
        package: "legacy-lib",
        version: "1.0.0",
        reasons: ["deprecated", "stale-release", "sole-maintainer"],
        deprecatedMessage: "No longer maintained",
        lastReleaseDate: "2021-01-01T00:00:00.000Z",
        maintainers: 1,
      },
    ],
  });
  assert.match(promptSection, /Dependency maintenance-health risks/);
  assert.match(promptSection, /legacy-lib@1.0.0/);
  assert.match(promptSection, /deprecated/);
  assert.match(promptSection, /single-maintainer package/);
  assert.match(promptSection, /2021\\-01\\-01/);
});
