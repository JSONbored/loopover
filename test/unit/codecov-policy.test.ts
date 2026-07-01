import { readFileSync } from "node:fs";
import { parse } from "yaml";

function readYaml(path: string): Record<string, unknown> {
  return record(parse(readFileSync(path, "utf8")), path);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function nestedRecord(source: Record<string, unknown>, path: string[]): Record<string, unknown> {
  return path.reduce((current, key) => record(current[key], path.join(".")), source);
}

describe("Codecov policy", () => {
  it("keeps patch coverage strict and PR-scoped", () => {
    const config = readYaml("codecov.yml");
    const patch = nestedRecord(config, ["coverage", "status", "patch", "default"]);
    const project = nestedRecord(config, ["coverage", "status", "project", "default"]);

    expect(patch.target).toBe("99%");
    expect(patch.threshold).toBe("0%");
    expect(patch.if_ci_failed).toBe("error");
    expect(patch.only_pulls).toBe(true);
    expect(project.informational).toBe(true);
  });

  it("fails closed when the backend coverage report is missing or cannot upload", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const stepNames = steps.map((step) => step.name);
    const verifyIndex = stepNames.indexOf("Verify coverage report exists");
    const coverageUploadIndex = stepNames.indexOf("Upload coverage to Codecov");
    const testResultsUploadIndex = stepNames.indexOf("Upload Vitest results to Codecov");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(coverageUploadIndex).toBeGreaterThan(verifyIndex);
    expect(testResultsUploadIndex).toBeGreaterThan(coverageUploadIndex);

    const verifyStep = steps[verifyIndex]!;
    const coverageUpload = steps[coverageUploadIndex]!;
    const testResultsUpload = steps[testResultsUploadIndex]!;

    // Verify must run whenever coverage was generated at all (push or backend==true) -- it deliberately
    // does NOT exclude forks, since both the trusted and the tokenless fork upload path below it need
    // the report to exist first.
    expect(String(verifyStep.if)).toBe("${{ success() && (github.event_name == 'push' || needs.changes.outputs.backend == 'true') }}");
    expect(String(coverageUpload.if)).toContain(String(verifyStep.if).replace(/^\$\{\{\s*|\s*\}\}$/g, ""));
    expect(String(verifyStep.run)).toContain("coverage/lcov.info is missing or empty");
    expect(String(verifyStep.run)).toContain("exit 1");

    const coverageUploadWith = record(coverageUpload.with, "coverage upload with");
    expect(coverageUploadWith.files).toBe("./coverage/lcov.info");
    expect(coverageUploadWith.disable_search).toBe(true);
    expect(coverageUploadWith.fail_ci_if_error).toBe(true);

    const testResultsUploadWith = record(testResultsUpload.with, "test results upload with");
    expect(testResultsUploadWith.report_type).toBe("test_results");
    expect(testResultsUploadWith.disable_search).toBe(true);
    expect(testResultsUploadWith.fail_ci_if_error).toBe(false);
  });

  it("uploads fork PR coverage tokenlessly instead of silently skipping it", () => {
    // Fork PRs cannot read secrets.CODECOV_TOKEN. Previously the token-gated upload steps simply
    // excluded forks with no replacement, so codecov/patch had no report to compare against and fell
    // back to Codecov's if_not_found: success default -- a green "0.00%, not affected" check that never
    // actually enforced the patch bar on fork contributions. codecov-action's tokenless upload path
    // (public repos only) closes that gap with a single, synchronous, same-job upload: no separate
    // workflow, no artifact staging, no fork-authored attribution data to trust or validate.
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const verifyStep = steps.find((step) => step.name === "Verify coverage report exists");
    expect(verifyStep).toBeDefined();
    // The existence check must apply to forks too now -- it used to explicitly exclude them.
    expect(String(verifyStep!.if)).not.toContain("fork");

    const forkCoverageUpload = steps.find((step) => step.name === "Upload coverage to Codecov (fork PR tokenless)");
    expect(forkCoverageUpload).toBeDefined();
    expect(String(forkCoverageUpload!.if)).toContain("github.event.pull_request.head.repo.fork == true");

    const forkCoverageWith = record(forkCoverageUpload!.with, "fork coverage upload with");
    expect(forkCoverageWith.token).toBeUndefined();
    expect(forkCoverageWith.files).toBe("./coverage/lcov.info");
    expect(forkCoverageWith.disable_search).toBe(true);
    expect(forkCoverageWith.fail_ci_if_error).toBe(true);
    // GITHUB_SHA is the ephemeral auto-merge commit on pull_request events, and codecov-cli's fallback to
    // recover the real head sha assumes a 2-parent merge commit at HEAD -- which our checkout step (it
    // fetches github.event.pull_request.head.sha directly) never produces. Without an explicit override,
    // the report would attach to a sha GitHub's PR checks list has no reason to ever display.
    expect(forkCoverageWith.override_branch).toBe("${{ github.event.pull_request.head.ref }}");
    expect(forkCoverageWith.override_commit).toBe("${{ github.event.pull_request.head.sha }}");
    expect(forkCoverageWith.override_pr).toBe("${{ github.event.pull_request.number }}");

    const forkTestResultsUpload = steps.find(
      (step) => step.name === "Upload Vitest results to Codecov (fork PR tokenless)",
    );
    expect(forkTestResultsUpload).toBeDefined();
    const forkTestResultsWith = record(forkTestResultsUpload!.with, "fork test results upload with");
    expect(forkTestResultsWith.token).toBeUndefined();
    expect(forkTestResultsWith.report_type).toBe("test_results");
    expect(forkTestResultsWith.fail_ci_if_error).toBe(false);
    expect(forkTestResultsWith.override_commit).toBe("${{ github.event.pull_request.head.sha }}");

    // The trusted (token) path must still explicitly exclude forks -- it must never see the token env
    // used, and the two paths must be mutually exclusive so a fork PR never double-uploads.
    const trustedCoverageUpload = steps.find((step) => step.name === "Upload coverage to Codecov");
    expect(trustedCoverageUpload).toBeDefined();
    expect(String(trustedCoverageUpload!.if)).toContain("github.event.pull_request.head.repo.fork != true");
    const trustedWith = record(trustedCoverageUpload!.with, "trusted coverage upload with");
    expect(trustedWith.token).toBe("${{ secrets.CODECOV_TOKEN }}");
  });
});
