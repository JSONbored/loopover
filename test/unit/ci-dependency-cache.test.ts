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

function step(steps: Array<Record<string, unknown>>, name: string): Record<string, unknown> {
  const found = steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`step "${name}" not found`);
  return found;
}

function jobSteps(workflow: Record<string, unknown>, jobName: string): Array<Record<string, unknown>> {
  const job = record(record(workflow.jobs, "jobs")[jobName], jobName);
  return recordArray(job.steps, `${jobName}.steps`);
}

// The root node_modules restore/install/save sequence used to be asserted here directly against
// validate-code's own step list, but it's now a shared composite action
// (.github/actions/setup-workspace) invoked by validate-code/validate-tests alike
// -- see ci-composite-setup-workspace.test.ts for that logic and its call sites. review-enrichment's
// cache is untouched by that extraction (own lockfile, not an npm workspace member, no reason to share
// the same composite action), so it's still checked here directly.
describe("CI dependency-install caching", () => {
  it("review-enrichment's install is cached separately (its own lockfile, not an npm workspace member)", () => {
    const steps = jobSteps(readYaml(".github/workflows/ci.yml"), "validate-code");

    const restore = step(steps, "Restore review-enrichment node_modules cache");
    const restoreWith = record(restore.with, "restore.with");
    expect(restoreWith.path).toBe("review-enrichment/node_modules");
    expect(String(restoreWith.key)).toContain("hashFiles('review-enrichment/package.json', 'review-enrichment/package-lock.json')");
    expect(String(restoreWith.key)).toContain("review-enrichment/package.json");
    expect(String(restoreWith.key)).toContain("review-enrichment/package-lock.json");
    expect(String(restoreWith.key)).toContain("hashFiles('.nvmrc')");

    const install = step(steps, "REES install");
    expect(String(install.if)).toContain("steps.rees-node-modules-cache.outputs.cache-hit != 'true'");
    // Must still be gated by the same rees/push condition as the original single step, or it would run
    // (or skip) independently of whether review-enrichment actually changed.
    expect(String(install.if)).toContain("needs.changes.outputs.rees == 'true'");

    const save = step(steps, "Save review-enrichment node_modules cache");
    const saveWith = record(save.with, "save.with");
    expect(saveWith.key).toBe("${{ steps.rees-node-modules-cache.outputs.cache-primary-key }}");

    // The actual build/test step must run unconditionally (whenever rees applies), independent of
    // whether this run needed a fresh install or restored one from cache.
    const test = step(steps, "REES build, source-map validation, and tests");
    expect(String(test.if)).not.toContain("cache-hit");
    expect(test.run).toBe("npm --prefix review-enrichment test");
  });
});
