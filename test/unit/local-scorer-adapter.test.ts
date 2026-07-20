import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function fixtureCommand(name: string) {
  return `node ${join(process.cwd(), "test/fixtures/local-scorer", name)}`;
}

// Points at the real bundled scorer script the package ships, so this test exercises it end to end.
// Lives here (not exported from lib/local-branch.js) since this test is its only real caller (#6259) --
// production guidance text always uses the intentionally generic, path-redacted referenceScorePreviewExample.
function packagedScorerCommand(kind: "metadata" | "gittensor" = "metadata") {
  const script = kind === "gittensor" ? "gittensor-score-preview.py" : "gittensor-score-preview.mjs";
  const interpreter = kind === "gittensor" ? "python3" : "node";
  return `${interpreter} ${join(process.cwd(), "packages/loopover-mcp/scripts", script)}`;
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
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
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
    const { runExternalScorePreview, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, undefined);
    expect(result).toMatchObject({ ok: false, code: "missing_scorer_command", fallbackMode: "metadata_only" });
    const guidance = setupGuidanceForLocalScorer(result).join(" ");
    expect(guidance).toMatch(/GITTENSOR_SCORE_PREVIEW_CMD/);
    expect(guidance).not.toMatch(process.cwd());
  });

  it("handles scorer timeouts without crashing analysis", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    previousTimeout = process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "200";
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-timeout.mjs"));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("timeout");
    expect(result.fallbackMode).toBe("metadata_only");
  });

  it("handles malformed scorer JSON and non-zero exits", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const malformed = runExternalScorePreview(metadata, fixtureCommand("scorer-malformed.mjs"));
    expect(malformed).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });

    const failing = runExternalScorePreview(metadata, fixtureCommand("scorer-nonzero.mjs"));
    expect(failing).toMatchObject({ ok: false, code: "non_zero_exit", fallbackMode: "metadata_only" });
    expect(failing.exitCode).toBe(7);
  });

  it("falls back to metadata-only scorer output and keeps source upload disabled", async () => {
    const { buildBranchAnalysisPayload, collectLocalBranchMetadata } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const payload = buildBranchAnalysisPayload({
      cwd: process.cwd(),
      repoFullName: "JSONbored/loopover",
      baseRef: "HEAD",
      login: "local",
      scorePreviewCommand: fixtureCommand("scorer-nonzero.mjs"),
    });
    expect(payload.localScorer).toMatchObject({ mode: "metadata_only" });
    expect(payload.localScorerStatus.ok).toBe(false);
    expect(payload).not.toHaveProperty("repoRoot");
    expect(JSON.stringify(payload)).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);

    process.env.LOOPOVER_UPLOAD_SOURCE = "true";
    expect(() => collectLocalBranchMetadata({ cwd: process.cwd(), repoFullName: "JSONbored/loopover", login: "local" })).toThrow(/not supported/);
    delete process.env.LOOPOVER_UPLOAD_SOURCE;
  });

  it("runs the packaged reference scorer against metadata only", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, packagedScorerCommand("metadata"));
    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      sourceTokenScore: expect.any(Number),
      totalTokenScore: expect.any(Number),
    });
  });

  it("treats a non-object (but valid JSON) scorer stdout as malformed", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-non-object-json.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json", reason: "External scorer stdout must be a JSON object." });
  });

  it("treats a valid JSON object missing both score fields as malformed", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-missing-scores.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json", reason: "External scorer JSON must include sourceTokenScore or totalTokenScore." });
  });

  it("classifies a non-zero exit as non_zero_exit (not malformed_json) when its stdout is valid, scored JSON", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-scored-json-then-fail.mjs"));
    expect(result).toMatchObject({ ok: false, code: "non_zero_exit", exitCode: 1 });
  });

  it("classifies a non-zero exit with valid-but-scoreless JSON stdout as malformed_json", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-scoreless-json-then-fail.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json" });
  });

  it("classifies a non-zero exit with stderr output, truncating a long snippet in the guidance", async () => {
    const { runExternalScorePreview, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-stderr-then-fail.mjs"));
    expect(result).toMatchObject({ ok: false, code: "non_zero_exit", exitCode: 2 });
    expect(result.stderr).toBeTruthy();
    const guidanceLines = setupGuidanceForLocalScorer(result);
    const stderrLine = guidanceLines.find((line) => line.startsWith("Scorer stderr:"));
    expect(stderrLine).toMatch(/^Scorer stderr: crash detail/);
    expect(stderrLine?.endsWith("...")).toBe(true); // truncateText's 160-char ellipsis marker
  });

  it("setupGuidanceForLocalScorer returns no guidance for a successful status", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(setupGuidanceForLocalScorer({ ok: true })).toEqual([]);
  });

  it("buildBranchAnalysisPayload uses the real external_command scorer output when the scorer succeeds", async () => {
    const { buildBranchAnalysisPayload } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const payload = buildBranchAnalysisPayload({
      cwd: process.cwd(),
      repoFullName: "JSONbored/loopover",
      baseRef: "HEAD",
      login: "local",
      scorePreviewCommand: fixtureCommand("scorer-success.mjs"),
    });
    expect(payload.localScorer).toMatchObject({ mode: "external_command", sourceTokenScore: 42, totalTokenScore: 50 });
    expect(payload.localScorerStatus.ok).toBe(true);
  });

  it("threads metadata.cwd into the scorer input's repoRoot when repoRoot itself is omitted", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    // Neither field affects the return value directly -- this just proves the call doesn't throw and
    // still succeeds when metadata carries `cwd` instead of the usual explicit `repoRoot`.
    const result = runExternalScorePreview({ repoFullName: "acme/widgets", cwd: process.cwd() }, fixtureCommand("scorer-success.mjs"));
    expect(result.ok).toBe(true);
  });

  it("redactScorerCommand coerces a nullish command and handles a quote-only command with no parseable parts", async () => {
    const { redactScorerCommand } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(redactScorerCommand(undefined)).toBe("");
    expect(redactScorerCommand(null)).toBe("");
    // A lone unterminated quote matches neither of splitCommand's regex alternatives, so parts is empty
    // and the interpreter falls back to the literal "command" label.
    expect(redactScorerCommand('"')).toBe("<configured-scorer-command>");
  });

  it("sanitizeLocalScorerStatus passes a nullish or non-object status through untouched", async () => {
    const { sanitizeLocalScorerStatus } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(sanitizeLocalScorerStatus(null)).toBeNull();
    expect(sanitizeLocalScorerStatus(undefined)).toBeUndefined();
  });

  it("redacts local paths from scorer diagnostics and setup guidance", async () => {
    const { probeLocalScorer, redactLocalPath, redactScorerCommand, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");

    previousGittensorRoot = process.env.GITTENSOR_ROOT;
    previousCommand = process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    process.env.GITTENSOR_ROOT = "/secret/home/user/gittensor";
    process.env.GITTENSOR_SCORE_PREVIEW_CMD = `/secret/opt/tools/node /secret/home/user/loopover-mcp/scripts/gittensor-score-preview.mjs`;

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
    expect(guidance).toMatch(/node_modules\/@loopover\/mcp\/scripts\//);

    const probe = probeLocalScorer(process.env.GITTENSOR_SCORE_PREVIEW_CMD);
    expect(JSON.stringify(probe)).not.toMatch(/\/secret\/home\/user/);
  });

  it("resolveScorePreviewCommand returns undefined when neither an explicit command nor the env var is set", async () => {
    const { resolveScorePreviewCommand } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    previousCommand = process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    delete process.env.GITTENSOR_SCORE_PREVIEW_CMD;
    expect(resolveScorePreviewCommand()).toBeUndefined();
    expect(resolveScorePreviewCommand({ scorePreviewCommand: "   " })).toBeUndefined();
  });

  it("treats a whitespace-only scorer command as empty, distinct from a missing one", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, "   ");
    expect(result).toMatchObject({ ok: false, code: "empty_scorer_command" });
  });

  it("redactScorerCommand falls back to a generic label for a command with no recognizable script extension", async () => {
    const { redactScorerCommand } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    expect(redactScorerCommand("some-native-scorer-binary --flag")).toBe("<configured-scorer-command>");
    expect(redactScorerCommand("")).toBe("");
  });

  it("classifies a scorer that writes junk to stdout before exiting non-zero as malformed_json (not non_zero_exit)", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-stdout-then-fail.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json", fallbackMode: "metadata_only" });
  });

  it("classifies unserializable scorer metadata (circular reference) via the message-based JSON check", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const circular: Record<string, unknown> = { repoFullName: "acme/widgets" };
    circular.self = circular;
    // JSON.stringify(circular) throws before execFileSync ever runs, so this exercises the thrown
    // error's own .message (not stdout/stderr) containing "JSON".
    const result = runExternalScorePreview(circular, fixtureCommand("scorer-success.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json" });
  });

  it("classifies stderr from a process killed by a non-SIGTERM signal as malformed_json", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, fixtureCommand("scorer-stderr-then-sigkill.mjs"));
    expect(result).toMatchObject({ ok: false, code: "malformed_json" });
  });

  it("classifies a scorer command that fails to spawn at all (command not found) as scorer_failed", async () => {
    const { runExternalScorePreview } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    const result = runExternalScorePreview(metadata, "this-command-does-not-exist-loopover-7329");
    // No stdout/stderr/numeric exit code -- a spawn (ENOENT) failure falls through every classification
    // in classifyScorerExecFailure to its final scorer_failed fallback.
    expect(result).toMatchObject({ ok: false, code: "scorer_failed" });
    expect(result.reason).toMatch(/ENOENT|this-command-does-not-exist-loopover-7329/);
  });

  it("surfaces setup guidance tailored to every non-missing-command failure code", async () => {
    const { runExternalScorePreview, setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");

    const empty = setupGuidanceForLocalScorer(runExternalScorePreview(metadata, "   ")).join(" ");
    expect(empty).toMatch(/is set but empty/);

    previousTimeout = process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS;
    process.env.GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS = "200";
    const timeout = setupGuidanceForLocalScorer(runExternalScorePreview(metadata, fixtureCommand("scorer-timeout.mjs"))).join(" ");
    expect(timeout).toMatch(/exceeded 200ms/);

    const malformed = setupGuidanceForLocalScorer(runExternalScorePreview(metadata, fixtureCommand("scorer-malformed.mjs"))).join(" ");
    expect(malformed).toMatch(/sourceTokenScore\/totalTokenScore/);

    const nonZero = setupGuidanceForLocalScorer(runExternalScorePreview(metadata, fixtureCommand("scorer-nonzero.mjs"))).join(" ");
    expect(nonZero).toMatch(/non-zero status/);
    expect(nonZero).toMatch(/Exit code: 7/);

    const unrecognized = setupGuidanceForLocalScorer({ ok: false, code: "some_future_unrecognized_code", reason: "a new failure mode" }).join(" ");
    expect(unrecognized).toMatch(/reads branch metadata JSON from stdin/);
    expect(unrecognized).toMatch(/Last scorer error: a new failure mode/);
  });

  it("infers a failure code from a reason string when the status carries no explicit code", async () => {
    const { setupGuidanceForLocalScorer } = await import("../../packages/loopover-mcp/lib/local-branch.js");
    // No `code` field on any of these -- setupGuidanceForLocalScorer's `code ?? inferScorerCode(reason)`
    // fallback only runs inferScorerCode when code itself is absent, exercising each of its if-branches.
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "missing_scorer_command: unset" }).join(" ")).toMatch(/GITTENSOR_SCORE_PREVIEW_CMD/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "empty_scorer_command: blank" }).join(" ")).toMatch(/is set but empty/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "the process timed out (ETIMEDOUT)" }).join(" ")).toMatch(/exceeded/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "stdout was not valid JSON" }).join(" ")).toMatch(/sourceTokenScore\/totalTokenScore/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "exited with status 12" }).join(" ")).toMatch(/non-zero status/);
    expect(setupGuidanceForLocalScorer({ ok: false, reason: "an entirely unclassified failure" }).join(" ")).toMatch(/reads branch metadata JSON from stdin/);
    expect(setupGuidanceForLocalScorer({ ok: false }).join(" ")).toMatch(/reads branch metadata JSON from stdin/);
  });
});
