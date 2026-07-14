function parseWatchedRepos(text) {
  return String(text ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// This extension does not request the "unlimitedStorage" permission, so chrome.storage.local is capped at its
// default 10 MiB (QUOTA_BYTES) quota shared across every key -- an unbounded paste can silently fail to save
// or leave storage in a partial state (#4863). Measured with TextEncoder against the actual serialized UTF-8
// byte size, NOT the pasted text's UTF-16 .length -- a char count undercounts any multibyte content (e.g. a
// non-ASCII repo/issue title), so a payload that passes a char-based check could still exceed the real quota at
// chrome.storage.local.set, recreating the exact silent-failure bug this guard exists to prevent. TextEncoder is
// a standard Web API available in both the real extension runtime and this repo's node:vm test harness (once
// injected into the sandbox context).
const MAX_RANKED_CANDIDATES_JSON_BYTES = 8 * 1024 * 1024;

function parseRankedCandidatesJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const byteLength = new TextEncoder().encode(trimmed).length;
  if (byteLength > MAX_RANKED_CANDIDATES_JSON_BYTES) {
    throw new Error(
      `Ranked candidates JSON is too large (${byteLength.toLocaleString()} bytes; limit ${MAX_RANKED_CANDIDATES_JSON_BYTES.toLocaleString()}). Paste a smaller discover-run export.`,
    );
  }
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("Ranked candidates JSON must be an array.");
  }
  return parsed;
}

// #5343 dropped the discoveryIndexUrl UI field and stopped reading/writing it, but chrome.storage.sync.set
// only merges keys -- it never deletes ones an earlier extension version already synced. Without an active
// purge, a value synced before #5343 stays in the user's account indefinitely. Called from refreshSettings,
// which runs on every options-page load and again at the end of every save, so it's cleared promptly
// regardless of which path a given user hits first.
async function removeLegacyDiscoveryIndexUrl() {
  await chrome.storage.sync.remove("discoveryIndexUrl");
}

// Mirrors background.js's own literal (#4859) -- these classic (non-ESM-importing) extension scripts share a
// message-type "protocol" via matching string literals, the same convention content.js already uses for
// ISSUE_CONTEXT_MESSAGE, not a cross-file import.
const SYNC_RANKED_CANDIDATES_MESSAGE = "gittensory-miner:sync-ranked-candidates";
const DEFAULT_MINER_UI_URL = "http://localhost:5174";

function normalizeMinerUiUrl(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed || DEFAULT_MINER_UI_URL;
}

if (globalThis.__LOOPOVER_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOptionsInternals = {
    parseWatchedRepos,
    parseRankedCandidatesJson,
    removeLegacyDiscoveryIndexUrl,
    normalizeMinerUiUrl,
    MAX_RANKED_CANDIDATES_JSON_BYTES,
    SYNC_RANKED_CANDIDATES_MESSAGE,
    DEFAULT_MINER_UI_URL,
  };
}

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const watchedRepos = document.querySelector("#watchedRepos");
const rankedCandidatesJson = document.querySelector("#rankedCandidatesJson");
const minerUiUrl = document.querySelector("#minerUiUrl");
const syncNow = document.querySelector("#syncNow");

if (!form || !status || !watchedRepos || !rankedCandidatesJson || !minerUiUrl || !syncNow) {
  // options.html is not mounted (unit-test harness or partial load).
} else {
void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const repos = parseWatchedRepos(watchedRepos.value);
    const rankedCandidates = parseRankedCandidatesJson(rankedCandidatesJson.value);
    await chrome.storage.sync.set({ watchedRepos: repos, minerUiUrl: normalizeMinerUiUrl(minerUiUrl.value) });
    await chrome.storage.local.set({ rankedCandidates, rankedCandidatesSavedAt: Date.now() });
    await refreshSettings();
    showStatus(
      rankedCandidates.length > 0
        ? `Saved ${repos.length} watched repo(s) and ${rankedCandidates.length} ranked candidate(s).`
        : `Watching ${repos.length} repository(ies).`,
    );
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error));
  }
});

// Live-fetch trigger (#4859): asks background.js's syncRankedCandidatesFromMinerUi to pull the miner-ui's
// current ranked candidates immediately, without waiting for the ambient alarm. Saves the URL field first so
// a URL the user just typed (but hasn't submitted the form for yet) is what gets used.
syncNow.addEventListener("click", async () => {
  try {
    await chrome.storage.sync.set({ minerUiUrl: normalizeMinerUiUrl(minerUiUrl.value) });
    const response = await chrome.runtime.sendMessage({ type: SYNC_RANKED_CANDIDATES_MESSAGE });
    const result = response?.payload;
    if (!result?.ok) {
      showStatus(`Could not reach the miner UI at ${result?.minerUiUrl ?? minerUiUrl.value}: ${result?.error ?? "unknown error"}. Falling back to the pasted JSON below.`);
      return;
    }
    await refreshSettings();
    showStatus(`Synced ${result.count} ranked candidate(s) from ${result.minerUiUrl}.`);
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error));
  }
});
}

async function refreshSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [], minerUiUrl: DEFAULT_MINER_UI_URL });
  await removeLegacyDiscoveryIndexUrl();
  const local = await chrome.storage.local.get({ rankedCandidates: [] });
  const repos = Array.isArray(stored.watchedRepos) ? stored.watchedRepos : [];
  watchedRepos.value = repos.join("\n");
  minerUiUrl.value = normalizeMinerUiUrl(stored.minerUiUrl);
  const rankedCandidates = Array.isArray(local.rankedCandidates) ? local.rankedCandidates : [];
  rankedCandidatesJson.value =
    rankedCandidates.length > 0 ? JSON.stringify(rankedCandidates, null, 2) : "";
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 2600);
}
