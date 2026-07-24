import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readYaml(path: string): Record<string, unknown> {
  return record(parse(readFileSync(path, "utf8")), path);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

// Regression guard: draft PRs were consuming the exact same heavy GitHub-hosted-runner fan-out as ready
// PRs (validate-code, the full-suite validate-tests coverage run), which both
// (a) let contributors farm bot labels/AI review/screenshots for free while sitting in draft, and (b)
// materially worsened the account's shared-runner queue contention for every other PR in flight. The heavy
// jobs now require the PR not be a draft; the cheap `changes` and `validate` (result-aggregation) jobs still
// run unconditionally since `validate` already treats a skipped dependency as success.
describe("ci.yml skips the heavy jobs for draft pull requests", () => {
  const workflow = readYaml(".github/workflows/ci.yml");
  const jobs = record(workflow.jobs, "workflow.jobs");

  it("pull_request trigger explicitly includes ready_for_review (the default type list omits it)", () => {
    const on = record(workflow.on, "workflow.on");
    const pullRequest = record(on.pull_request, "workflow.on.pull_request");
    expect(pullRequest.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  });

  it.each(["validate-code", "validate-tests"])(
    "%s's if-condition requires github.event.pull_request.draft != true alongside the existing push/path-filter checks",
    (jobName) => {
      const job = record(jobs[jobName], `jobs.${jobName}`);
      const condition = String(job.if);
      expect(condition).toContain("github.event.pull_request.draft != true");
      // Push runs (no PR context at all) must still be unaffected -- github.event_name == 'push' short-circuits first.
      expect(condition).toContain("github.event_name == 'push'");
    },
  );

  it("the dependency-review step (folded into changes, 2026-07-24) skips draft PRs and push runs", () => {
    const job = record(jobs.changes, "jobs.changes");
    const steps = (job.steps as Array<Record<string, unknown>>).filter((s) => s.name === "Dependency review");
    expect(steps).toHaveLength(1);
    expect(String(steps[0]?.if)).toBe("${{ github.event_name == 'pull_request' && github.event.pull_request.draft != true }}");
    expect(String((steps[0]?.uses as string) ?? "")).toContain("actions/dependency-review-action@");
    // The standalone job must stay gone -- a resurrected `security` job would silently double the check.
    expect(jobs.security).toBeUndefined();
  });

  it("validate still aggregates the gated jobs and treats a skipped dependency as success", () => {
    const job = record(jobs.validate, "jobs.validate");
    expect(job.needs).toEqual(["changes", "validate-code", "validate-tests"]);
    expect(String(job.if)).toBe("${{ always() }}");
  });
});
