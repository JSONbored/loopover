import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// TS5097: keep the .ts specifier out of a literal import() position (same indirection as the template).
const BIN_MODULE = "../../packages/loopover-mcp/bin/loopover-mcp.ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeFixtureServer,
  createPacketRepo,
  localBranchAnalysisFixture,
  run,
  startFixtureServer,
} from "./support/mcp-cli-harness";

// #8587: review-pr cases run in-process through the bin's exported runCli (the same dispatcher +
// presentation code the subprocess ran), with stdout captured. The fixture server starts once BEFORE
// the dynamic import because the bin reads LOOPOVER_API_URL at module load; per-test response
// overrides mutate `fixtureOptions`, which the harness reads per request. Only the typo-suggestion
// case still spawns a real subprocess (CLI-level argv error).
type BinModule = { runCli: (args: string[]) => Promise<number | void> };

const fixtureOptions: NonNullable<Parameters<typeof startFixtureServer>[0]> =
  {};
let mod: BinModule;
let configDir = "";

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "loopover-review-pr-inprocess-"));
  const apiUrl = await startFixtureServer(fixtureOptions);
  process.env.LOOPOVER_API_URL = apiUrl;
  process.env.LOOPOVER_TOKEN = "session-token";
  process.env.LOOPOVER_API_TIMEOUT_MS = "2000";
  process.env.LOOPOVER_CONFIG_DIR = configDir;
  process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK = "1";
  mod = (await import(BIN_MODULE)) as unknown as BinModule;
}, 120_000);

afterAll(async () => {
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  delete process.env.LOOPOVER_API_URL;
  delete process.env.LOOPOVER_TOKEN;
  delete process.env.LOOPOVER_API_TIMEOUT_MS;
  delete process.env.LOOPOVER_CONFIG_DIR;
  delete process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK;
});

async function captureStdout(
  fn: () => Promise<number | void>,
): Promise<string> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return chunks.join("");
}

describe("loopover-mcp CLI — review-pr", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
    delete fixtureOptions.localBranchAnalysis;
    delete fixtureOptions.slopRiskStatus;
    delete fixtureOptions.prTextLintStatus;
  });

  it("composes preflight + slop-risk + pr-text-lint into one passing report", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--commit",
          "feat(mcp): add review-pr command",
          "--body",
          "Composes preflight + slop-risk + lint-pr-text into one report. Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ]),
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

    const plain = await captureStdout(() =>
      mod.runCli([
        "review-pr",
        "--login",
        "JSONbored",
        "--cwd",
        repoDir,
        "--repo",
        "JSONbored/loopover",
        "--commit",
        "feat(mcp): add review-pr command",
        "--body",
        "Composes preflight + slop-risk + lint-pr-text into one report. Validated with npm test.",
        "--linked-issue",
        "1968",
      ]),
    );
    expect(plain).toMatch(/Pre-PR review: pass/);
    expect(plain).toMatch(/- preflight: pass/);
    expect(plain).toMatch(/- slop_risk: pass/);
    expect(plain).toMatch(/- pr_text_lint: pass/);
    expect(plain).toMatch(/Slop risk: clean/);
    expect(plain).toMatch(/PR text lint: strong \(score 100\)/);
  });

  it("flags a warn overall status when the PR body is empty (weak lint verdict)", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--json",
        ]),
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
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    fixtureOptions.localBranchAnalysis = {
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
    };

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--commit",
          "fix(mcp): map preflight status",
          "--body",
          "Fixes #1968\n\nValidated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ]),
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
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    fixtureOptions.localBranchAnalysis = {
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
    };

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--commit",
          "fix(mcp): map preflight status",
          "--body",
          "Fixes #1968\n\nValidated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ]),
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
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    const bodyPath = join(repoDir, "pr-body.md");
    writeFileSync(bodyPath, "Fixes #1968\n\nValidated with npm test.", "utf8");

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--body-file",
          bodyPath,
          "--linked-issue",
          "1968",
          "--json",
        ]),
      ),
    ) as { prTextLint: { verdict: string } };
    expect(json.prTextLint.verdict).toBe("strong");
  });

  it("degrades gracefully when the slop-risk endpoint fails, without losing the other sections", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    fixtureOptions.slopRiskStatus = 500;

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--body",
          "Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ]),
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      slopRisk?: unknown;
      slopRiskError?: string;
      prTextLint?: { verdict: string };
    };
    expect(json.slopRisk).toBeUndefined();
    expect(json.slopRiskError).toMatch(/LoopOver API 500/);
    expect(
      json.sections.find((section) => section.name === "slop_risk"),
    ).toMatchObject({ status: "fail" });
    expect(json.overallStatus).toBe("fail");
    // The pr-text-lint section still succeeded even though slop-risk failed.
    expect(json.prTextLint).toMatchObject({ verdict: "strong" });

    const plain = await captureStdout(() =>
      mod.runCli([
        "review-pr",
        "--login",
        "JSONbored",
        "--cwd",
        repoDir,
        "--repo",
        "JSONbored/loopover",
        "--body",
        "Validated with npm test.",
        "--linked-issue",
        "1968",
      ]),
    );
    expect(plain).toMatch(/Slop risk: unavailable \(LoopOver API 500/);
    expect(plain).toMatch(/PR text lint: strong/);
  });

  it("degrades gracefully when the pr-text-lint endpoint fails, without losing the other sections", async () => {
    const repoDir = createPacketRepo();
    tempDir = repoDir;
    fixtureOptions.prTextLintStatus = 503;

    const json = JSON.parse(
      await captureStdout(() =>
        mod.runCli([
          "review-pr",
          "--login",
          "JSONbored",
          "--cwd",
          repoDir,
          "--repo",
          "JSONbored/loopover",
          "--body",
          "Validated with npm test.",
          "--linked-issue",
          "1968",
          "--json",
        ]),
      ),
    ) as {
      overallStatus: string;
      sections: Array<{ name: string; status: string }>;
      slopRisk?: { band: string };
      prTextLint?: unknown;
      prTextLintError?: string;
    };
    expect(json.prTextLint).toBeUndefined();
    expect(json.prTextLintError).toMatch(/LoopOver API 503/);
    expect(
      json.sections.find((section) => section.name === "pr_text_lint"),
    ).toMatchObject({ status: "fail" });
    expect(json.overallStatus).toBe("fail");
    expect(json.slopRisk).toMatchObject({ band: "clean" });
  });

  it("requires --login", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "loopover-cli-"));
    await expect(mod.runCli(["review-pr", "--cwd", tempDir])).rejects.toThrow(
      /Pass --login/,
    );
  });

  it("prints help", async () => {
    const help = await captureStdout(() => mod.runCli(["review-pr", "--help"]));
    expect(help).toMatch(/Usage: loopover-mcp review-pr/);
    expect(help).toMatch(/loopover_review_pr_before_push/);
    expect(help).toMatch(/preflight \+ slop-risk \+ PR-text-lint/);
  });

  it("prints help for a bare `help` positional too, not a --login error (#6257)", async () => {
    const help = await captureStdout(() => mod.runCli(["review-pr", "help"]));
    expect(help).toMatch(/Usage: loopover-mcp review-pr/);
    expect(help).not.toMatch(/Pass --login/);
  });

  it("suggests review-pr for close typos", () => {
    expect(() => run(["review-pr-x"])).toThrow(/Did you mean `review-pr`\?/);
  });
});
