import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
    // backend==true) already gates the whole matrix. #8167 added the ONE legitimate escape: a scoped
    // selection that matched zero test files writes no report at all (no_tests_matched), so verify — and
    // every upload below it — must skip on that output rather than fail closed on a missing lcov. The
    // policy stays: absent that explicit escape hatch, a missing report still fails the build, and the
    // uploads can never run without the verify guard's own condition.
    expect(String(verifyStep.if)).toBe(
      "${{ success() && steps.coverage.outputs.no_tests_matched != 'true' && steps.coverage.outputs.no_src_coverage != 'true' }}",
    );
    // EVERY upload below the verify step must carry the same escapes: with zero matched tests there is no
    // lcov/junit at all, and the coverage uploads' fail_ci_if_error would turn that non-event red. The
    // second escape (#8194) is the scoped run that matched tests which PASSED but exercised nothing under
    // src/** -- an empty lcov there is a legitimate outcome, never a failed suite.
    expect(String(coverageUpload.if)).toContain("success()");
    expect(String(coverageUpload.if)).toContain("no_tests_matched != 'true'");
    expect(String(coverageUpload.if)).toContain("no_src_coverage != 'true'");
    expect(String(testResultsUpload.if)).toContain("no_tests_matched != 'true'");
    expect(String(testResultsUpload.if)).toContain("no_src_coverage != 'true'");
    // The scoped branch must derive BOTH outputs from the run itself (vitest's own stdout + exit status),
    // never from re-deriving selection logic -- pin the detector lines so they can't silently vanish.
    const coverageStep = steps[stepNames.indexOf("Test with coverage")]!;
    expect(String(coverageStep.run)).toContain('grep -q "No test files found" vitest-scoped-output.log');
    expect(String(coverageStep.run)).toContain('echo "no_src_coverage=true"');
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

  it("keeps miner-ui under app-local coverage gates (#4865)", () => {
    const minerUi = readFileSync("apps/loopover-miner-ui/vitest.config.ts", "utf8");
    const minerUiPkg = JSON.parse(readFileSync("apps/loopover-miner-ui/package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(minerUi).toMatch(/coverage:\s*\{/);
    expect(minerUi).toMatch(/thresholds:/);
    expect(minerUiPkg.scripts.test).toContain("--coverage");
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
    expect(rootPkg.scripts["rees:coverage"]).toBe("node --experimental-strip-types scripts/rees-coverage.ts");
    const reesCoverageScript = readFileSync("scripts/rees-coverage.ts", "utf8");
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
    // Unsharded (2026-07-24): the merge job is gone -- the whole-suite threshold runs inline in
    // validate-tests, so the only invariant left to pin is that no stale merge job lingers.
    expect((workflow as { jobs?: Record<string, unknown> }).jobs?.["validate-tests-merge"]).toBeUndefined();
  });

  it("captures control-plane node:test coverage for Codecov (#7743)", () => {
    const rootPkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(rootPkg.scripts["control-plane:coverage"]).toBe("node --experimental-strip-types scripts/control-plane-coverage.ts");
    const coverageScript = readFileSync("scripts/control-plane-coverage.ts", "utf8");
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
  });
});

/** Mirrors vitest.config.ts's own coverage.include roots (kept in sync by hand, same discipline as that
 *  file's own header comment) -- exactly the source trees Codecov gates on patch coverage, so a malformed
 *  v8-ignore directive anywhere in them can silently widen an exempted range past what anyone intended,
 *  precisely the bug this check exists to catch (#9064: src/scenarios/input-model.ts's `v8 ignore end` --
 *  not a valid v8 terminator -- silently exempted everything from that point to EOF, ~30 lines wide of the
 *  ~3 lines it was meant to cover). */
const V8_IGNORE_SCAN_ROOTS = [
  "src",
  "packages/loopover-engine/src",
  "packages/loopover-miner/lib",
  "packages/loopover-miner/bin",
  "packages/discovery-index/src",
  "packages/loopover-mcp/lib",
  "packages/loopover-mcp/bin",
];

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(path, out);
    } else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Every v8/c8 coverage-ignore hint this codebase actually uses (a bare `next`, `next N`, the `start`/
 *  `stop` pair, whole-file `file`, and branch-shaped `else`) -- anything outside this set (e.g. `end`,
 *  which is NOT a valid v8 terminator) is malformed, and worse, silently WIDENS the exempted range rather
 *  than failing loudly: an unterminated `start` (a bad terminator keyword, or none at all before EOF)
 *  keeps ignoring every subsequent line in the file, not just the intended block. */
