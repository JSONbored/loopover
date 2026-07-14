import { vi } from "vitest";

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

export type BackgroundInternals = {
  PING_MESSAGE: string;
  ISSUE_CONTEXT_MESSAGE: string;
  SYNC_RANKED_CANDIDATES_MESSAGE: string;
  DEFAULT_MINER_UI_URL: string;
  loadIssueOpportunityContext: (message: {
    owner: string;
    repo: string;
    issueNumber: number;
  }) => Promise<Record<string, unknown>>;
  loadMinerExtensionSettings: () => Promise<{ watchedRepos: string[] }>;
  loadRankedCandidates: () => Promise<{ rankedCandidates: unknown[]; savedAt: number | null }>;
  loadMinerUiUrl: () => Promise<string>;
  syncRankedCandidatesFromMinerUi: () => Promise<Record<string, unknown>>;
  refreshToolbarBadge: () => Promise<void>;
};

export type OpportunityBadgeExports = {
  issueLookupKey: (repoFullName: unknown, issueNumber: unknown) => string | null;
  lookupRankedOpportunity: (
    rankedIssues: unknown,
    repoFullName: string,
    issueNumber: number,
  ) => Record<string, unknown> | null;
  scoreToTier: (rankScore: unknown) => string;
  buildOpportunityWhy: (entry: Record<string, unknown>) => string;
  formatOpportunityBadge: (entry: Record<string, unknown>) => {
    tier: string;
    score: string;
    why: string;
    rankScore: number | null;
  };
  formatLastSyncedLabel: (savedAt: unknown, nowMs: number) => string | null;
  escapeOpportunityHtml: (value: unknown) => string;
  renderOpportunityBadgeMarkup: (badge: Record<string, unknown>, lastSyncedLabel?: string | null) => string;
};

type ChromeMockOptions = {
  watchedRepos?: string[];
  syncGetResult?: Record<string, unknown>;
  rankedCandidates?: unknown;
  rankedCandidatesSavedAt?: number | null;
  minerUiUrl?: string;
  withAction?: boolean;
  withAlarms?: boolean;
  withLifecycle?: boolean;
  failAction?: boolean;
  syncGetThrows?: boolean;
  syncGetRejectsWith?: unknown;
  fetchImpl?: typeof fetch;
};

export function jsonFetch(status: number, payload: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    }) as unknown as Response) as typeof fetch;
}

export function buildChromeMock(options: ChromeMockOptions = {}) {
  const watchedRepos = options.watchedRepos ?? [];
  const rankedCandidates =
    "rankedCandidates" in options ? options.rankedCandidates : [];
  const rankedCandidatesSavedAt = options.rankedCandidatesSavedAt ?? null;
  const minerUiUrl = options.minerUiUrl ?? "http://localhost:5174";
  const withAction = options.withAction ?? true;
  const withAlarms = options.withAlarms ?? false;
  const withLifecycle = options.withLifecycle ?? false;
  const failAction = options.failAction ?? false;
  const syncGetThrows = options.syncGetThrows ?? false;
  const syncGetRejectsWith = options.syncGetRejectsWith;

  const localSetCalls: Array<Record<string, unknown>> = [];
  const syncSetCalls: Array<Record<string, unknown>> = [];
  const syncRemoveCalls: string[] = [];
  const alarmCreateCalls: Array<[string, unknown]> = [];
  let changeListener: ((changes: unknown, areaName: string) => void) | null = null;
  let alarmListener: ((alarm: { name: string }) => void) | undefined;
  let startupListener: (() => void) | undefined;
  let installedListener: (() => void) | undefined;
  let messageListener:
    | ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void)
    | undefined;

  const setBadgeText = failAction
    ? vi.fn(async () => {
        throw new Error("chrome.action unavailable");
      })
    : vi.fn(async () => {});
  const setBadgeBackgroundColor = vi.fn(async () => {});

  const chrome: Record<string, unknown> = {
    runtime: {
      onMessage: {
        addListener: (fn: typeof messageListener) => {
          messageListener = fn;
        },
      },
      ...(withLifecycle
        ? {
            onStartup: { addListener: (fn: typeof startupListener) => (startupListener = fn) },
            onInstalled: { addListener: (fn: typeof installedListener) => (installedListener = fn) },
          }
        : {}),
    },
    storage: {
      sync: {
        get: syncGetThrows
          ? async () => {
              throw syncGetRejectsWith ?? new Error("sync storage unavailable");
            }
          : async () => ({ watchedRepos, minerUiUrl, ...(options.syncGetResult ?? {}) }),
        set: async (value: Record<string, unknown>) => {
          syncSetCalls.push(value);
        },
        remove: async (keys: string | string[]) => {
          syncRemoveCalls.push(...(Array.isArray(keys) ? keys : [keys]));
        },
      },
      local: {
        get: async (arg: unknown) =>
          typeof arg === "string"
            ? { rankedCandidates }
            : {
                rankedCandidates: Array.isArray(rankedCandidates) ? rankedCandidates : [],
                rankedCandidatesSavedAt,
              },
        set: async (value: Record<string, unknown>) => {
          localSetCalls.push(value);
        },
      },
      onChanged: withAction
        ? { addListener: (fn: typeof changeListener) => (changeListener = fn) }
        : undefined,
    },
  };

  if (withAction) {
    chrome.action = { setBadgeText, setBadgeBackgroundColor };
  }
  if (withAlarms) {
    chrome.alarms = {
      create: (name: string, info: unknown) => alarmCreateCalls.push([name, info]),
      onAlarm: { addListener: (fn: typeof alarmListener) => (alarmListener = fn) },
    };
  }

  return {
    chrome,
    localSetCalls,
    syncSetCalls,
    syncRemoveCalls,
    alarmCreateCalls,
    setBadgeText,
    setBadgeBackgroundColor,
    dispatchAlarm: (name: string) => alarmListener?.({ name }),
    dispatchStartup: () => startupListener?.(),
    dispatchInstalled: () => installedListener?.(),
    dispatchMessage: (message: unknown) =>
      new Promise((resolve) => {
        const keepChannelOpen = messageListener?.(message, {}, resolve);
        if (!keepChannelOpen) resolve(undefined);
      }),
    fireChange: (changes: unknown, areaName: string) => changeListener?.(changes, areaName),
  };
}

export async function loadExtensionModules(options: ChromeMockOptions = {}) {
  vi.resetModules();
  vi.unstubAllGlobals();

  const harness = buildChromeMock(options);
  vi.stubGlobal("chrome", harness.chrome);
  vi.stubGlobal("__LOOPOVER_MINER_EXTENSION_TEST__", true);
  if (options.fetchImpl) vi.stubGlobal("fetch", options.fetchImpl);

  await import("../opportunity-badge.js");
  await import("../toolbar-badge.js");
  await import("../background.js");

  return {
    ...harness,
    opportunityExports: globalThis.__gittensoryMinerOpportunityBadgeTestExports as OpportunityBadgeExports,
    toolbarApi: globalThis.__gittensoryMinerToolbarBadge as {
      computeToolbarBadge: (rankedCandidates: unknown) => { text: string; backgroundColor: string };
    },
    backgroundInternals: globalThis.__gittensoryMinerBackgroundInternals as BackgroundInternals,
  };
}
