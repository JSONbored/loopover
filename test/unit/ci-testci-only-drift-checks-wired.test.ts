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

// #9649: coco-dev-versions:check and import-specifiers:check were the last two entries in package.json's
// `test:ci` aggregate with no enforcement path in .github/workflows/ci.yml at all -- only local discipline ran
// them, so a version-pin drift (the coco check) or a per-zone import drift (#9240/#9249, the import check)
// could reach main with zero CI signal. This mirrors ci-generated-artifact-drift-checks.test.ts's assertion
// shape for those two checks' own wiring into the validate-code job.
describe("test:ci-only drift checks are wired into the validate-code job", () => {
  const workflow = readYaml(".github/workflows/ci.yml");
  const changes = record(record(workflow.jobs, "workflow.jobs").changes, "jobs.changes");
  const validateCode = record(record(workflow.jobs, "workflow.jobs")["validate-code"], "jobs.validate-code");
  const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

  const stepFor = (name: string) => {
    const step = steps.find((entry) => entry.name === name);
    expect(step, `step "${name}" must exist`).toBeDefined();
    return step!;
  };

  it("both checks are still part of package.json's test:ci aggregate", () => {
    const pkg = record(JSON.parse(readFileSync("package.json", "utf8")), "package.json");
    const scripts = record(pkg.scripts, "package.json.scripts");
    expect(String(scripts["test:ci"])).toContain("npm run coco-dev-versions:check");
    expect(String(scripts["test:ci"])).toContain("npm run import-specifiers:check");
  });

  it("the changes job declares a cocoDev filter output covering the two version files and the checker", () => {
    const outputs = record(changes.outputs, "jobs.changes.outputs");
    expect(String(outputs.cocoDev)).toBe("${{ steps.filter.outputs.cocoDev }}");

    // The filters: block is a literal YAML string passed to dorny/paths-filter, so assert against the raw text.
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).toMatch(/cocoDev:\s*\n\s*- 'k8s\/coco-dev\/\*\*'\s*\n\s*- 'scripts\/check-coco-dev-versions\*\.ts'/);
  });

  it("validate-code's job-level if includes cocoDev, so a k8s/coco-dev-only PR still schedules the job", () => {
    // The exact gap that would otherwise skip the whole job -- and with it the step-level gate below -- for a
    // PR whose only change matches cocoDev and no other filter.
    expect(String(validateCode.if)).toContain("needs.changes.outputs.cocoDev == 'true'");
  });

  it("runs coco-dev-versions:check, gated on the cocoDev filter plus the push clause", () => {
    const step = stepFor("Coco-dev versions drift check");
    expect(String(step.run)).toBe("npm run coco-dev-versions:check");
    const condition = String(step.if);
    expect(condition).toContain("github.event_name == 'push'");
    expect(condition).toContain("needs.changes.outputs.cocoDev == 'true'");
  });

  it("runs import-specifiers:check, gated on backend plus every packages/* workspace filter it scans", () => {
    const step = stepFor("Import-specifiers drift check");
    expect(String(step.run)).toBe("npm run import-specifiers:check");
    const condition = String(step.if);
    // The checker scans src/scripts/test (backend) and packages (mcp/engine/miner/discoveryIndex) -- each root
    // must have a filter that re-triggers it, and each is already in validate-code's job-level if above.
    for (const output of ["backend", "mcp", "engine", "miner", "discoveryIndex"]) {
      expect(condition, `must gate on ${output}`).toContain(`needs.changes.outputs.${output} == 'true'`);
    }
    expect(condition).toContain("github.event_name == 'push'");
  });
});
