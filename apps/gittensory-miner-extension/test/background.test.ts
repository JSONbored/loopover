import { afterEach, describe, expect, it, vi } from "vitest";

import { flush, jsonFetch, loadExtensionModules } from "./helpers.js";
import {
  TOOLBAR_BADGE_EMPTY_COLOR,
  TOOLBAR_BADGE_HAS_DATA_COLOR,
  TOOLBAR_BADGE_NO_DATA_TEXT,
} from "../toolbar-badge.js";

const rankedEntry = {
  repoFullName: "JSONbored/gittensory",
  issueNumber: 145,
  rankScore: 0.82,
  laneFit: 0.9,
  freshness: 0.8,
  potential: 0.7,
  feasibility: 0.75,
  dupRisk: 0.1,
};

describe("background service worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns ready issue context for a watched repo with a cached ranked candidate", async () => {
    const { backgroundInternals } = await loadExtensionModules({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [rankedEntry],
      rankedCandidatesSavedAt: Date.parse("2026-07-10T11:00:00.000Z"),
    });

    const payload = await backgroundInternals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload.status).toBe("ready");
    expect(payload.savedAt).toBe(Date.parse("2026-07-10T11:00:00.000Z"));
    expect((payload.badge as { tier: string }).tier).toBe("High");
  });

  it("returns repo-not-watched and no-signal states", async () => {
    const unwatched = await loadExtensionModules({ watchedRepos: ["other/repo"] });
    const notWatched = await unwatched.backgroundInternals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(notWatched.status).toBe("repo-not-watched");
    expect(notWatched.badge).toBeNull();

    const empty = await loadExtensionModules({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [],
    });
    const noSignal = await empty.backgroundInternals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(noSignal.status).toBe("no-signal");
    expect(noSignal.badge).toBeNull();
  });

  it("normalizes watched repos and degrades malformed ranked-candidate storage", async () => {
    const { backgroundInternals } = await loadExtensionModules({
      watchedRepos: [" JSONbored/gittensory ", "", 42 as unknown as string],
      rankedCandidates: "bad" as unknown as unknown[],
      rankedCandidatesSavedAt: "not-a-number" as unknown as number,
    });

    expect(await backgroundInternals.loadMinerExtensionSettings()).toEqual({
      watchedRepos: ["JSONbored/gittensory", "42"],
    });
    expect(await backgroundInternals.loadRankedCandidates()).toEqual({
      rankedCandidates: [],
      savedAt: null,
    });

    const malformedSettings = await loadExtensionModules({
      syncGetResult: { watchedRepos: "not-an-array" },
    });
    expect(await malformedSettings.backgroundInternals.loadMinerExtensionSettings()).toEqual({
      watchedRepos: [],
    });
  });

  it("syncs ranked candidates from the miner UI and leaves storage untouched on failure", async () => {
    const candidates = [{ repoFullName: "acme/widgets", issueNumber: 1, rankScore: 0.8 }];
    const success = await loadExtensionModules({
      fetchImpl: jsonFetch(200, { candidates }),
    });
    const ok = await success.backgroundInternals.syncRankedCandidatesFromMinerUi();
    expect(ok.ok).toBe(true);
    expect(ok.count).toBe(1);
    expect(success.localSetCalls).toHaveLength(1);

    const httpError = await loadExtensionModules({ fetchImpl: jsonFetch(401, {}) });
    const unauthorized = await httpError.backgroundInternals.syncRankedCandidatesFromMinerUi();
    expect(unauthorized).toMatchObject({ ok: false, error: "miner UI responded 401" });
    expect(httpError.localSetCalls).toHaveLength(0);

    const malformed = await loadExtensionModules({ fetchImpl: jsonFetch(200, { candidates: "nope" }) });
    const badShape = await malformed.backgroundInternals.syncRankedCandidatesFromMinerUi();
    expect(badShape).toMatchObject({
      ok: false,
      error: "miner UI returned an unexpected payload shape",
    });

    const network = await loadExtensionModules({
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    const failed = await network.backgroundInternals.syncRankedCandidatesFromMinerUi();
    expect(failed).toMatchObject({ ok: false, error: "connection refused" });
  });

  it("falls back to the default miner UI URL when sync storage is empty or malformed", async () => {
    const empty = await loadExtensionModules({ minerUiUrl: "" });
    expect(await empty.backgroundInternals.loadMinerUiUrl()).toBe(
      empty.backgroundInternals.DEFAULT_MINER_UI_URL,
    );

    const malformed = await loadExtensionModules({ minerUiUrl: 123 as unknown as string });
    expect(await malformed.backgroundInternals.loadMinerUiUrl()).toBe(
      malformed.backgroundInternals.DEFAULT_MINER_UI_URL,
    );
  });

  it("stringifies non-Error sync failures and issue-context rejections", async () => {
    const syncFail = await loadExtensionModules({
      fetchImpl: (async () => {
        throw "offline";
      }) as typeof fetch,
    });
    const syncResult = await syncFail.backgroundInternals.syncRankedCandidatesFromMinerUi();
    expect(syncResult).toMatchObject({ ok: false, error: "offline" });

    const mod = await loadExtensionModules({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [rankedEntry],
      syncGetThrows: true,
      syncGetRejectsWith: "storage blew up",
    });
    const response = await mod.dispatchMessage({
      type: mod.backgroundInternals.ISSUE_CONTEXT_MESSAGE,
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect((response as { ok: boolean; error: string }).error).toBeTruthy();
  });

  it("matches watched repos case-insensitively", async () => {
    const { backgroundInternals } = await loadExtensionModules({
      watchedRepos: ["jsonbored/gittensory"],
      rankedCandidates: [rankedEntry],
    });
    const payload = await backgroundInternals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(payload.status).toBe("ready");
  });

  it("routes runtime messages for ping, issue context, and sync", async () => {
    const mod = await loadExtensionModules({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [rankedEntry],
      fetchImpl: jsonFetch(200, { candidates: [rankedEntry] }),
    });

    const ping = await mod.dispatchMessage({ type: mod.backgroundInternals.PING_MESSAGE });
    expect(ping).toEqual({ ok: true, payload: { ready: true } });

    const context = await mod.dispatchMessage({
      type: mod.backgroundInternals.ISSUE_CONTEXT_MESSAGE,
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect((context as { payload: { status: string } }).payload.status).toBe("ready");

    const sync = await mod.dispatchMessage({
      type: mod.backgroundInternals.SYNC_RANKED_CANDIDATES_MESSAGE,
    });
    expect((sync as { payload: { ok: boolean } }).payload.ok).toBe(true);

    const ignored = await mod.dispatchMessage({ type: "unknown" });
    expect(ignored).toBeUndefined();
    expect(await mod.dispatchMessage(null)).toBeUndefined();
  });

  it("paints and repaints the toolbar badge from storage changes", async () => {
    const mod = await loadExtensionModules({ rankedCandidates: [1, 2] });
    await flush();
    expect(mod.setBadgeText).toHaveBeenCalledWith({ text: "2" });
    expect(mod.setBadgeBackgroundColor).toHaveBeenCalledWith({
      color: TOOLBAR_BADGE_HAS_DATA_COLOR,
    });

    mod.setBadgeText.mockClear();
    await mod.backgroundInternals.refreshToolbarBadge();
    expect(mod.setBadgeText).toHaveBeenLastCalledWith({ text: "2" });

    const never = await loadExtensionModules({ rankedCandidates: undefined });
    await flush();
    never.setBadgeText.mockClear();
    await never.backgroundInternals.refreshToolbarBadge();
    expect(never.setBadgeText).toHaveBeenLastCalledWith({ text: TOOLBAR_BADGE_NO_DATA_TEXT });

    const empty = await loadExtensionModules({ rankedCandidates: [] });
    await flush();
    empty.setBadgeText.mockClear();
    await empty.backgroundInternals.refreshToolbarBadge();
    expect(empty.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    expect(empty.setBadgeBackgroundColor).toHaveBeenLastCalledWith({
      color: TOOLBAR_BADGE_EMPTY_COLOR,
    });

    const live = await loadExtensionModules({ rankedCandidates: [9] });
    await flush();
    live.setBadgeText.mockClear();
    live.fireChange({ rankedCandidates: { newValue: [9] } }, "local");
    await flush();
    expect(live.setBadgeText).toHaveBeenCalledTimes(1);

    live.setBadgeText.mockClear();
    live.fireChange({ rankedCandidates: { newValue: [9] } }, "sync");
    live.fireChange({ watchedRepos: { newValue: [] } }, "local");
    await flush();
    expect(live.setBadgeText).not.toHaveBeenCalled();
  });

  it("swallows chrome.action failures during toolbar refresh", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await loadExtensionModules({ rankedCandidates: [1], failAction: true });
    await flush();
    await expect(mod.backgroundInternals.refreshToolbarBadge()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("registers ambient sync alarms and lifecycle hooks when chrome surfaces exist", async () => {
    const mod = await loadExtensionModules({
      withAlarms: true,
      withLifecycle: true,
      fetchImpl: jsonFetch(200, { candidates: [] }),
    });

    expect(mod.alarmCreateCalls[0]?.[0]).toBe("gittensory-miner:sync-ranked-candidates");
    mod.dispatchStartup();
    mod.dispatchInstalled();
    mod.dispatchAlarm("gittensory-miner:sync-ranked-candidates");
    mod.dispatchAlarm("other-alarm");
    await flush();
    expect(mod.localSetCalls.length).toBeGreaterThan(0);
  });

  it("no-ops toolbar wiring when chrome.action is unavailable", async () => {
    const mod = await loadExtensionModules({ rankedCandidates: [1, 2, 3], withAction: false });
    await flush();
    expect(typeof mod.backgroundInternals.refreshToolbarBadge).toBe("function");
    expect(mod.setBadgeText).not.toHaveBeenCalled();
  });
});
