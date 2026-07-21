import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #7014: these unattended, CI-workflow-driven scripts make outbound fetches with no per-request timeout, so a
// single hung connection could block the job past its intended deadline (or indefinitely). Every fetch they
// make must now carry an AbortSignal timeout. Asserted structurally because the scripts run against live
// container/GitHub endpoints that a unit test can't stand up.

it("check-mcp-release-due's githubRequest fetch carries an AbortSignal timeout", () => {
  const src = readFileSync("scripts/check-mcp-release-due.ts", "utf8");
  const fetchCount = (src.match(/\bfetch\(/g) ?? []).length;
  const timeoutCount = (src.match(/AbortSignal\.timeout\(/g) ?? []).length;
  expect(fetchCount).toBe(1);
  expect(timeoutCount).toBe(1);
});

describe("smoke-observability scripts (#7014): every generated fetch is timeout-guarded", () => {
  for (const path of ["scripts/smoke-observability-traces.mjs", "scripts/smoke-observability-metrics.mjs"]) {
    it(`${path} bounds every fetch with AbortSignal.timeout`, () => {
      const src = readFileSync(path, "utf8");
      const fetchCount = (src.match(/\bawait fetch\(/g) ?? []).length;
      const timeoutCount = (src.match(/AbortSignal\.timeout\(/g) ?? []).length;
      expect(fetchCount, `${path}: expected fetch calls`).toBeGreaterThan(0);
      // One timeout per fetch — no un-bounded outbound call is left in the generated smoke script.
      expect(timeoutCount, `${path}: every fetch guarded`).toBe(fetchCount);
    });
  }
});
