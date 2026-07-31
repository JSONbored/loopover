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

type Step = { name?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, unknown>; run?: string };
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

  it("REGRESSION: setup-node is not given a registry-url, which is what reaches its credential writer", () => {
    // At the pinned SHA, `src/main.ts` calls `auth.configAuthentication(registryUrl)` only inside
    // `if (registryUrl)`. Unset means the `.npmrc`-writing path is unreachable; setting it would make this
    // job write a credential to disk while still claiming to hold none.
    const setupNode = stepUsing("actions/setup-node");
    expect(setupNode, "the job no longer sets up node — re-point this test").toBeDefined();
    expect(setupNode?.with?.["registry-url"]).toBeUndefined();
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

  it("INVARIANT: no step installs the repo's dependency tree, which a stranger does not have", () => {
    // `npm ci` here would mean verifying against this checkout's node_modules rather than the published
    // package — the property that makes #9962 (a shipped verifier that could not reach production) catchable.
    for (const step of steps) expect(step.run ?? "", step.name ?? "unnamed step").not.toMatch(/\bnpm (ci|install)\b/);
  });
});
