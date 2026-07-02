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

// actions/checkout wipes node_modules on every run (git clean -ffdx) and npm ci always deletes+reinstalls
// it by design, so neither gives node_modules any real cross-run reuse -- these restore/save pairs (via
// GitHub's own cache service) fill that gap: an exact package-lock.json match skips the install step
// entirely. Cache-save is placed right after a successful install (not as an automatic post-job hook), so
// a job that fails installing never reaches the save step -- a broken node_modules can never get cached.
describe("CI dependency-install caching", () => {
  it("root npm ci is skipped only on an exact node_modules cache hit, and the cache is saved only after a successful install", () => {
    const steps = jobSteps(readYaml(".github/workflows/ci.yml"), "validate-code");

    const restore = step(steps, "Restore node_modules cache");
    expect(restore.uses).toContain("actions/cache/restore@");
    const restoreWith = record(restore.with, "restore.with");
    expect(String(restoreWith.path)).toContain("node_modules");
    expect(String(restoreWith.path)).toContain("apps/gittensory-ui/node_modules");
    expect(String(restoreWith.key)).toContain("hashFiles('package-lock.json')");
    // A Node bump (.nvmrc) with no lockfile change must still bust the cache -- otherwise a hit would
    // silently reuse node_modules whose native addons were compiled against the OLD Node's ABI.
    expect(String(restoreWith.key)).toContain("hashFiles('.nvmrc')");
    expect(String(restoreWith.key)).toContain("fork");
    expect(String(restoreWith.key)).toContain("trusted");

    const install = step(steps, "Install dependencies (retry on transient failures)");
    expect(String(install.if)).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");

    const save = step(steps, "Save node_modules cache");
    expect(String(save.if)).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");
    expect(save.uses).toContain("actions/cache/save@");
    const saveWith = record(save.with, "save.with");
    expect(saveWith.key).toBe("${{ steps.node-modules-cache.outputs.cache-primary-key }}");

    // Save must come after install (a broken/partial node_modules from a failed install step is never reached).
    const stepNames = steps.map((s) => s.name);
    expect(stepNames.indexOf("Save node_modules cache")).toBeGreaterThan(stepNames.indexOf("Install dependencies (retry on transient failures)"));
  });

  it("review-enrichment's install is cached separately (its own lockfile, not an npm workspace member)", () => {
    const steps = jobSteps(readYaml(".github/workflows/ci.yml"), "validate-code");

    const restore = step(steps, "Restore review-enrichment node_modules cache");
    const restoreWith = record(restore.with, "restore.with");
    expect(restoreWith.path).toBe("review-enrichment/node_modules");
    expect(String(restoreWith.key)).toContain("hashFiles('review-enrichment/package-lock.json')");
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
