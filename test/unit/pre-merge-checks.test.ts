import { describe, expect, it } from "vitest";

import { evaluatePreMergeChecks, PRE_MERGE_CHECK_ADVISORY_CODE, PRE_MERGE_CHECK_BLOCKING_CODE } from "../../src/review/pre-merge-checks";
import type { PreMergeCheck } from "../../src/signals/focus-manifest";

const check = (over: Partial<PreMergeCheck> = {}): PreMergeCheck => ({
  name: "Check",
  whenPaths: [],
  titleContains: null,
  descriptionContains: null,
  requireLabel: null,
  enforce: false,
  ...over,
});

describe("evaluatePreMergeChecks (#review-pre-merge-checks)", () => {
  it("no findings when there are no checks (byte-identical)", () => {
    expect(evaluatePreMergeChecks([], { title: "t", body: "b", labels: [], changedPaths: [] })).toEqual([]);
  });

  it("a satisfied check (all assertions hold, case-insensitive) yields no finding", () => {
    const checks = [check({ name: "All", titleContains: "FEAT", descriptionContains: "Migration", requireLabel: "Ship" })];
    const out = evaluatePreMergeChecks(checks, { title: "feat: add", body: "includes a migration", labels: ["ship"], changedPaths: [] });
    expect(out).toEqual([]);
  });

  it("an advisory check failure → pre_merge_check_failed (warning); lists every unmet assertion", () => {
    const checks = [check({ name: "Needs all", titleContains: "feat", descriptionContains: "why", requireLabel: "ready" })];
    const out = evaluatePreMergeChecks(checks, { title: "chore: x", body: "no rationale", labels: [], changedPaths: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe(PRE_MERGE_CHECK_ADVISORY_CODE);
    expect(out[0]?.severity).toBe("warning");
    expect(out[0]?.detail).toContain('the title must contain "feat"');
    expect(out[0]?.detail).toContain('the description must contain "why"');
    expect(out[0]?.detail).toContain('the "ready" label must be applied');
  });

  it("an enforced check failure → pre_merge_check_required (critical → the gate blocks)", () => {
    const out = evaluatePreMergeChecks([check({ name: "Required", requireLabel: "approved", enforce: true })], { title: "t", body: "b", labels: ["other"], changedPaths: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe(PRE_MERGE_CHECK_BLOCKING_CODE);
    expect(out[0]?.severity).toBe("critical");
  });

  it("when_paths gates the check: skipped when no changed path matches, evaluated when one does", () => {
    const checks = [check({ name: "Migrations documented", whenPaths: ["migrations/**"], descriptionContains: "migration", enforce: true })];
    // No matching path → N/A → no finding even though the description lacks the phrase.
    expect(evaluatePreMergeChecks(checks, { title: "t", body: "no note", labels: [], changedPaths: ["src/a.ts"] })).toEqual([]);
    // A matching path → evaluated → fails.
    const out = evaluatePreMergeChecks(checks, { title: "t", body: "no note", labels: [], changedPaths: ["migrations/0099_x.sql"] });
    expect(out).toHaveLength(1);
    expect(out[0]?.code).toBe(PRE_MERGE_CHECK_BLOCKING_CODE);
  });

  it("defaults null/absent title, body, and labels to empty (no crash; the assertion simply fails)", () => {
    const out = evaluatePreMergeChecks([check({ name: "T", titleContains: "feat" })], { changedPaths: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.detail).toContain('the title must contain "feat"');
  });
});
