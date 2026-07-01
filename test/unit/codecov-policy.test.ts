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

    expect(verifyStep.if).toBe(coverageUpload.if);
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
});
