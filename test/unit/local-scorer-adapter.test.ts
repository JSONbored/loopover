import { afterEach, describe, expect, it } from "vitest";

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

  afterEach(() => {
    if (previousCommand === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    else process.env.GITTENSOR_SCORE_PREVIEW_CMD = previousCommand;
    if (previousTimeout === undefined) delete process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    else process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = previousTimeout;
  });

  it("returns structured success output from a working scorer command", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const command =
      'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c);process.stdin.on(\'end\',()=>{const m=JSON.parse(d);process.stdout.write(JSON.stringify({sourceTokenScore:42,totalTokenScore:50,sourceLines:40,testTokenScore:8}))})"';
    const result = runExternalScorePreview(metadata, command);
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
    expect(setupGuidanceForLocalScorer(result).join(" ")).toMatch(/GITTENSOR_SCORE_PREVIEW_CMD/);
  });

  it("handles scorer timeouts without crashing analysis", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    previousTimeout = process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "200";
    const result = runExternalScorePreview(metadata, process.platform === "win32" ? "ping -n 3 127.0.0.1" : "sleep 2");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");
    expect(result.fallbackMode).toBe("metadata_only");
  });

  it("handles malformed scorer JSON and non-zero exits", async () => {
    // @ts-expect-error package helper is plain JS because the local wrapper ships as a Node bin package.
    const { runExternalScorePreview } = await import("../../packages/gittensory-mcp/lib/local-branch.js");
    const malformed = runExternalScorePreview(metadata, process.platform === "win32" ? "cmd /c echo not-json" : "echo not-json");
    expect(malformed).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });

    const failing = runExternalScorePreview(metadata, process.platform === "win32" ? "cmd /c exit 7" : "sh -c 'exit 7'");
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
      scorePreviewCommand: process.platform === "win32" ? "cmd /c exit 2" : "sh -c 'exit 2'",
    });
    expect(payload.localScorer).toMatchObject({ mode: "metadata_only" });
    expect(payload.localScorerStatus.ok).toBe(false);
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
});
