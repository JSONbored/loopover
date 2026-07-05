import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Drift guard (#1574): self-host onboarding docs must keep naming the three activation layers, the
// one-click activation routes, Checks:write re-approval, INSTALL_AI_CLIS, and the re-gate sweep job
// types — otherwise operators follow stale instructions after the underlying paths change.

const QUICKSTART = "apps/gittensory-ui/src/routes/docs.self-hosting-quickstart.tsx";
const CONFIG = "apps/gittensory-ui/src/routes/docs.self-hosting-configuration.tsx";
const OPERATIONS = "apps/gittensory-ui/src/routes/docs.self-hosting-operations.tsx";
const GITHUB_APP = "apps/gittensory-ui/src/routes/docs.self-hosting-github-app.tsx";
const MAINTAINER = "apps/gittensory-ui/src/routes/docs.maintainer-self-hosting.tsx";

const quickstart = readFileSync(QUICKSTART, "utf8");
const configuration = readFileSync(CONFIG, "utf8");
const operations = readFileSync(OPERATIONS, "utf8");
const githubApp = readFileSync(GITHUB_APP, "utf8");
const maintainer = readFileSync(MAINTAINER, "utf8");

describe("self-host activation + onboarding docs (#1574)", () => {
  it("quickstart documents allowlist, private config seed, activation POST, and Checks: write", () => {
    expect(quickstart).toContain("GITTENSORY_REVIEW_REPOS");
    expect(quickstart).toContain("config/examples/global.gittensory.yml");
    expect(quickstart).toContain("gittensory-config/.gittensory.yml");
    expect(quickstart).toContain("/v1/repos/owner/my-repo/activation");
    expect(quickstart).toContain("Checks: write");
    expect(quickstart).toContain("INSTALL_AI_CLIS");
  });

  it("configuration separates feature allowlist, gate activation, and is_registered", () => {
    expect(configuration).toContain("GITTENSORY_REVIEW_REPOS");
    expect(configuration).toContain("is_registered");
    expect(configuration).toContain("/v1/repos/:owner/:repo/activation-preview");
    expect(configuration).toContain("/v1/repos/:owner/:repo/activation");
  });

  it("operations documents the periodic re-gate sweep job types", () => {
    expect(operations).toContain("agent-regate-sweep");
    expect(operations).toContain("agent-regate-pr");
    expect(operations).toContain("backlog-convergence-sweep");
    expect(operations).toContain("regate_sweep_throttled");
  });

  it("github-app doc still requires Checks: write at the manifest level", () => {
    expect(githubApp).toMatch(/Checks:\s*write/i);
    expect(githubApp).toContain("Re-approving a permission bump");
  });

  it("maintainer index includes the onboarding simplification proposal", () => {
    expect(maintainer).toContain("Onboarding simplification proposal");
    expect(maintainer).toContain("POST /v1/repos/:owner/:repo/activation");
    expect(maintainer).toContain("global.gittensory.yml");
  });
});
