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

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

function nestedRecord(source: Record<string, unknown>, path: string[]): Record<string, unknown> {
  return path.reduce((current, key) => record(current[key], path.join(".")), source);
}

describe("observability config CI guard", () => {
  it("runs the observability validator for config-only PRs", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const changesJob = nestedRecord(workflow, ["jobs", "changes"]);
    const outputs = record(changesJob.outputs, "jobs.changes.outputs");
    const steps = recordArray(changesJob.steps, "jobs.changes.steps");
    const filterStep = steps.find((step) => step.id === "filter");
    expect(filterStep).toBeDefined();

    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const validateSteps = recordArray(validateCode.steps, "jobs.validate-code.steps");
    const neutralizeStep = validateSteps.find((step) => step.name === "Neutralize untrusted npm config");
    const validateStep = validateSteps.find((step) => step.name === "Validate observability configs");

    expect(outputs.observability).toBe("${{ steps.filter.outputs.observability }}");
    expect(String(validateCode.if)).toContain("needs.changes.outputs.observability == 'true'");
    const filters = String(record(filterStep!.with, "filter.with").filters);
    expect(filters).toContain("observability:");
    expect(filters).toContain("grafana/dashboards/**");
    expect(filters).toContain("prometheus/rules/**");
    expect(neutralizeStep).toBeDefined();
    expect(neutralizeStep!.run).toBe("rm -f .npmrc");
    expect(validateStep).toBeDefined();
    expect(String(validateStep!.if)).toBe(
      "${{ github.event_name == 'push' || needs.changes.outputs.backend == 'true' || needs.changes.outputs.observability == 'true' }}",
    );
    expect(record(validateStep!.env, "validateStep.env").NODE_OPTIONS).toBe("");
    expect(validateStep!.run).toBe("node scripts/validate-observability-configs.mjs");
  });
});
