// Units for the OSV severity label mapping shared by the dependency-scan and lockfile-drift analyzers.
// Own file so concurrent analyzer PRs don't collide. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import { queryOsvBatch as queryOsvBatchDependency } from "../dist/analyzers/dependency-scan.js";
import { queryOsvBatch as queryOsvBatchLockfile } from "../dist/analyzers/lockfile-drift.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// GHSA — the dominant OSV source for npm/PyPI — labels medium advisories with GitHub's word "MODERATE",
// and puts a CVSS *vector string* (not a number) in `severity[].score`. Both analyzers must map MODERATE
// to "medium"; without it the vector-string CVSS fallback yields NaN and the advisory is mislabeled
// "unknown" (and sorted to the bottom). The fix is identical in both, so assert the same contract on each.
for (const [name, queryOsvBatch] of [
  ["dependency-scan", queryOsvBatchDependency],
  ["lockfile-drift", queryOsvBatchLockfile],
] as const) {
  test(`${name} severity: maps a GHSA MODERATE advisory to "medium", not "unknown"`, async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-p6mc-m468-83gw",
                summary: "moderate-severity advisory",
                database_specific: { severity: "MODERATE" },
                severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:L/A:L" }],
              },
            ],
          },
        ],
      })) as unknown as typeof fetch;

    const result = await queryOsvBatch(
      [{ ecosystem: "npm", package: "lodash", from: null, to: "4.17.20" }],
      fetchImpl,
    );
    const cves = [...result.values()][0] ?? [];
    assert.equal(cves.length, 1);
    assert.equal(cves[0]?.severity, "medium");
  });
}
