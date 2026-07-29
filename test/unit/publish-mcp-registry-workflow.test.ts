import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// #9526: the registry-publish workflow's own safety properties.
//
// This is the one job in the repo that holds `id-token: write` and writes to a PUBLIC registry under this
// repository's namespace. Everything asserted here is a property whose absence is invisible until it
// matters -- a workflow that publishes from a branch, or under a binary nobody reviewed, looks exactly like
// one that does not, right up until it does.

const WORKFLOW_PATH = ".github/workflows/publish-mcp-registry.yml";

type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string> };
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, { environment?: string; if?: string; steps?: Step[] }>;
};

const raw = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parse(raw) as Workflow;
const publish = workflow.jobs?.publish;
const steps = publish?.steps ?? [];

describe("the registry publish workflow cannot fire on its own (#9526)", () => {
  it("is dispatch-only — no push, schedule, or pull_request trigger", () => {
    // Publishing announces a version to a public registry. A merge must not do that as a side effect.
    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
  });

  it("refuses any ref but main, since a dispatch can name a branch", () => {
    expect(publish?.if).toContain("refs/heads/main");
  });

  it("runs in a deployment environment, so the OIDC-holding job can carry protection rules", () => {
    // Without one, anyone who can dispatch a workflow can publish. The rules themselves live in repo
    // settings; what the workflow owes is the hook they attach to.
    expect(publish?.environment).toBeTruthy();
  });

  it("takes id-token write and nothing else beyond read", () => {
    expect(workflow.permissions).toEqual({ contents: "read", "id-token": "write" });
  });
});

describe("the publisher binary is pinned to bytes, not to a tag (#9526)", () => {
  const install = steps.find((step) => step.run?.includes("mcp-publisher.tar.gz"));

  it("verifies a sha256 checksum before extracting anything", () => {
    // A release tag is mutable -- it can be moved to a different commit after review. The checksum is what
    // makes "pinned" true rather than merely stated, and #9526 called for exactly this.
    expect(install?.run).toContain("sha256sum --check --strict");
    expect(install?.env?.MCP_PUBLISHER_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checks the download BEFORE running it, not after", () => {
    const run = install!.run!;
    expect(run.indexOf("sha256sum")).toBeLessThan(run.indexOf("tar -xzf"));
    expect(run).toContain("set -euo pipefail");
  });

  it("downloads the asset name the release actually publishes", () => {
    // The first cut asked for `mcp-publisher_${VERSION}_linux_amd64.tar.gz`, which 404s -- the release
    // asset carries no version in its name. A publish workflow that cannot even fetch its tool is a
    // workflow nobody has run.
    expect(install?.run).toContain("mcp-publisher_linux_amd64.tar.gz");
    expect(install?.run).not.toMatch(/mcp-publisher_\$\{[^}]+\}_linux/);
    expect(install?.env?.MCP_PUBLISHER_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("pins every action it uses to a commit sha", () => {
    for (const step of steps.filter((entry) => entry.uses)) {
      expect(step.uses, `${step.uses} must be sha-pinned`).toMatch(/@[0-9a-f]{40}(\s|$)/);
    }
  });
});

describe("the anti-rot guard runs before anything is announced (#9526)", () => {
  it("validates server.json and its watched paths before login or publish", () => {
    const validateAt = steps.findIndex((step) => step.run?.includes("check-server-manifest"));
    const loginAt = steps.findIndex((step) => step.run?.includes("mcp-publisher login"));
    const publishAt = steps.findIndex((step) => step.run?.includes("mcp-publisher publish"));
    expect(validateAt).toBeGreaterThanOrEqual(0);
    // metagraphed's version-sync workflow watched a renamed-away path and kept passing while doing nothing
    // for months. The guard is only worth having if it runs before the irreversible step.
    expect(validateAt).toBeLessThan(loginAt);
    expect(validateAt).toBeLessThan(publishAt);
  });

  it("offers a dry run that stops short of publishing", () => {
    const publishStep = steps.find((step) => step.run?.includes("mcp-publisher publish"));
    expect(JSON.stringify(publishStep)).toContain("dry_run");
  });
});
