import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function fixtureCommand(name: string) {
  return `node ${join(process.cwd(), "test/fixtures/local-scorer", name)}`;
}

describe("local scorer adapter", () => {
  const metadata = {
    repoFullName: "entrius/allways-ui",
    branchName: "fix-cache",
    repoRoot: process.cwd(),
    changedFiles: [
      { path: "src/cache.ts", additions: 12, deletions: 2, status: "modified" },
      { path: "test/cache.test.ts", additions: 8, deletions: 0, status: "added" },
    ],
  };

  let previousCommand: string | undefined;
  let previousTimeout: string | undefined;
  let previousGittensorRoot: string | undefined;

  afterEach(() => {
    if (previousCommand === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    else process.env.GITTENSOR_SCORE_PREVIEW_CMD = previousCommand;
    if (previousTimeout === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    else process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = previousTimeout;
    if (previousGittensorRoot === undefined) delete process.env.GITTENSOR_ROOT;
    else process.env.GITTENSOR_ROOT = previousGittensorRoot;
  });

  it("returns structured success output from a working scorer command", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-success.mjs"));
    expect(result).toMatchObject({
      ok: true,
      code: "success",
      fallbackMode: "external_command",
      payload: { sourceTokenScore: 42, totalTokenScore: 50 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports missing scorer command with setup guidance", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview, setupGuidanceForLocalScorer } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, undefined);
    expect(result).toMatchObject({ ok: false, code: "missing_scorer_command", fallbackMode: "metadata_only" });
    const guidance = setupGuidanceForLocalScorer(result).join(" ");
    expect(guidance).toMatch(/GITTENSOR_SCORE_PREVIEW_CMD/);
    expect(guidance).not.toMatch(process.cwd());
  });

  it("handles scorer timeouts without crashing analysis", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    previousTimeout = process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "200";
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-timeout.mjs"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");
    expect(result.fallbackMode).toBe("metadata_only");
  });

  it("handles malformed scorer JSON and non-zero exits", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const malformed = runExternalScorePreview(metadata, fixtureCommand("scorer-malformed.mjs"));
    expect(malformed).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });

    const failing = runExternalScorePreview(metadata, fixtureCommand("scorer-nonzero.mjs"));
    expect(failing).toMatchObject({ ok: false, code: "non_zero_exit", fallbackMode: "metadata_only" });
    expect(failing.exitCode).toBe(7);
  });

  it("falls back to metadata-only scorer output and keeps source upload disabled", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { buildBranchAnalysisPayload, collectLocalBranchMetadata } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const payload = buildBranchAnalysisPayload({
      cwd: process.cwd(),
      repoFullName: "JSONbored/gittensory",
      baseRef: "HEAD",
      login: "local",
      scorePreviewCommand: fixtureCommand("scorer-nonzero.mjs"),
    });
    expect(payload.localScorer).toMatchObject({ mode: "metadata_only" });
    expect(payload.localScorerStatus.ok).toBe(false);
    expect(payload).not.toHaveProperty("repoRoot");
    expect(JSON.stringify(payload)).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);

    process.env.GITTENSORY_UPLOAD_SOURCE = "true";
    expect(() => collectLocalBranchMetadata({ cwd: process.cwd(), repoFullName: "JSONbored/gittensory", login: "local" })).toThrow(/not supported/);
    delete process.env.GITTENSORY_UPLOAD_SOURCE;
  });

  it("runs the packaged reference scorer against metadata only", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { referenceScorePreviewCommand, runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, referenceScorePreviewCommand("metadata"));
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      sourceTokenScore: expect.any(Number),
      totalTokenScore: expect.any(Number),
    });
  });

  it("redacts local paths from scorer diagnostics and setup guidance", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { probeLocalScorer, redactLocalPath, redactScorerCommand, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer } = await import("../../packages/gittensory-mcp/lib/local-branch.js");

    previousGittensorRoot = process.env.GITTENSOR_ROOT;
    previousCommand = process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    process.env.GITTENSOR_ROOT = "/secret/home/user/gittensor";
    process.env.GITTENSOR_SCORE_PREVIEW_CMD = `/secret/opt/tools/node /secret/home/user/gittensory-mcp/scripts/gittensor-score-preview.mjs`;

    expect(redactLocalPath("/secret/home/user/gittensor")).not.toContain("/secret/home/user");
    expect(redactScorerCommand(process.env.GITTENSOR_SCORE_PREVIEW_CMD)).toBe("node <scorer-script>/gittensor-score-preview.mjs");

    const status = sanitizeLocalScorerStatus({
      ok: false,
      code: "scorer_failed",
      reason: "failed under /secret/home/user/gittensor",
      stderr: "/secret/home/user/output.txt",
      scorerCommand: process.env.GITTENSOR_SCORE_PREVIEW_CMD,
    });
    expect(JSON.stringify(status)).not.toMatch(/\/secret\/home\/user/);

    const guidance = setupGuidanceForLocalScorer({ ok: false, code: "missing_scorer_command" }).join("\n");
    expect(guidance).not.toMatch(/\/secret\/home\/user/);
    expect(guidance).toMatch(/node_modules\/@jsonbored\/gittensory-mcp\/scripts\//);

    const probe = probeLocalScorer(process.env.GITTENSOR_SCORE_PREVIEW_CMD);
    expect(JSON.stringify(probe)).not.toMatch(/\/secret\/home\/user/);
  });
});
