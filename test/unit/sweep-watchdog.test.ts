import { afterEach, describe, expect, it, vi } from "vitest";
import { isSweepStale, isSweepWatchdogEnabled, runSweepLivenessWatchdog, SWEEP_STALENESS_THRESHOLD_MS } from "../../src/review/sweep-watchdog";
import { markPullRequestsRegated, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

describe("isSweepWatchdogEnabled — default OFF, truthy convention", () => {
  it("matches the codebase's shared truthy-string convention", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isSweepWatchdogEnabled({ GITTENSORY_SWEEP_WATCHDOG: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isSweepWatchdogEnabled({ GITTENSORY_SWEEP_WATCHDOG: on })).toBe(true);
  });
});

describe("isSweepStale (#audit-sweep-fanout-isolation follow-up)", () => {
  const NOW = Date.parse("2026-07-06T12:00:00.000Z");

  it("a repo with NO open PRs is never stale, regardless of the marker", () => {
    expect(isSweepStale({ openPullRequestCount: 0, lastRegatedAt: null, nowMs: NOW })).toBe(false);
    expect(isSweepStale({ openPullRequestCount: 0, lastRegatedAt: "2020-01-01T00:00:00.000Z", nowMs: NOW })).toBe(false);
  });

  it("a repo with open PRs and NO regate marker at all is stale (never regated)", () => {
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: null, nowMs: NOW })).toBe(true);
  });

  it("a repo with open PRs and an unparseable marker is stale (fails toward stale, not silently healthy)", () => {
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: "not-a-date", nowMs: NOW })).toBe(true);
  });

  it("a repo regated within the staleness window is NOT stale", () => {
    const lastRegatedAt = new Date(NOW - (SWEEP_STALENESS_THRESHOLD_MS - 1000)).toISOString();
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW })).toBe(false);
  });

  it("a repo NOT regated within the staleness window IS stale", () => {
    const lastRegatedAt = new Date(NOW - (SWEEP_STALENESS_THRESHOLD_MS + 1000)).toISOString();
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW })).toBe(true);
  });
});

describe("runSweepLivenessWatchdog (#audit-sweep-fanout-isolation follow-up)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-enqueues a targeted sweep + logs sweep_liveness_stale for an installed repo with open PRs whose marker never advanced", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9300);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/stale-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/stale-repo", installationId: 9300, openPullRequestCount: 1 })]);
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/stale-repo", installationId: 9300 })]);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("sweep_liveness_stale") && line.includes("owner/stale-repo"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "sweep_liveness_stale", repository: "owner/stale-repo" });
  });

  it("REGRESSION: reports a finite ageMs for a repo that WAS regated once but fell outside the staleness window (not just a never-regated null marker)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = new Date("2026-07-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "aged-repo", full_name: "owner/aged-repo", private: false, owner: { login: "owner" } }, 9306);
    await upsertRepositorySettings(env, { repoFullName: "owner/aged-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/aged-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await markPullRequestsRegated(env, "owner/aged-repo", [1]); // stamps last_regated_at = start
    vi.setSystemTime(new Date(start.getTime() + SWEEP_STALENESS_THRESHOLD_MS + 60_000)); // now outside the window

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/aged-repo", lastRegatedAt: start.toISOString(), ageMs: SWEEP_STALENESS_THRESHOLD_MS + 60_000 })]);
    expect(Number.isFinite(found[0]?.ageMs)).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/aged-repo" })]);
  }, 60_000);

  it("watches an ALLOWLISTED (GITTENSORY_REVIEW_REPOS) installed repo even with no autonomy configured, and skips a plain repo that is neither allowlisted nor agent-configured", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      GITTENSORY_REVIEW_REPOS: "owner/allowlisted-repo",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    // Allowlisted + installed, but NO autonomy config at all — isConvergenceRepoAllowed alone must still watch it.
    await upsertRepositoryFromGitHub(env, { name: "allowlisted-repo", full_name: "owner/allowlisted-repo", private: false, owner: { login: "owner" } }, 9307);
    await upsertPullRequestFromGitHub(env, "owner/allowlisted-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    // Neither allowlisted nor agent-configured — must be excluded entirely, regardless of its own staleness.
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } }, 9308);
    await upsertPullRequestFromGitHub(env, "owner/plain-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    const found = await runSweepLivenessWatchdog(env);

    expect(found.map((f) => f.repoFullName)).toEqual(["owner/allowlisted-repo"]);
    expect(sent).toEqual([expect.objectContaining({ repoFullName: "owner/allowlisted-repo", installationId: 9307 })]);
  });

  it("fails safe at the top level: a total scan failure (e.g. listRepositories throwing) is logged and returns an empty result instead of throwing", async () => {
    const env = createTestEnv();
    const listSpy = vi.spyOn(repositoriesModule, "listRepositories").mockRejectedValueOnce(new Error("D1 unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runSweepLivenessWatchdog(env)).resolves.toEqual([]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_error"))).toBe(true);
    listSpy.mockRestore();
  });

  it("does NOT re-enqueue a repo regated within the staleness window", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "fresh-repo", full_name: "owner/fresh-repo", private: false, owner: { login: "owner" } }, 9301);
    await upsertRepositorySettings(env, { repoFullName: "owner/fresh-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/fresh-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await markPullRequestsRegated(env, "owner/fresh-repo", [1]);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does NOT flag a repo with zero open PRs, even with no regate marker at all", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "quiet-repo", full_name: "owner/quiet-repo", private: false, owner: { login: "owner" } }, 9302);
    await upsertRepositorySettings(env, { repoFullName: "owner/quiet-repo", autonomy: { merge: "auto" } });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("never flags a registered-but-uninstalled repo (#sweep-uninstalled-budget-waste) — no per-PR fan-out could ever help it", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "owner/no-install", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } }); // no installation id
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/no-install", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("fails safe per-repo: a load error on one repo is logged and the scan continues to the next repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "erroring-repo", full_name: "owner/erroring-repo", private: false, owner: { login: "owner" } }, 9303);
    await upsertRepositorySettings(env, { repoFullName: "owner/erroring-repo", autonomy: { merge: "auto" } });
    await upsertRepositoryFromGitHub(env, { name: "ok-repo", full_name: "owner/ok-repo", private: false, owner: { login: "owner" } }, 9304);
    await upsertRepositorySettings(env, { repoFullName: "owner/ok-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/erroring-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/ok-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const countSpy = vi.spyOn(repositoriesModule, "countOpenPullRequests").mockImplementation(async (_env, fullName) => {
      if (fullName === "owner/erroring-repo") throw new Error("D1 read error");
      return 1;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/ok-repo" })]); // erroring-repo's failure did not block ok-repo
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_repo_error") && String(call[0]).includes("owner/erroring-repo"))).toBe(true);
    countSpy.mockRestore();
  });

  it("logs sweep_liveness_reenqueue_failed and does not throw when the re-enqueue send itself fails", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue send error");
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "send-fails", full_name: "owner/send-fails", private: false, owner: { login: "owner" } }, 9305);
    await upsertRepositorySettings(env, { repoFullName: "owner/send-fails", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/send-fails", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runSweepLivenessWatchdog(env)).resolves.toEqual([expect.objectContaining({ repoFullName: "owner/send-fails" })]); // still reported as found even though the re-enqueue itself failed
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_reenqueue_failed") && String(call[0]).includes("owner/send-fails"))).toBe(true);
  });
});
