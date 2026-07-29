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

function steps(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return (job.steps as Array<Record<string, unknown>>) ?? [];
}

// Regression guard for #9801: codecov/patch posted a red conclusion computed from a PARTIAL report.
// notify.after_n_builds fires on the Nth upload to ARRIVE, and arrival order does not match importance --
// validate-code's rees/control-plane/engine reports land in ~2 minutes while validate-tests is still
// producing the backend lcov that covers most of src/**. Codecov's own comment printed
// `backend | BASE 1 | HEAD 0` while it was posting a failure. Because the gate closes a contributor PR on
// ANY red check, codecov/patch included, that transient red could close a PR with no defect.
//
// The fix holds all notifications (notify.manual_trigger) until the codecov-notify job releases them once
// every uploading job has finished. These assertions pin the parts that are load-bearing and silent when
// broken -- a wrong commit sha or a resurrected count would fail open, not loudly.
describe("codecov notifications wait for every upload (#9801)", () => {
  const workflow = readYaml(".github/workflows/ci.yml");
  const jobs = record(workflow.jobs, "workflow.jobs");
  const codecov = readYaml("codecov.yml");

  it("codecov.yml holds every status until the CLI releases it", () => {
    const notify = record(record(codecov.codecov, "codecov").notify, "codecov.notify");
    expect(notify.manual_trigger).toBe(true);
    // Kept deliberately so dropping manual_trigger restores the correct floor rather than the default.
    expect(notify.after_n_builds).toBe(1);
  });

  it("codecov-notify waits on every job that uploads a report", () => {
    const job = record(jobs["codecov-notify"], "jobs.codecov-notify");
    // validate-code carries rees/control-plane/engine; validate-tests carries backend. Missing either
    // reintroduces the partial-report verdict this job exists to prevent.
    expect(job.needs).toEqual(["changes", "validate-code", "validate-tests"]);
  });

  it("codecov-notify still runs when an upload job fails, but not on a superseded run", () => {
    const condition = String(record(jobs["codecov-notify"], "jobs.codecov-notify").if);
    // A failed validate-tests must still release the verdict, otherwise codecov/patch never posts at all.
    expect(condition).toContain("!cancelled()");
    // always() would notify on a sha the replacement run has already superseded.
    expect(condition).not.toContain("always()");
    // A fully path-filtered PR uploads nothing; notifying on a commit Codecov has no reports for errors.
    expect(condition).toContain("needs.validate-code.result != 'skipped'");
    expect(condition).toContain("needs.validate-tests.result != 'skipped'");
  });

  it("codecov-notify is NOT a dependency of the required validate check", () => {
    // The bug being fixed is a phantom red closing a good PR. Wiring the notifier into the required
    // check would let a Codecov delivery hiccup do exactly that.
    expect(record(jobs.validate, "jobs.validate").needs).not.toContain("codecov-notify");
  });

  it("a failed send-notifications warns instead of failing the job", () => {
    const run = String(steps(record(jobs["codecov-notify"], "jobs.codecov-notify")).at(-1)?.run ?? "");
    // The CLI exits non-zero (--fail-on-error) so a real failure is visible, and the `if !` converts it
    // to a warning. Without the guard the step would go red and re-create the false-close class.
    expect(run).toContain("--fail-on-error");
    expect(run).toContain("if ! codecovcli send-notifications");
    expect(run).toContain("::warning title=Codecov::");
  });

  it("the token flag is only added when a token exists (fork PRs run without secrets)", () => {
    const run = String(steps(record(jobs["codecov-notify"], "jobs.codecov-notify")).at(-1)?.run ?? "");
    // `[ -n "$X" ] && args+=(...)` aborts the whole step under `bash -e` when the token is empty, which
    // is exactly the fork-PR case -- it must stay an if-block.
    expect(run).toContain('if [ -n "$CODECOV_TOKEN" ]; then');
    expect(run).not.toMatch(/\[ -n "\$CODECOV_TOKEN" \] &&/);
  });

  it("codecov-notify targets the same commit the uploads used", () => {
    const notifyStep = steps(record(jobs["codecov-notify"], "jobs.codecov-notify")).at(-1);
    const sha = String(record(notifyStep?.env, "codecov-notify.env").COMMIT_SHA);
    // The uploads all pass override_commit: head sha on a PR, github.sha on push. A mismatch here points
    // the notification at a commit with no reports attached, so nothing ever posts.
    const expected = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
    expect(sha).toBe(expected);

    const uploadOverrides = steps(record(jobs["validate-tests"], "jobs.validate-tests"))
      .filter((step) => String(step.name ?? "").startsWith("Upload coverage to Codecov") && !String(step.name).includes("fork"))
      .map((step) => String(record(step.with, "step.with").override_commit));
    expect(uploadOverrides.length).toBeGreaterThan(0);
    for (const override of uploadOverrides) expect(override).toBe(expected);
  });

  it("the Codecov CLI is pinned like every other third-party dependency in the workflow", () => {
    const env = record(steps(record(jobs["codecov-notify"], "jobs.codecov-notify")).at(-1)?.env, "codecov-notify.env");
    expect(String(env.CODECOV_CLI_VERSION)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("no step in codecov-notify can turn the check red", () => {
    // The gate closes a contributor PR on ANY red check, so a failed notifier would re-create the very
    // bug it fixes. Every failure path -- install included -- has to be swallowed.
    const job = record(jobs["codecov-notify"], "jobs.codecov-notify");
    const runs = steps(job).map((step) => String(step.run ?? ""));
    expect(runs).toHaveLength(1);
    // A bare `pipx install` would fail the step (and the check) when the runner image lacks the CLI.
    expect(runs[0]).toContain("if ! pipx install");
    expect(runs[0]).toContain("exit 0");
    for (const step of steps(job)) expect(step.uses).toBeUndefined();
  });
});
