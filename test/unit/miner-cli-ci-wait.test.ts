import { describe, expect, it, vi } from "vitest";
import { parseCiWaitArgs, runCiWait } from "../../packages/gittensory-miner/lib/ci-wait.js";
import * as ciPoller from "../../packages/gittensory-miner/lib/ci-poller.js";

describe("gittensory-miner ci wait command", () => {
  it("parseCiWaitArgs requires owner/repo and pr number", () => {
    expect(parseCiWaitArgs([])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner ci wait"),
    });
    expect(parseCiWaitArgs(["acme/widgets"])).toEqual({
      error: expect.stringContaining("Usage: gittensory-miner ci wait"),
    });
    expect(parseCiWaitArgs(["acme/widgets", "0"])).toEqual({
      error: "PR number must be a positive integer.",
    });
    expect(parseCiWaitArgs(["acme/widgets", "42", "--json"])).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 42,
      json: true,
      maxAttempts: undefined,
      minIntervalMs: undefined,
      maxIntervalMs: undefined,
    });
  });

  it("parseCiWaitArgs validates polling option flags", () => {
    expect(parseCiWaitArgs(["acme/widgets", "42", "--max-attempts"])).toEqual({
      error: "Missing value for --max-attempts.",
    });
    expect(parseCiWaitArgs(["acme/widgets", "42", "--max-attempts", "0"])).toEqual({
      error: "Invalid value for --max-attempts: must be a positive integer.",
    });
    expect(parseCiWaitArgs(["acme/widgets", "42", "--min-interval-ms", "2500"])).toEqual({
      repoFullName: "acme/widgets",
      prNumber: 42,
      json: false,
      maxAttempts: undefined,
      minIntervalMs: 2500,
      maxIntervalMs: undefined,
    });
  });

  it("parseCiWaitArgs rejects unknown flags", () => {
    expect(parseCiWaitArgs(["acme/widgets", "42", "--wat"])).toEqual({
      error: "Unknown option: --wat",
    });
  });

  it("runCiWait returns exit code 2 when no GitHub token is configured", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runCiWait(["acme/widgets", "42"], { env: {} }),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Missing GitHub token: set GITHUB_TOKEN or GITTENSOR_MINER_GITHUB_TOKEN.",
    );
  });

  it("runCiWait prints JSON and exits 0 when CI succeeds", async () => {
    vi.spyOn(ciPoller, "pollCheckRuns").mockResolvedValue({
      conclusion: "success",
      checks: [{ name: "validate", status: "completed", conclusion: "success", detailsUrl: null, startedAt: null, completedAt: null }],
      headSha: "abc1234567",
      attempts: 1,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      runCiWait(["acme/widgets", "42", "--json", "--max-attempts", "3"], {
        env: { GITHUB_TOKEN: "github-token" },
      }),
    ).resolves.toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"conclusion":"success"'),
    );
    expect(ciPoller.pollCheckRuns).toHaveBeenCalledWith("acme/widgets", 42, {
      githubToken: "github-token",
      maxAttempts: 3,
    });
  });

  it("runCiWait returns exit code 2 for invalid polling flags", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runCiWait(["acme/widgets", "42", "--max-attempts", "nope"], {
        env: { GITHUB_TOKEN: "github-token" },
      }),
    ).resolves.toBe(2);
    expect(error).toHaveBeenCalledWith(
      "Invalid value for --max-attempts: must be a positive integer.",
    );
  });

  it("runCiWait exits 1 when CI fails", async () => {
    vi.spyOn(ciPoller, "pollCheckRuns").mockResolvedValue({
      conclusion: "failure",
      checks: [],
      headSha: "deadbeef",
      attempts: 2,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      runCiWait(["acme/widgets", "7"], {
        env: { GITTENSOR_MINER_GITHUB_TOKEN: "github-token" },
      }),
    ).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("CI failure for acme/widgets#7"),
    );
  });
});
