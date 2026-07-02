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

// #2557: worker-configuration.d.ts is generated from wrangler.jsonc via `npm run cf-typegen`, but unlike its
// sibling generated artifacts (openapi.json, migrations) it had no CI drift guard -- two independently-valid
// binding additions could merge sequentially and leave the committed types silently stale.
describe("cf-typegen staleness guard (#2557)", () => {
  it("package.json defines cf-typegen:check and wires it into test:ci", () => {
    const pkg = record(JSON.parse(readFileSync("package.json", "utf8")), "package.json");
    const scripts = record(pkg.scripts, "package.json.scripts");

    expect(scripts["cf-typegen:check"]).toBe("wrangler types --check");
    expect(String(scripts["test:ci"])).toContain("npm run cf-typegen:check");
    // Must run before typecheck, mirroring db:migrations:check's position -- a drift-check failure should
    // surface before the more expensive type/test/build steps run.
    const ciChain = String(scripts["test:ci"]);
    expect(ciChain.indexOf("cf-typegen:check")).toBeLessThan(ciChain.indexOf("npm run typecheck"));
  });

  it("ci.yml's changes job treats wrangler.jsonc and worker-configuration.d.ts as backend paths", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const changesJob = nestedRecord(workflow, ["jobs", "changes"]);
    const steps = recordArray(changesJob.steps, "jobs.changes.steps");
    const filterStep = steps.find((step) => step.id === "filter");
    expect(filterStep).toBeDefined();
    const withBlock = record(filterStep!.with, "filter.with");
    const filters = String(withBlock.filters);
    const backendBlock = filters.slice(filters.indexOf("backend:"), filters.indexOf("ui:"));

    expect(backendBlock).toContain("wrangler.jsonc");
    expect(backendBlock).toContain("worker-configuration.d.ts");
  });

  it("ci.yml's validate-code job runs the drift check gated the same as the migrations check", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const migrationsIndex = steps.findIndex((step) => step.name === "Check migrations");
    const cfTypegenIndex = steps.findIndex((step) => step.name === "cf-typegen drift check");
    expect(migrationsIndex).toBeGreaterThan(-1);
    expect(cfTypegenIndex).toBeGreaterThan(migrationsIndex);

    const migrationsStep = steps[migrationsIndex]!;
    const cfTypegenStep = steps[cfTypegenIndex]!;
    expect(String(cfTypegenStep.if)).toBe(String(migrationsStep.if));
    expect(String(cfTypegenStep.run)).toBe("npm run cf-typegen:check");
  });
});
