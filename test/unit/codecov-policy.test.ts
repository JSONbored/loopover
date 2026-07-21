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
    // The full-suite coverage run (and its Codecov uploads) lives in validate-tests, sharded out of
    // validate-code (#ci-shard-coverage) so the ~9-10min run no longer serializes with the much-faster
    // drift/typecheck/build checks that stayed behind in validate-code.
    const validateTests = nestedRecord(workflow, ["jobs", "validate-tests"]);
    const steps = recordArray(validateTests.steps, "jobs.validate-tests.steps");

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

    // Verify must run whenever coverage was generated at all -- the job's own top-level `if:` (push or
    // backend==true) already gates the whole matrix, so the step itself only needs `success()`. It
    // deliberately does NOT exclude forks, since both the trusted and the tokenless fork upload path
    // below it need the report to exist first.
    expect(String(verifyStep.if)).toBe("${{ success() }}");
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

  it("measures miner lib changes for codecov patch coverage (#4864)", () => {
    const vitestConfig = readFileSync("vitest.config.ts", "utf8");
    expect(vitestConfig).toMatch(/packages\/loopover-miner\/lib\/\*\*\/\*\.js/);

    const config = readYaml("codecov.yml");
    const ignore = config.ignore;
    if (!Array.isArray(ignore)) throw new Error("codecov.yml ignore must be an array");
    expect(ignore.some((entry) => typeof entry === "string" && entry.includes("loopover-miner"))).toBe(false);
  });

  it("keeps miner-ui and miner-extension under app-local coverage gates (#4865)", () => {
    const minerUi = readFileSync("apps/loopover-miner-ui/vitest.config.ts", "utf8");
    const minerExtension = readFileSync("apps/loopover-miner-extension/vitest.config.ts", "utf8");
    const minerUiPkg = JSON.parse(readFileSync("apps/loopover-miner-ui/package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const minerExtensionPkg = JSON.parse(
      readFileSync("apps/loopover-miner-extension/package.json", "utf8"),
    ) as { scripts: Record<string, string> };
    const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

    expect(minerUi).toMatch(/coverage:\s*\{/);
    expect(minerUi).toMatch(/thresholds:/);
    expect(minerExtension).toMatch(/coverage:\s*\{/);
    expect(minerExtension).toMatch(/thresholds:/);
    expect(minerUiPkg.scripts.test).toContain("--coverage");
    expect(minerExtensionPkg.scripts.test).toContain("--coverage");
    expect(rootPkg.scripts["ui:test"]).toContain("@loopover/miner-extension run test");
  });

  it("uploads fork PR coverage tokenlessly instead of silently skipping it", () => {
    // Fork PRs cannot read secrets.CODECOV_TOKEN. Previously the token-gated upload steps simply
    // excluded forks with no replacement, so codecov/patch had no report to compare against and fell
    // back to Codecov's if_not_found: success default -- a green "0.00%, not affected" check that never
    // actually enforced the patch bar on fork contributions. codecov-action's tokenless upload path
    // (public repos only) closes that gap with a single, synchronous, same-job upload: no separate
    // workflow, no artifact staging, no fork-authored attribution data to trust or validate.
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateTests = nestedRecord(workflow, ["jobs", "validate-tests"]);
    const steps = recordArray(validateTests.steps, "jobs.validate-tests.steps");

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
    expect(forkCoverageWith.override_commit).toBe("${{ github.event.pull_request.head.sha }}");
    expect(forkCoverageWith.override_pr).toBe("${{ github.event.pull_request.number }}");
    // Codecov only treats a branch as "unprotected" (eligible for tokenless upload) when its name has a
    // colon-separated prefix; a bare branch name gets rejected with "Token required because branch is
    // protected" even with no token configured anywhere. codecov-cli's own auto-detection never adds
    // this prefix, so it must be supplied explicitly -- omitting it is exactly the regression this guards.
    expect(String(forkCoverageWith.override_branch)).toContain(":");
    expect(forkCoverageWith.override_branch).toBe(
      "${{ github.event.pull_request.head.repo.owner.login }}:${{ github.event.pull_request.head.ref }}",
    );

    const forkTestResultsUpload = steps.find(
      (step) => step.name === "Upload Vitest results to Codecov (fork PR tokenless)",
    );
    expect(forkTestResultsUpload).toBeDefined();
    const forkTestResultsWith = record(forkTestResultsUpload!.with, "fork test results upload with");
    expect(forkTestResultsWith.token).toBeUndefined();
    expect(forkTestResultsWith.report_type).toBe("test_results");
    expect(forkTestResultsWith.fail_ci_if_error).toBe(false);
    expect(forkTestResultsWith.override_commit).toBe("${{ github.event.pull_request.head.sha }}");
    expect(String(forkTestResultsWith.override_branch)).toContain(":");

    // The trusted (token) path must still explicitly exclude forks -- it must never see the token env
    // used, and the two paths must be mutually exclusive so a fork PR never double-uploads.
    const trustedCoverageUpload = steps.find((step) => step.name === "Upload coverage to Codecov");
    expect(trustedCoverageUpload).toBeDefined();
    expect(String(trustedCoverageUpload!.if)).toContain("github.event.pull_request.head.repo.fork != true");
    const trustedWith = record(trustedCoverageUpload!.with, "trusted coverage upload with");
    expect(trustedWith.token).toBe("${{ secrets.CODECOV_TOKEN }}");
  });

  it("uploads loopover-ui's bundle stats without letting an upload hiccup fail CI", () => {
    // loopover-miner-ui deliberately has no build step in this job at all (self-hosted operator
    // dashboard, not something we deploy -- see "UI build"'s own comment), so there is nothing to
    // upload bundle stats for on that app here.
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const buildIndex = steps.findIndex((step) => step.name === "UI build");
    const bundleIndex = steps.findIndex((step) => step.name === "Upload UI bundle stats to Codecov");
    expect(buildIndex).toBeGreaterThan(-1);
    expect(bundleIndex).toBeGreaterThan(buildIndex);

    const bundleStep = steps[bundleIndex]!;
    // Unlike the coverage uploads above, nothing gates a merge on bundle size -- a Codecov outage or a
    // missing token must never fail CI for an otherwise-honest PR.
    expect(bundleStep["continue-on-error"]).toBe(true);
    expect(String(bundleStep.if)).toContain("github.event.pull_request.head.repo.fork != true");
    const bundleEnv = record(bundleStep.env, "bundle step env");
    expect(bundleEnv.CODECOV_TOKEN).toBe("${{ secrets.CODECOV_TOKEN }}");
    expect(bundleStep.run).toBe("npm run bundle-analysis --workspace @loopover/ui");

    const uiPkg = JSON.parse(readFileSync("apps/loopover-ui/package.json", "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(uiPkg.scripts["bundle-analysis"]).toBe(
      "bundle-analyzer ./dist/client --bundle-name=loopover-ui --upload-token=$CODECOV_TOKEN",
    );
    expect(uiPkg.devDependencies["@codecov/bundle-analyzer"]).toBeDefined();
  });

  it("captures review-enrichment node:test coverage for Codecov (#6250)", () => {
    const vitestConfig = readFileSync("vitest.config.ts", "utf8");
    expect(vitestConfig).not.toMatch(/review-enrichment\/src\/analyzers\/codeowners\.ts/);

    const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(rootPkg.scripts["rees:coverage"]).toBe("node scripts/rees-coverage.mjs");
    const reesCoverageScript = readFileSync("scripts/rees-coverage.mjs", "utf8");
    expect(reesCoverageScript).toContain("c8");
    expect(reesCoverageScript).toContain("review-enrichment");
    expect(reesCoverageScript).toContain("coverage");

    const reesPkg = JSON.parse(readFileSync("review-enrichment/package.json", "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(reesPkg.devDependencies.c8).toBeDefined();

    const codecov = readYaml("codecov.yml");
    const reesFlag = nestedRecord(codecov, ["flags", "rees"]);
    expect(reesFlag.carryforward).toBe(true);
    expect(reesFlag.paths).toEqual(["review-enrichment/"]);

    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const codeSteps = recordArray(validateCode.steps, "jobs.validate-code.steps");
    const coverageStep = codeSteps.find((step) => step.name === "REES coverage");
    const verifyStep = codeSteps.find((step) => step.name === "Verify REES coverage report exists");
    const trustedUpload = codeSteps.find((step) => step.name === "Upload REES coverage to Codecov");
    const forkUpload = codeSteps.find((step) => step.name === "Upload REES coverage to Codecov (fork PR tokenless)");
    expect(coverageStep).toBeDefined();
    expect(String(coverageStep!.run)).toContain("rees:coverage");
    expect(verifyStep).toBeDefined();
    expect(String(verifyStep!.run)).toContain("review-enrichment/coverage/lcov.info");
    expect(trustedUpload).toBeDefined();
    expect(record(trustedUpload!.with, "rees trusted upload").flags).toBe("rees");
    expect(forkUpload).toBeDefined();
    expect(record(forkUpload!.with, "rees fork upload").flags).toBe("rees");
    expect(String(forkUpload!.if)).toContain("fork == true");

    const validateTests = nestedRecord(workflow, ["jobs", "validate-tests"]);
    expect(String(validateTests.if)).toContain("needs.changes.outputs.rees == 'true'");
    const validateTestsMerge = nestedRecord(workflow, ["jobs", "validate-tests-merge"]);
    expect(String(validateTestsMerge.if)).toContain("needs.changes.outputs.rees == 'true'");
  });

  it("captures control-plane node:test coverage for Codecov (#7743)", () => {
    const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(rootPkg.scripts["control-plane:coverage"]).toBe("node scripts/control-plane-coverage.mjs");
    const coverageScript = readFileSync("scripts/control-plane-coverage.mjs", "utf8");
    expect(coverageScript).toContain("c8");
    expect(coverageScript).toContain("control-plane");
    expect(coverageScript).toContain("coverage");

    const controlPlanePkg = JSON.parse(readFileSync("control-plane/package.json", "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(controlPlanePkg.devDependencies.c8).toBeDefined();

    const codecov = readYaml("codecov.yml");
    const controlPlaneFlag = nestedRecord(codecov, ["flags", "control-plane"]);
    expect(controlPlaneFlag.carryforward).toBe(true);
    expect(controlPlaneFlag.paths).toEqual(["control-plane/"]);

    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = nestedRecord(workflow, ["jobs", "validate-code"]);
    const codeSteps = recordArray(validateCode.steps, "jobs.validate-code.steps");
    const coverageStep = codeSteps.find((step) => step.name === "Control-plane coverage");
    const verifyStep = codeSteps.find((step) => step.name === "Verify control-plane coverage report exists");
    const trustedUpload = codeSteps.find((step) => step.name === "Upload control-plane coverage to Codecov");
    const forkUpload = codeSteps.find((step) => step.name === "Upload control-plane coverage to Codecov (fork PR tokenless)");
    expect(coverageStep).toBeDefined();
    expect(String(coverageStep!.run)).toContain("control-plane:coverage");
    expect(verifyStep).toBeDefined();
    expect(String(verifyStep!.run)).toContain("control-plane/coverage/lcov.info");
    expect(trustedUpload).toBeDefined();
    expect(record(trustedUpload!.with, "control-plane trusted upload").flags).toBe("control-plane");
    expect(forkUpload).toBeDefined();
    expect(record(forkUpload!.with, "control-plane fork upload").flags).toBe("control-plane");
    expect(String(forkUpload!.if)).toContain("fork == true");

    const validateTests = nestedRecord(workflow, ["jobs", "validate-tests"]);
    expect(String(validateTests.if)).toContain("needs.changes.outputs.controlPlane == 'true'");
    const validateTestsMerge = nestedRecord(workflow, ["jobs", "validate-tests-merge"]);
    expect(String(validateTestsMerge.if)).toContain("needs.changes.outputs.controlPlane == 'true'");
  });
});
