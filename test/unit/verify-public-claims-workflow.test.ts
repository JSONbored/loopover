import { readFileSync } from "node:fs";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// #9724: the nightly verification job's "no credentials" claim, as a TESTED property rather than a comment.
//
// The job asserts it reproduces what an anonymous stranger sees. That claim is only as good as the absence of
// every credential path, and those paths are easy to reopen by accident — each is one innocuous-looking line:
//
//   • `actions/checkout` defaults to `persist-credentials: true`, writing an authenticated `http.extraheader`
//     into `.git/config`. Superagent caught this in review; the claim was false until it was set to false.
//   • `actions/setup-node` writes an authenticated `.npmrc` via `auth.configAuthentication(registryUrl)` —
//     verified at the pinned SHA (v7.0.0) to be gated behind `if (registryUrl)` in `src/main.ts`, so it is
//     unreachable while the input is unset. Adding `registry-url:` later would silently reach it.
//   • giving the verify step a token in its own `env:` would hand it one directly.
//
// A comment saying "do not add these" is what the codebase calls a snapshot presented as a guarantee. This
// reads the shipped workflow and fails if any of them comes back.
const WORKFLOW_PATH = ".github/workflows/verify-public-claims.yml";

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; run?: string; if?: string };
type Workflow = { permissions?: Record<string, string>; jobs?: Record<string, { permissions?: Record<string, string>; steps?: Step[] }> };

const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
const verifyJob = workflow.jobs?.["verify"];
const steps = verifyJob?.steps ?? [];
const stepUsing = (action: string): Step | undefined => steps.find((step) => typeof step.uses === "string" && step.uses.startsWith(action));

describe("verify-public-claims workflow — the anonymous-run guarantees (#9724)", () => {
  it("reads a workflow with a verify job and steps (guards against a vacuous suite)", () => {
    // Every assertion below is over `steps`. If the file moved or the job were renamed, they would all pass
    // against an empty array and this file would guard nothing.
    expect(verifyJob, `no "verify" job in ${WORKFLOW_PATH}`).toBeDefined();
    expect(steps.length).toBeGreaterThan(3);
  });

  it("REGRESSION: checkout does not persist credentials to disk", () => {
    // The bug Superagent found. `persist-credentials` defaults to TRUE, so this must be set explicitly —
    // asserting it is absent-or-false would pass on the broken default.
    const checkout = stepUsing("actions/checkout");
    expect(checkout, "the job no longer checks out — re-point this test").toBeDefined();
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  it("REGRESSION: setup-node is not used at all — it is the last action that can write credentials", () => {
    // `actions/setup-node` writes an authenticated .npmrc via `auth.configAuthentication(registryUrl)`,
    // gated behind `if (registryUrl)` in its src/main.ts. Keeping it and leaving that input unset made the
    // safety "unreachable because nobody has added one line yet"; not present is the stronger property, and
    // the one a job claiming to hold no credentials should have. The runner's own node is used instead, with
    // an explicit version precondition in the workflow.
    expect(stepUsing("actions/setup-node")).toBeUndefined();
  });

  it("INVARIANT: checkout is the ONLY third-party action, so the credential surface stays one reviewed item", () => {
    // Not a blocklist of known-risky actions — an allowlist of the one that is actually needed. A new action
    // arriving in this job is a decision that should be made deliberately, not noticed later by a scanner.
    const used = steps.flatMap((step) => (typeof step.uses === "string" ? [step.uses.split("@")[0]!] : []));
    expect(used).toEqual(["actions/checkout"]);
  });

  it("asserts a Node version rather than assuming one, since the runner's node is now what runs", () => {
    // The tradeoff of dropping setup-node: the version is the image's. `--experimental-strip-types` needs
    // 22.6+, so the job fails loudly with the remedy rather than breaking quietly if an image regresses.
    const guard = steps.find((step) => (step.name ?? "").toLowerCase().includes("node"));
    expect(guard?.run ?? "").toMatch(/22/);
    expect(guard?.run ?? "").toMatch(/experimental-strip-types/);
  });

  it("INVARIANT: the step that runs the verifier is given no environment secrets at all", () => {
    const verifyStep = steps.find((step) => typeof step.run === "string" && step.run.includes("loopover-verify"));
    expect(verifyStep, "no step runs loopover-verify — re-point this test").toBeDefined();
    // Not "no token" but "no env": an allowlist of forbidden names would miss the next secret someone adds.
    expect(verifyStep?.env ?? {}).toEqual({});
  });

  it("INVARIANT: only the tracking-issue step holds a token, and the job's default permission is read-only", () => {
    const withToken = steps.filter((step) => JSON.stringify(step.env ?? {}).includes("github.token") || JSON.stringify(step.env ?? {}).includes("secrets."));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.name ?? "").toMatch(/tracking issue/i);
    // Top-level default stays read-only; write is granted at the job, where it is visible next to the step
    // that needs it.
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(verifyJob?.permissions).toEqual({ contents: "read", issues: "write" });
  });

  it("REGRESSION: the token-holding step stays gated on dry-run, so --dry-run cannot file an issue", () => {
    // Raised alongside the persist-credentials finding: with a token readable from .git/config, a compromised
    // verifier could have created issues even on a dry run. `persist-credentials: false` closes the disk half;
    // this pins the other half, so the gate cannot be dropped while the token stays.
    const withToken = steps.filter((step) => JSON.stringify(step.env ?? {}).includes("github.token"));
    expect(withToken).toHaveLength(1);
    expect(withToken[0]?.if ?? "").toContain("dry-run");
  });

  it("INVARIANT: no step installs the repo's dependency tree, which a stranger does not have", () => {
    // `npm ci` here would mean verifying against this checkout's node_modules rather than the published
    // package — the property that makes #9962 (a shipped verifier that could not reach production) catchable.
    for (const step of steps) expect(step.run ?? "", step.name ?? "unnamed step").not.toMatch(/\bnpm (ci|install)\b/);
  });
});