const VALID_V8_IGNORE_KEYWORDS = new Set(["next", "start", "stop", "file", "else"]);
// Matched directly against the opening of a comment (`/*` + optional extra `*` for a `/**` doc-comment +
// whitespace + "v8 ignore" + the keyword) -- deliberately NOT "find every /* ... */ span, then check its
// contents": a real .ts file in this repo routinely contains a literal `/*` substring that is not a comment
// opener at all (e.g. a route-path glob quoted in prose, `` `/v1/internal/*` ``, inside an ordinary `//`
// line comment) -- naively pairing THAT `/*` with the next real `*/` anywhere later in the file merges two
// unrelated comments into one bogus span and silently swallows whatever directive sits inside it (confirmed
// empirically against src/api/routes.ts while building this check). Matching "v8 ignore" at the exact
// position right after a real `/*` sidesteps the problem entirely: it needs no closing `*/` to be found.
const V8_IGNORE_DIRECTIVE_RE = /\/\*\*?\s*v8 ignore\s+(\S+)/g;
// Only consulted for the rare `file` directive, to check the same comment for an issue reference -- bounded
// so a genuinely unrelated later `*/` (or none at all before EOF) can't runaway-scan the rest of the file.
const COMMENT_TAIL_SEARCH_WINDOW = 500;

function findMalformedV8IgnoreDirectives(filePath: string, content: string): string[] {
  const problems: string[] = [];
  let openStartLine: number | null = null;
  V8_IGNORE_DIRECTIVE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = V8_IGNORE_DIRECTIVE_RE.exec(content)) !== null) {
    const keyword = match[1]!;
    const line = content.slice(0, match.index).split("\n").length;
    if (!VALID_V8_IGNORE_KEYWORDS.has(keyword)) {
      problems.push(
        `${filePath}:${line}: unrecognized "v8 ignore ${keyword}" -- not a valid v8 terminator (valid: ${[...VALID_V8_IGNORE_KEYWORDS].join(", ")})`,
      );
      continue;
    }
    if (keyword === "start") {
      if (openStartLine !== null) {
        problems.push(`${filePath}:${line}: "v8 ignore start" opened again before the one at line ${openStartLine} was closed with "stop"`);
      }
      openStartLine = line;
    } else if (keyword === "stop") {
      if (openStartLine === null) {
        problems.push(`${filePath}:${line}: "v8 ignore stop" with no matching "v8 ignore start" before it`);
      }
      openStartLine = null;
    } else if (keyword === "file") {
      const tail = content.slice(match.index, match.index + COMMENT_TAIL_SEARCH_WINDOW);
      const closeIndex = tail.indexOf("*/");
      const comment = closeIndex === -1 ? tail : tail.slice(0, closeIndex);
      if (!/#\d+/.test(comment)) {
        problems.push(`${filePath}:${line}: whole-file "v8 ignore file" must reference an issue number (e.g. "#1234") justifying the exemption`);
      }
    }
  }
  if (openStartLine !== null) {
    problems.push(
      `${filePath}: "v8 ignore start" at line ${openStartLine} is never closed with a matching "v8 ignore stop" -- everything after it in the file is silently excluded from coverage`,
    );
  }
  return problems;
}

describe("v8 ignore directive hygiene (#9064)", () => {
  it("has no unterminated start, non-stop terminator, or unreferenced whole-file ignore", () => {
    const problems = V8_IGNORE_SCAN_ROOTS.filter((root) => {
      try {
        return statSync(root).isDirectory();
      } catch {
        return false;
      }
    })
      .flatMap((root) => collectTsFiles(root))
      .flatMap((filePath) => findMalformedV8IgnoreDirectives(filePath, readFileSync(filePath, "utf8")));

    expect(problems).toEqual([]);
  });

  it("flags the exact defect classes this check exists to catch (self-test)", () => {
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore end */\ncode();\n")).toEqual([
      'fixture.ts:1: unrecognized "v8 ignore end" -- not a valid v8 terminator (valid: next, start, stop, file, else)',
    ]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore start */\ncode();\n")).toEqual([
      'fixture.ts: "v8 ignore start" at line 1 is never closed with a matching "v8 ignore stop" -- everything after it in the file is silently excluded from coverage',
    ]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "code();\n/* v8 ignore stop */\n")).toEqual([
      'fixture.ts:2: "v8 ignore stop" with no matching "v8 ignore start" before it',
    ]);
    expect(
      findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore start */\ncode();\n/* v8 ignore start */\nmore();\n/* v8 ignore stop */\n"),
    ).toEqual(['fixture.ts:3: "v8 ignore start" opened again before the one at line 1 was closed with "stop"']);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore file */\ncode();\n")).toEqual([
      'fixture.ts:1: whole-file "v8 ignore file" must reference an issue number (e.g. "#1234") justifying the exemption',
    ]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore file -- see #1234 */\ncode();\n")).toEqual([]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore next */\ncode();\n")).toEqual([]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore next 3 */\ncode();\n")).toEqual([]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore start */\ncode();\n/* v8 ignore stop */\n")).toEqual([]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "/* v8 ignore else */\ncode();\n")).toEqual([]);
    expect(findMalformedV8IgnoreDirectives("fixture.ts", "no ignores here\n")).toEqual([]);
  });
});
