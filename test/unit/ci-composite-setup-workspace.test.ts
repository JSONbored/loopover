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

const ACTION_PATH = ".github/actions/setup-workspace/action.yml";

// .github/actions/setup-workspace holds logic that used to be hand-copied across validate-code and
// validate-tests -- the same drift risk that caused a real cache-key
// mismatch bug this repo already hit once (two jobs' Turborepo cache pair silently diverged when one
// was edited and the other wasn't). It does NOT check out the repo itself (a local `uses: ./path`
// reference needs the repo already on disk to find its own action.yml), so every call site must run
// its own actions/checkout step immediately before invoking this action.
describe("setup-workspace composite action", () => {
  it("is a composite action with the expected inputs/outputs", () => {
    const action = readYaml(ACTION_PATH);
    expect(record(action.runs, "runs").using).toBe("composite");
    expect(record(action.inputs, "inputs")["save-cache"]).toBeDefined();
    expect(record(action.outputs, "outputs")["cache-hit"]).toBeDefined();
  });

  it("skips npm ci only on an exact node_modules cache hit, and saves the cache only after a successful install", () => {
    const action = readYaml(ACTION_PATH);
    const steps = recordArray(record(action.runs, "runs").steps, "runs.steps");

    const restore = step(steps, "Restore node_modules cache");
    expect(restore.uses).toContain("actions/cache/restore@");
    const restoreWith = record(restore.with, "restore.with");
    expect(String(restoreWith.path)).toContain("node_modules");
    expect(String(restoreWith.path)).toContain("apps/loopover-ui/node_modules");
    expect(String(restoreWith.key)).toContain("hashFiles('package.json', 'apps/*/package.json', 'packages/*/package.json', 'package-lock.json')");
    expect(String(restoreWith.key)).toContain("package.json");
    expect(String(restoreWith.key)).toContain("apps/*/package.json");
    expect(String(restoreWith.key)).toContain("packages/*/package.json");
    expect(String(restoreWith.key)).toContain("package-lock.json");
    // A Node bump (.nvmrc) with no lockfile change must still bust the cache -- otherwise a hit would
    // silently reuse node_modules whose native addons were compiled against the OLD Node's ABI.
    expect(String(restoreWith.key)).toContain("hashFiles('.nvmrc')");
    expect(String(restoreWith.key)).toContain("fork");
    expect(String(restoreWith.key)).toContain("trusted");

    const install = step(steps, "Install dependencies (retry on transient failures)");
    expect(String(install.if)).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");

    const save = step(steps, "Save node_modules cache");
    expect(String(save.if)).toContain("inputs.save-cache == 'true'");
    expect(String(save.if)).toContain("steps.node-modules-cache.outputs.cache-hit != 'true'");
    expect(save.uses).toContain("actions/cache/save@");
    const saveWith = record(save.with, "save.with");
    expect(saveWith.key).toBe("${{ steps.node-modules-cache.outputs.cache-primary-key }}");

    // Save must come after install (a broken/partial node_modules from a failed install step is never reached).
    const stepNames = steps.map((s) => s.name);
    expect(stepNames.indexOf("Save node_modules cache")).toBeGreaterThan(stepNames.indexOf("Install dependencies (retry on transient failures)"));

    // Every run: step inside a composite action needs its own explicit shell (unlike a top-level
    // workflow job, which defaults to bash on a Linux runner) -- a missing one is a silent hard failure
    // at actual run time, not a parse-time error, so it's worth asserting here where it's cheap to catch.
    for (const s of steps) {
      if (s.run !== undefined) expect(s.shell, `step "${s.name}" has a run: but no shell:`).toBeDefined();
    }
  });

  it.each([
    { job: "validate-code", saveCache: undefined },
    { job: "validate-tests", saveCache: undefined },
  ])("$job invokes the composite action (save-cache: $saveCache)", ({ job, saveCache }) => {
    const steps = jobSteps(readYaml(".github/workflows/ci.yml"), job);

    // Each call site still runs its own actions/checkout step first -- the composite action can't do
    // this itself (see the action's own description).
    const checkoutIndex = steps.findIndex((s) => s.name === "Checkout");
    expect(checkoutIndex, `${job} has no Checkout step`).toBeGreaterThanOrEqual(0);
    expect(steps[checkoutIndex]?.uses).toContain("actions/checkout@");

    const setupIndex = steps.findIndex((s) => s.name === "Setup workspace");
    expect(setupIndex, `${job} has no Setup workspace step`).toBeGreaterThan(checkoutIndex);
    const setupStep = steps[setupIndex];
    expect(setupStep?.uses).toBe("./.github/actions/setup-workspace");

    if (saveCache === undefined) {
      // Default (unset with: block, or a with: block that omits save-cache) -- the action's own
      // default is "true", so nothing further to assert here.
      expect(record((setupStep?.with as Record<string, unknown> | undefined) ?? {}, "with")["save-cache"]).toBeUndefined();
    } else {
      expect(record(setupStep?.with, `${job}.with`)["save-cache"]).toBe(saveCache);
    }
  });

  it("validate-tests' Checkout uses fetch-depth: 0 (Codecov needs full history for the merge base)", () => {
    const steps = jobSteps(readYaml(".github/workflows/ci.yml"), "validate-tests");
    const checkout = step(steps, "Checkout");
    expect(record(checkout.with, "checkout.with")["fetch-depth"]).toBe(0);
  });
});
