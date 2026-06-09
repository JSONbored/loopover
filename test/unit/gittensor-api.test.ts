import { afterEach, describe, expect, it, vi } from "vitest";
import { contributorRepoStatsFromGittensor, fetchGittensorContributorSnapshot, fetchOfficialGittensorMiner } from "../../src/gittensor/api";

describe("Gittensor API contributor snapshots", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses Gittensor API miner data as the authoritative registered contribution source", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/miners")) {
        return Response.json([
          {
            uid: 29,
            hotkey: "hotkey",
            githubUsername: "JSONbored",
            githubId: "49853598",
            totalPrs: 63,
            totalMergedPrs: 46,
            totalOpenPrs: 9,
            totalClosedPrs: 8,
            totalOpenIssues: 44,
            totalClosedIssues: 4,
            totalSolvedIssues: 1,
            totalValidSolvedIssues: 1,
            isEligible: true,
            credibility: 1,
            eligibleRepoCount: 1,
            evaluatedAt: "2026-05-21T14:56:20.782Z",
          },
        ]);
      }
      if (url.endsWith("/miners/49853598")) {
        return Response.json({
          repositories: [
            {
              repositoryFullName: "we-promise/sure",
              totalPrs: "47",
              totalMergedPrs: "37",
              totalOpenPrs: "6",
              totalClosedPrs: "4",
              totalOpenIssues: "0",
              totalClosedIssues: "0",
              isEligible: true,
              credibility: "0.902439",
              totalScore: "43.094808",
            },
            {
              repositoryFullName: "jsonbored/awesome-claude",
              totalPrs: "0",
              totalMergedPrs: "0",
              totalOpenPrs: "0",
              totalClosedPrs: "0",
              totalOpenIssues: "42",
              totalClosedIssues: "0",
              isEligible: false,
            },
          ],
        });
      }
      if (url.endsWith("/miners/49853598/prs")) {
        return Response.json([
          { repository: "we-promise/sure", pullRequestNumber: 1869, pullRequestTitle: "feat(imports): verify Sure NDJSON import readback", prState: "MERGED", label: null, score: "13.551300" },
        ]);
      }
      if (url.endsWith("/miners/49853598/issues")) {
        return Response.json({ issue_count: 0 });
      }
      return new Response("not found", { status: 404 });
    });

    const snapshot = await fetchGittensorContributorSnapshot("jsonbored");

    expect(snapshot).toMatchObject({
      githubId: "49853598",
      githubUsername: "JSONbored",
      totals: { pullRequests: 63, mergedPullRequests: 46, openPullRequests: 9, closedPullRequests: 8, openIssues: 44, closedIssues: 4 },
      repositories: [
        expect.objectContaining({ repoFullName: "we-promise/sure", pullRequests: 47, mergedPullRequests: 37, openPullRequests: 6 }),
        expect.objectContaining({ repoFullName: "jsonbored/awesome-claude", pullRequests: 0, openIssues: 42 }),
      ],
      issueMirrorAvailable: true,
      issues: [],
    });
    expect(contributorRepoStatsFromGittensor(snapshot)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoFullName: "we-promise/sure", pullRequests: 47, mergedPullRequests: 37, issues: 0 }),
        expect.objectContaining({ repoFullName: "jsonbored/awesome-claude", pullRequests: 0, mergedPullRequests: 0, issues: 42 }),
      ]),
    );
  });

  it("falls back cleanly when Gittensor API is unavailable or has no matching miner", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404 }));
    await expect(fetchGittensorContributorSnapshot("jsonbored")).resolves.toBeNull();
    expect(contributorRepoStatsFromGittensor(null)).toEqual([]);
  });

  it("keeps the official miner summary when detail endpoints are temporarily unavailable", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/miners")) {
        return Response.json([
          {
            githubUsername: "JSONbored",
            githubId: "49853598",
            totalPrs: 63,
            totalMergedPrs: 46,
            totalOpenPrs: 9,
            totalClosedPrs: 8,
            totalOpenIssues: 44,
            totalClosedIssues: 4,
            totalSolvedIssues: 1,
            totalValidSolvedIssues: 1,
          },
        ]);
      }
      return new Response("temporarily unavailable", { status: 503 });
    });

    const snapshot = await fetchGittensorContributorSnapshot("jsonbored");

    expect(snapshot).toMatchObject({
      source: "gittensor_api",
      githubId: "49853598",
      totals: { pullRequests: 63, mergedPullRequests: 46, openPullRequests: 9, closedPullRequests: 8 },
      repositories: [],
      pullRequests: [],
      issueMirrorAvailable: false,
      issues: [],
      issueLabels: [],
    });
  });

  it("handles partial Gittensor payloads and malformed numeric fields", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/miners")) {
        return Response.json([
          {
            githubUsername: "partial",
            githubId: "123",
            totalPrs: "not-a-number",
            totalMergedPrs: 2,
            totalOpenPrs: Number.NaN,
            issueCredibility: undefined,
          },
        ]);
      }
      if (url.endsWith("/miners/123")) {
        return Response.json({
          repositories: [
            { repositoryFullName: { malformed: true }, totalPrs: "bad", totalOpenIssues: "1", totalClosedIssues: null, isEligible: true },
            { repositoryFullName: "owner/repo", totalPrs: "3", totalMergedPrs: "2", totalOpenIssues: "0", totalClosedIssues: "0", totalScore: "bad" },
          ],
        });
      }
      if (url.endsWith("/miners/123/prs")) {
        return Response.json([
          { repository: undefined, pullRequestNumber: "bad", pullRequestTitle: undefined, prState: undefined },
          { repository: "owner/repo", pullRequestNumber: 7, pullRequestTitle: "Fix it", prState: "MERGED", score: "bad", baseScore: 1 },
        ]);
      }
      if (url.endsWith("/miners/123/issues")) {
        return Response.json({ issues: [{ repo_full_name: "owner/repo", issue_number: "bad", labels: [{}, { name: null }, { name: "bug" }] }] });
      }
      return Response.json({});
    });

    const snapshot = await fetchGittensorContributorSnapshot("partial");

    expect(snapshot).toMatchObject({
      totals: { pullRequests: 0, mergedPullRequests: 2, openPullRequests: 0 },
      issueCredibility: 1,
      issueMirrorAvailable: true,
      issues: [],
      issueLabels: ["bug"],
      pullRequests: [expect.objectContaining({ repoFullName: "owner/repo", number: 7, title: "Fix it", score: 0, baseScore: 1 })],
      repositories: [expect.objectContaining({ repoFullName: "owner/repo", pullRequests: 3, mergedPullRequests: 2, totalScore: 0 })],
    });
    // The malformed-name repo (empty repoFullName) must be dropped, like the PR/issue lists, so it cannot
    // leak into reposTouched / evidenceScore.
    expect(snapshot?.repositories.map((repo) => repo.repoFullName)).toEqual(["owner/repo"]);
  });

  it("returns null when the miner list has no matching GitHub identity", async () => {
    vi.stubGlobal("fetch", async () => Response.json([{ githubUsername: "someone-else", githubId: "999" }]));
    await expect(fetchGittensorContributorSnapshot("jsonbored")).resolves.toBeNull();
  });

  it("does not match a PR author login against a miner numeric GitHub ID", async () => {
    vi.stubGlobal("fetch", async () => Response.json([{ githubUsername: "official-real-miner", githubId: "12345" }]));

    await expect(fetchOfficialGittensorMiner("12345")).resolves.toEqual({ status: "not_found" });
  });

  it("classifies official miner detection without a complete identity and handles non-Error failures", async () => {
    vi.stubGlobal("fetch", async () => Response.json([{ githubUsername: "jsonbored" }, { githubId: "49853598" }]));
    await expect(fetchOfficialGittensorMiner("jsonbored")).resolves.toEqual({ status: "not_found" });
    await expect(fetchOfficialGittensorMiner("49853598")).resolves.toEqual({ status: "not_found" });

    vi.stubGlobal("fetch", async () => {
      throw "network down";
    });
    await expect(fetchOfficialGittensorMiner("jsonbored")).resolves.toEqual({ status: "unavailable", error: "unknown Gittensor API error" });
  });

  it("maps optional Gittensor detail fields when present", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/miners")) {
        return Response.json([
          {
            githubUsername: "jsonbored",
            githubId: "49853598",
            failedReason: null,
            issueDiscoveryScore: "3",
            issueTokenScore: "4",
            isIssueEligible: true,
            issueEligibleRepoCount: "2",
            alphaPerDay: "1.25",
            taoPerDay: "0.5",
            usdPerDay: "100",
          },
        ]);
      }
      if (url.endsWith("/miners/49853598")) {
        return Response.json({
          uid: 29,
          hotkey: "hotkey",
          updatedAt: "2026-05-25T00:00:00.000Z",
          repositories: [
            {
              repositoryFullName: "owner/issues",
              totalPrs: 0,
              totalOpenIssues: 1,
              totalClosedIssues: 1,
              totalSolvedIssues: 1,
              totalValidSolvedIssues: 1,
              isIssueEligible: true,
              issueCredibility: "0.9",
              baseTotalScore: "12.5",
            },
          ],
        });
      }
      if (url.endsWith("/miners/49853598/prs")) {
        return Response.json([{ repository: "owner/repo", pullRequestNumber: 9, pullRequestTitle: undefined, prState: undefined, mergedAt: null, label: "bug", tokenScore: "7" }]);
      }
      if (url.endsWith("/miners/49853598/issues")) {
        return Response.json({ issues: [{ labels: undefined }, { repo_full_name: "owner/issues", issue_number: 22, state: "open", solved_by_pr: null, labels: [{ name: "bug" }] }] });
      }
      return Response.json({});
    });

    const snapshot = await fetchGittensorContributorSnapshot("jsonbored");

    expect(snapshot).toMatchObject({
      uid: 29,
      hotkey: "hotkey",
      isIssueEligible: true,
      issueEligibleRepoCount: 2,
      alphaPerDay: 1.25,
      taoPerDay: 0.5,
      usdPerDay: 100,
      updatedAt: "2026-05-25T00:00:00.000Z",
      repositories: [expect.objectContaining({ repoFullName: "owner/issues", openIssues: 1, closedIssues: 1, validSolvedIssues: 1, issueCredibility: 0.9 })],
      pullRequests: [expect.objectContaining({ repoFullName: "owner/repo", number: 9, title: "", state: "UNKNOWN", label: "bug", tokenScore: 7 })],
      issueMirrorAvailable: true,
      issues: [expect.objectContaining({ repoFullName: "owner/issues", number: 22, state: "open", solvedByPullRequest: null, labels: ["bug"] })],
      issueLabels: ["bug"],
    });
    expect(contributorRepoStatsFromGittensor(snapshot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ login: "jsonbored", repoFullName: "owner/issues", issues: 2, lastActivityAt: "2026-05-25T00:00:00.000Z" })]),
    );
  });
});
