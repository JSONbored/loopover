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
    // "Setup workspace" (a local composite action, .github/actions/setup-workspace) replaced the
    // inline "Neutralize untrusted npm config"/Node-setup/node_modules-cache steps that used to live
    // directly in this job -- see ci-composite-setup-workspace.test.ts for what that action itself
    // contains. Checked here only as a parse-sanity canary (confirms validateSteps is really this
    // job's step list), same role the removed npmrc-step check served.
    const setupWorkspaceStep = validateSteps.find((step) => step.name === "Setup workspace");
    const validateStep = validateSteps.find((step) => step.name === "Validate observability configs");

    expect(outputs.observability).toBe("${{ steps.filter.outputs.observability }}");
    expect(String(validateCode.if)).toContain("needs.changes.outputs.observability == 'true'");
    const filters = String(record(filterStep!.with, "filter.with").filters);
    expect(filters).toContain("observability:");
    expect(filters).toContain("grafana/dashboards/**");
    expect(filters).toContain("prometheus/rules/**");
    expect(setupWorkspaceStep).toBeDefined();
    expect(setupWorkspaceStep!.uses).toBe("./.github/actions/setup-workspace");
    expect(validateStep).toBeDefined();
    // Not gated on `backend`: scripts/validate-observability-configs.ts only ever reads
    // grafana/dashboards/*.json and prometheus/rules/alerts.yml, both fully covered by the
    // `observability` filter checked above -- a `backend` clause had no structural justification and ran
    // this on every backend PR (the highest-volume PR shape in the repo) for nothing.
    expect(String(validateStep!.if)).toBe("${{ github.event_name == 'push' || needs.changes.outputs.observability == 'true' }}");
    expect(record(validateStep!.env, "validateStep.env").NODE_OPTIONS).toBe("");
    expect(validateStep!.run).toBe("node --experimental-strip-types scripts/validate-observability-configs.ts");
  });
});
