import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GITHUB_APP_DOCS_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.github-app.tsx",
);

describe("docs GitHub App setup page", () => {
  const source = readFileSync(GITHUB_APP_DOCS_PATH, "utf8");

  it("documents self-hosting as the only currently available install path, and setup verification", () => {
    expect(source).not.toMatch(/https:\/\/github\.com\/apps\/gittensory\/installations\/new/);
    expect(source).toMatch(/Self-hosting is the only currently available path/);
    expect(source).toMatch(/Shared, centrally hosted App: not currently available/);
    expect(source).toMatch(/GET \/v1\/installations/);
    expect(source).toMatch(/GET \/v1\/repos\/:owner\/:repo\/registration-readiness/);
    expect(source).toMatch(/POST \/v1\/repos\/:owner\/:repo\/settings-preview/);
  });

  it("keeps Context advisory and Gate opt-in before branch protection", () => {
    expect(source).toMatch(/LoopOver Context<\/strong> is advisory/);
    expect(source).toMatch(/LoopOver Orb Review Agent<\/strong> is opt-in/);
    expect(source).toMatch(/should require <strong>LoopOver Orb Review Agent<\/strong> only after/);
    expect(source).toMatch(/Do not require <strong>LoopOver Context<\/strong>/);
  });
});
