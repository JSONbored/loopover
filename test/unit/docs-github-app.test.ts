import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GITHUB_APP_DOCS_PATH = resolve(
  import.meta.dirname,
  "../../apps/gittensory-ui/src/routes/docs.github-app.tsx",
);

describe("docs GitHub App setup page", () => {
  const source = readFileSync(GITHUB_APP_DOCS_PATH, "utf8");

  it("documents the install route, permissions, events, and setup verification", () => {
    expect(source).toMatch(/https:\/\/github\.com\/apps\/gittensory\/installations\/new/);
    expect(source).toMatch(/Metadata: read/);
    expect(source).toMatch(/Pull requests: read/);
    expect(source).toMatch(/Issues: write/);
    expect(source).toMatch(/Checks: write/);
    expect(source).toMatch(/issue_comment/);
    expect(source).toMatch(/pull_request/);
    expect(source).toMatch(/GET \/v1\/installations/);
    expect(source).toMatch(/GET \/v1\/repos\/:owner\/:repo\/registration-readiness/);
    expect(source).toMatch(/POST \/v1\/repos\/:owner\/:repo\/settings-preview/);
  });

  it("keeps Context advisory and Gate opt-in before branch protection", () => {
    expect(source).toMatch(/Gittensory Context<\/strong> is advisory/);
    expect(source).toMatch(/Gittensory Gate<\/strong> is opt-in/);
    expect(source).toMatch(/should require <strong>Gittensory Gate<\/strong> only after/);
    expect(source).toMatch(/Do not require <strong>Gittensory Context<\/strong>/);
  });
});
