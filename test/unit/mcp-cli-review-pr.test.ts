import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFixtureServer,
  createPacketRepo,
  localBranchAnalysisFixture,
  run,
  runAsync,
  startFixtureServer,
} from "./support/mcp-cli-harness";

describe("gittensory-mcp CLI — review-pr", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    await closeFixtureServer();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("composes preflight + slop-risk + pr-text-lint into one passing report", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--commit",
          "feat(mcp): add review-pr command",
          "--body",
          "Composes preflight + slop-risk + lint-pr-text into one report. Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      preflight: { status: string };
      slopRisk?: { slopRisk: number; band: string };
      prTextLint?: { verdict: string; score: number };
      slopRiskError?: string;
      prTextLintError?: string;
    };

    expect(json.overallStatus).toBe("pass");
    expect(json.sections).toEqual([
      { name: "preflight", status: "pass" },
      { name: "slop_risk", status: "pass" },
      { name: "pr_text_lint", status: "pass" },
    ]);
    expect(json.preflight.status).toBe("ready");
    expect(json.slopRisk).toMatchObject({ band: "clean" });
    expect(json.prTextLint).toMatchObject({ verdict: "strong" });
    expect(json.slopRiskError).toBeUndefined();
    expect(json.prTextLintError).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(
      /wallet|hotkey|coldkey|reward|trust score/i,
    );

    const plain = await runAsync(
      [
        "review-pr",
        "--login",
        "JSONbored",
        "--cwd",
        tempDir,
        "--repo",
        "JSONbored/gittensory",
        "--commit",
        "feat(mcp): add review-pr command",
        "--body",
        "Composes preflight + slop-risk + lint-pr-text into one report. Validated with npm test.",
        "--linked-issue",
        "1968",
      ],
      env,
    );
    expect(plain).toMatch(/Pre-PR review: pass/);
    expect(plain).toMatch(/- preflight: pass/);
    expect(plain).toMatch(/- slop_risk: pass/);
    expect(plain).toMatch(/- pr_text_lint: pass/);
    expect(plain).toMatch(/Slop risk: 0 \(clean\)/);
    expect(plain).toMatch(/PR text lint: strong \(score 100\)/);
  });

  it("flags a warn overall status when the PR body is empty (weak lint verdict)", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      prTextLint: { verdict: string };
    };
    expect(json.prTextLint.verdict).toBe("weak");
    expect(
      json.sections.find((section) => section.name === "pr_text_lint"),
    ).toMatchObject({ status: "warn" });
    expect(json.overallStatus).toBe("warn");
  });

  it("maps needs_work preflight to a warning instead of passing (regression)", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({
      localBranchAnalysis: {
        ...localBranchAnalysisFixture(),
        preflight: {
          status: "needs_work",
          findings: [
            {
              code: "missing_test_evidence",
              severity: "warning",
              title: "Missing test evidence",
            },
          ],
        },
      },
    });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--commit",
          "fix(mcp): map preflight status",
          "--body",
          "Fixes #1968\n\nValidated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      preflight: { status: string };
    };

    expect(json.preflight.status).toBe("needs_work");
    expect(
      json.sections.find((section) => section.name === "preflight"),
    ).toMatchObject({ status: "warn" });
    expect(json.overallStatus).toBe("warn");
  });

  it("maps hold preflight to a failing section", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({
      localBranchAnalysis: {
        ...localBranchAnalysisFixture(),
        preflight: {
          status: "hold",
          findings: [
            {
              code: "lane_hold",
              severity: "critical",
              title: "Lane unavailable",
            },
          ],
        },
      },
    });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--commit",
          "fix(mcp): map preflight status",
          "--body",
          "Fixes #1968\n\nValidated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      preflight: { status: string };
    };

    expect(json.preflight.status).toBe("hold");
    expect(
      json.sections.find((section) => section.name === "preflight"),
    ).toMatchObject({ status: "fail" });
    expect(json.overallStatus).toBe("fail");
  });

  it("reads the PR body from --body-file", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer();
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };
    const bodyPath = join(tempDir, "pr-body.md");
    writeFileSync(bodyPath, "Fixes #1968\n\nValidated with npm test.", "utf8");

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--body-file",
          bodyPath,
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as { prTextLint: { verdict: string } };
    expect(json.prTextLint.verdict).toBe("strong");
  });

  it("degrades gracefully when the slop-risk endpoint fails, without losing the other sections", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ slopRiskStatus: 500 });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--body",
          "Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      slopRisk?: unknown;
      slopRiskError?: string;
      prTextLint?: { verdict: string };
    };
    expect(json.slopRisk).toBeUndefined();
    expect(json.slopRiskError).toMatch(/Gittensory API 500/);
    expect(
      json.sections.find((section) => section.name === "slop_risk"),
    ).toMatchObject({ status: "fail" });
    expect(json.overallStatus).toBe("fail");
    // The pr-text-lint section still succeeded even though slop-risk failed.
    expect(json.prTextLint).toMatchObject({ verdict: "strong" });

    const plain = await runAsync(
      [
        "review-pr",
        "--login",
        "JSONbored",
        "--cwd",
        tempDir,
        "--repo",
        "JSONbored/gittensory",
        "--body",
        "Validated with npm test.",
        "--linked-issue",
        "1968",
      ],
      env,
    );
    expect(plain).toMatch(/Slop risk: unavailable \(Gittensory API 500/);
    expect(plain).toMatch(/PR text lint: strong/);
  });

  it("degrades gracefully when the pr-text-lint endpoint fails, without losing the other sections", async () => {
    tempDir = createPacketRepo();
    const url = await startFixtureServer({ prTextLintStatus: 503 });
    const env = {
      GITTENSORY_API_URL: url,
      GITTENSORY_TOKEN: "session-token",
      GITTENSORY_SKIP_NPM_VERSION_CHECK: "true",
    };

    const json = JSON.parse(
      await runAsync(
        [
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          tempDir,
          "--repo",
          "JSONbored/gittensory",
          "--body",
          "Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ],
        env,
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      slopRisk?: { band: string };
      prTextLint?: unknown;
      prTextLintError?: string;
    };
    expect(json.prTextLint).toBeUndefined();
    expect(json.prTextLintError).toMatch(/Gittensory API 503/);
    expect(
      json.sections.find((section) => section.name === "pr_text_lint"),
    ).toMatchObject({ status: "fail" });
    expect(json.overallStatus).toBe("fail");
    expect(json.slopRisk).toMatchObject({ band: "clean" });
  });

  it("requires --login", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "gittensory-cli-"));
    await expect(runAsync(["review-pr", "--cwd", tempDir], {})).rejects.toThrow(
      /Pass --login/,
    );
  });

  it("prints help", () => {
    const help = run(["review-pr", "--help"]);
    expect(help).toMatch(/Usage: gittensory-mcp review-pr/);
    expect(help).toMatch(/gittensory_review_pr_before_push/);
    expect(help).toMatch(/preflight \+ slop-risk \+ PR-text-lint/);
  });

  it("suggests review-pr for close typos", () => {
    expect(() => run(["review-pr-x"])).toThrow(/Did you mean `review-pr`\?/);
  });
});
