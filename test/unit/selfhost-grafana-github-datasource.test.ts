import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Grafana GitHub data source", () => {
  it("keeps GITHUB_TOKEN and GRAFANA_ADMIN_PASSWORD out of curl argv and child environments", () => {
    const script = readFileSync(join(process.cwd(), "scripts/setup-github-datasource.sh"), "utf8");

    expect(script).not.toContain("set -a");
    expect(script).not.toContain('AUTH="admin:${GRAFANA_ADMIN_PASSWORD}"');
    expect(script).not.toContain('-u "$AUTH"');
    expect(script).not.toContain('-d "$(payload)"');
    expect(script).toContain('--netrc-file "$NETRC_FILE"');
    expect(script).toContain("--data-binary @-");
    expect(script).toMatch(/env -u GRAFANA_ADMIN_PASSWORD -u GITHUB_TOKEN curl/);
  });

  it("is executable, matching setup-sentry-datasource.sh's own mode", () => {
    const mode = statSync(join(process.cwd(), "scripts/setup-github-datasource.sh")).mode;
    // Owner-execute bit (0o100).
    expect(mode & 0o100).not.toBe(0);
  });

  it("remains idempotent (update-vs-create) and preserves the health check after the credential-handling rewrite", () => {
    const script = readFileSync(join(process.cwd(), "scripts/setup-github-datasource.sh"), "utf8");

    expect(script).toContain("api/datasources/uid/github");
    expect(script).toMatch(/-X PUT/);
    expect(script).toMatch(/-X POST/);
    expect(script).toContain("secureJsonData");
    expect(script).toContain("accessToken");
    expect(script).toContain("/health");
  });
});
