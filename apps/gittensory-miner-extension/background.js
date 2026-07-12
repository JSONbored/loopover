import "./opportunity-badge.js";
import "./toolbar-badge.js";

const badgeApi = globalThis.__gittensoryMinerOpportunityBadge;
const toolbarBadgeApi = globalThis.__gittensoryMinerToolbarBadge;

const PING_MESSAGE = "gittensory-miner:ping";
const ISSUE_CONTEXT_MESSAGE = "gittensory-miner:issue-context";

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

  const rankedCandidates = await loadRankedCandidates();
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

async function loadRankedCandidates() {
  const stored = await chrome.storage.local.get({ rankedCandidates: [] });
  return Array.isArray(stored.rankedCandidates) ? stored.rankedCandidates : [];
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
    loadIssueOpportunityContext,
    loadMinerExtensionSettings,
    loadRankedCandidates,
    refreshToolbarBadge,
  };
}
