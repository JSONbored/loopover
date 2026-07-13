import "./opportunity-badge.js";
import "./toolbar-badge.js";

const badgeApi = globalThis.__gittensoryMinerOpportunityBadge;
const toolbarBadgeApi = globalThis.__gittensoryMinerToolbarBadge;

const PING_MESSAGE = "gittensory-miner:ping";
const ISSUE_CONTEXT_MESSAGE = "gittensory-miner:issue-context";
const SYNC_RANKED_CANDIDATES_MESSAGE = "gittensory-miner:sync-ranked-candidates";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (message.type === PING_MESSAGE) {
    sendResponse({ ok: true, payload: { ready: true } });
    return false;
  }
  if (message.type === ISSUE_CONTEXT_MESSAGE) {
    const task = loadIssueOpportunityContext(message);
    void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }
  if (message.type === SYNC_RANKED_CANDIDATES_MESSAGE) {
    void syncRankedCandidatesFromMinerUi().then((result) => sendResponse({ ok: true, payload: result }));
    return true;
  }
  return false;
});

async function loadIssueOpportunityContext(message) {
  const settings = await loadMinerExtensionSettings();
  const repoFullName = `${message.owner}/${message.repo}`;
  const watched = settings.watchedRepos.some(
    (repo) => repo.trim().toLowerCase() === repoFullName.toLowerCase(),
  );
  if (!watched) {
    return {
      watched: false,
      issueNumber: message.issueNumber,
      repoFullName,
      badge: null,
      status: "repo-not-watched",
    };
  }

  const { rankedCandidates, savedAt } = await loadRankedCandidates();
  const rankedEntry = badgeApi.lookupRankedOpportunity(rankedCandidates, repoFullName, message.issueNumber);
  if (!rankedEntry) {
    return {
      watched: true,
      issueNumber: message.issueNumber,
      repoFullName,
      badge: null,
      status: "no-signal",
    };
  }

  return {
    watched: true,
    issueNumber: message.issueNumber,
    repoFullName,
    badge: badgeApi.formatOpportunityBadge(rankedEntry),
    savedAt,
    status: "ready",
  };
}

async function loadMinerExtensionSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [] });
  const watchedRepos = Array.isArray(stored.watchedRepos)
    ? stored.watchedRepos.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return { watchedRepos };
}

// Reads rankedCandidates alongside its savedAt sync timestamp (#5192). `savedAt` degrades to `null`
// (never NaN) when absent -- e.g. data written before this field existed, or storage was cleared.
async function loadRankedCandidates() {
  const stored = await chrome.storage.local.get({ rankedCandidates: [], rankedCandidatesSavedAt: null });
  return {
    rankedCandidates: Array.isArray(stored.rankedCandidates) ? stored.rankedCandidates : [],
    savedAt: typeof stored.rankedCandidatesSavedAt === "number" ? stored.rankedCandidatesSavedAt : null,
  };
}

const DEFAULT_MINER_UI_URL = "http://localhost:5174";
const SYNC_ALARM_NAME = "gittensory-miner:sync-ranked-candidates";
const SYNC_ALARM_PERIOD_MINUTES = 10;

async function loadMinerUiUrl() {
  const stored = await chrome.storage.sync.get({ minerUiUrl: DEFAULT_MINER_UI_URL });
  const url = typeof stored.minerUiUrl === "string" ? stored.minerUiUrl.trim() : "";
  return url || DEFAULT_MINER_UI_URL;
}

/** Live-fetch replacement for the manual copy/paste workflow (#4859): pulls the miner's last discover run's
 *  ranked candidates from the local miner-ui's read-only /api/ranked-candidates endpoint (packages/gittensory-
 *  miner/lib/ranked-candidates.js via apps/gittensory-miner-ui/vite-ranked-candidates-api.ts) and writes them
 *  into the SAME chrome.storage.local keys the manual-paste flow (options.js) already writes
 *  (rankedCandidates/rankedCandidatesSavedAt) -- so content.js/opportunity-badge.js/toolbar-badge.js need zero
 *  changes; they already read from that one shared source regardless of which flow populated it.
 *
 *  Never throws: any failure (miner-ui not running, network error, missing auth cookie because the dashboard
 *  was never opened in this browser, malformed response) resolves to a typed { ok: false } result and leaves
 *  whatever's already in storage untouched -- the existing manual-paste fallback (or a stale prior fetch) keeps
 *  working exactly as before, satisfying #4859's "keep paste as a fallback" requirement with no merge logic. */
async function syncRankedCandidatesFromMinerUi() {
  const minerUiUrl = await loadMinerUiUrl();
  try {
    const response = await fetch(`${minerUiUrl}/api/ranked-candidates`);
    if (!response.ok) {
      return { ok: false, error: `miner UI responded ${response.status}`, minerUiUrl };
    }
    const payload = await response.json();
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : null;
    if (!candidates) {
      return { ok: false, error: "miner UI returned an unexpected payload shape", minerUiUrl };
    }
    const savedAt = Date.now();
    await chrome.storage.local.set({ rankedCandidates: candidates, rankedCandidatesSavedAt: savedAt });
    return { ok: true, count: candidates.length, savedAt, minerUiUrl };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      minerUiUrl,
    };
  }
}

// Ambient refresh so live data stays current without the user re-opening the options page: once on service-
// worker startup/install, then every SYNC_ALARM_PERIOD_MINUTES via chrome.alarms (a service worker can be
// killed and woken between calls, so a plain setInterval would not survive -- alarms are the MV3-correct
// primitive for this). Guarded per-API so the unit-test harness (which provides none of these) is a clean
// no-op, matching the toolbar-badge guard below.
if (chrome.alarms) {
  chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_ALARM_PERIOD_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM_NAME) void syncRankedCandidatesFromMinerUi();
  });
}
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => void syncRankedCandidatesFromMinerUi());
}
if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => void syncRankedCandidatesFromMinerUi());
}

// Toolbar-icon badge (#5193). Reads `rankedCandidates` WITHOUT a default so `undefined` still means
// "cache never populated" (a dash), distinct from a populated-but-empty `[]` (cleared text). Read-only.
async function refreshToolbarBadge() {
  // Swallow transient chrome.storage/chrome.action failures: this runs void-called on startup and from the
  // onChanged listener, so an unhandled rejection would surface uncaught in the service-worker context.
  try {
    const { rankedCandidates } = await chrome.storage.local.get("rankedCandidates");
    const badge = toolbarBadgeApi.computeToolbarBadge(rankedCandidates);
    await chrome.action.setBadgeText({ text: badge.text });
    await chrome.action.setBadgeBackgroundColor({ color: badge.backgroundColor });
  } catch (error) {
    console.warn("gittensory-miner: failed to refresh toolbar badge", error);
  }
}

// Paint on service-worker startup, then keep it live as the miner rewrites the cache. Guarded so environments
// without the action API surface (e.g. the unit-test harness) are a clean no-op.
if (chrome.action && chrome.storage.onChanged) {
  void refreshToolbarBadge();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes && changes.rankedCandidates) void refreshToolbarBadge();
  });
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerBackgroundInternals = {
    PING_MESSAGE,
    ISSUE_CONTEXT_MESSAGE,
    SYNC_RANKED_CANDIDATES_MESSAGE,
    DEFAULT_MINER_UI_URL,
    loadIssueOpportunityContext,
    loadMinerExtensionSettings,
    loadRankedCandidates,
    loadMinerUiUrl,
    syncRankedCandidatesFromMinerUi,
    refreshToolbarBadge,
  };
}
