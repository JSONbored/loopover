import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard (#1943 gate review finding): the self-hosting troubleshooting runbooks reference exact
// Prometheus metric names and alert names. If a metric is ever renamed/removed in src/, or an alert is
// renamed/removed in prometheus/rules/alerts.yml, this test fails instead of the docs silently going stale
// — mirrors the same source-of-truth-diff approach as scripts/check-openapi-settings-parity.ts (#2556).

const DOC_PATH = "apps/loopover-ui/content/docs/self-hosting-troubleshooting.mdx";
const doc = readFileSync(DOC_PATH, "utf8");

// The exact source files that emit every loopover_*_total metric referenced in the runbooks, per an
// audit against the real incr()/gauge()/observe() call sites (src/selfhost/metrics.ts's API).
const METRIC_SOURCE_FILES = [
  "src/github/client.ts",
  "src/github/graphql-cache.ts",
  "src/selfhost/queue-common.ts",
  "src/selfhost/sqlite-queue.ts",
  "src/selfhost/pg-queue.ts",
  "src/selfhost/qdrant-vectorize.ts",
  "src/selfhost/orb-collector.ts",
  "src/selfhost/monitored-work.ts",
  "src/selfhost/ai.ts",
];
const metricSource = METRIC_SOURCE_FILES.map((path) => readFileSync(path, "utf8")).join("\n");
const alertsSource = readFileSync("prometheus/rules/alerts.yml", "utf8");

describe("self-hosting-troubleshooting doc: metric/alert names match source (#1943)", () => {
  it("every loopover_..._total metric name referenced in the doc is actually emitted by the code", () => {
    const names = [...new Set([...doc.matchAll(/loopover_[a-z0-9_]+_total/g)].map((m) => m[0]))];
    expect(names.length).toBeGreaterThan(5); // sanity: the extraction found the runbooks' real content
    const missing = names.filter((name) => !metricSource.includes(name));
    expect(missing).toEqual([]);
  });

  it("every LoopoverXxx alert name referenced in the doc exists in prometheus/rules/alerts.yml", () => {
    const names = [...new Set([...doc.matchAll(/Loopover[A-Za-z]+/g)].map((m) => m[0]))];
    expect(names.length).toBeGreaterThan(2);
    const missing = names.filter((name) => !alertsSource.includes(`alert: ${name}`));
    expect(missing).toEqual([]);
  });
});
