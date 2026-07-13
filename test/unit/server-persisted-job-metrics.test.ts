import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

// Regression for #2508: loopover_jobs_deferred_total was registered as a persisted gauge in server.ts
// but no queue driver ever called recordQueueMetric with that name -- dead instrumentation that always
// reported 0. Pin the invariant the fix establishes: every metric name in server.ts's persisted-gauge list
// must have a real recordQueueMetric call site in BOTH queue drivers, so a future dead entry can't sneak
// back in the same way. Source-text assertions, not a runtime harness: server.ts has no test harness
// (it's Codecov-ignored) and this is a static wiring invariant, not runtime behavior.
describe("server.ts persisted job-queue metrics (#2508)", () => {
  it("registers only metric names both sqlite-queue.ts and pg-queue.ts actually record", () => {
    const server = read("src/server.ts");
    const sqliteQueue = read("src/selfhost/sqlite-queue.ts");
    const pgQueue = read("src/selfhost/pg-queue.ts");

    const listMatch = server.match(
      /const durableJobMetric[\s\S]*?for \(const name of \[([\s\S]*?)\]\) \{/,
    );
    expect(listMatch, "persisted-gauge metric list not found in server.ts").not.toBeNull();
    const registered = [...listMatch![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(registered.length).toBeGreaterThan(0);

    for (const name of registered) {
      const callSite = `recordQueueMetric(driver, "${name}"`;
      expect(sqliteQueue.includes(callSite), `sqlite-queue.ts never calls recordQueueMetric for "${name}"`).toBe(true);
      expect(pgQueue.includes(`recordQueueMetric("${name}"`), `pg-queue.ts never calls recordQueueMetric for "${name}"`).toBe(true);
    }

    expect(registered).not.toContain("loopover_jobs_deferred_total");
  });
});
