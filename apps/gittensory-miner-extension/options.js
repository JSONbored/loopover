function parseWatchedRepos(text) {
  return String(text ?? "")
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseRankedCandidatesJson(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("Ranked candidates JSON must be an array.");
  }
  return parsed;
}

// Live-fetch mode (#4859): pull ranked candidates from the operator's own local miner-ui instead of pasting
// `discover --json` output. The default matches miner-ui's fixed dev port (apps/gittensory-miner-ui/vite.config.ts).
const DEFAULT_MINER_UI_BASE_URL = "http://localhost:5174";
const DISCOVERY_API_PATH = "/api/discovery";
// Loopback only, on purpose: the endpoint serves the operator's own local discovery scores and is itself
// loopback-guarded, so pointing the extension at an arbitrary remote host is never valid. Empty -> the default.
const MINER_UI_BASE_URL_PATTERN = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/?$/i;

function normalizeMinerUiBaseUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return DEFAULT_MINER_UI_BASE_URL;
  if (!MINER_UI_BASE_URL_PATTERN.test(trimmed)) {
    throw new Error("Miner UI base URL must be a http://localhost or http://127.0.0.1 address.");
  }
  return trimmed.replace(/\/+$/, "");
}

// Fetch the ranked candidates from the local miner-ui discovery endpoint. Runs from the options page (a
// chrome-extension:// origin holding the localhost host permission), so the browser bypasses CORS. `fetchImpl`
// is injectable so the unit harness never opens a real socket. Throws a human-readable message on every failure
// mode so the paste fallback below stays a sensible next step for the operator.
async function fetchLiveRankedCandidates(baseUrl, fetchImpl = fetch) {
  const normalizedBase = normalizeMinerUiBaseUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(`${normalizedBase}${DISCOVERY_API_PATH}`, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(`Could not reach the miner UI at ${normalizedBase}. Is it running?`);
  }
  if (!response.ok) {
    throw new Error(`Miner UI responded ${response.status} for ${DISCOVERY_API_PATH}.`);
  }
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.rankedCandidates)) {
    throw new Error("Miner UI response did not contain a ranked-candidates list.");
  }
  return payload.rankedCandidates;
}

// #5343 dropped the discoveryIndexUrl UI field and stopped reading/writing it, but chrome.storage.sync.set
// only merges keys -- it never deletes ones an earlier extension version already synced. Without an active
// purge, a value synced before #5343 stays in the user's account indefinitely. Called from refreshSettings,
// which runs on every options-page load and again at the end of every save, so it's cleared promptly
// regardless of which path a given user hits first.
async function removeLegacyDiscoveryIndexUrl() {
  await chrome.storage.sync.remove("discoveryIndexUrl");
}

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOptionsInternals = {
    parseWatchedRepos,
    parseRankedCandidatesJson,
    removeLegacyDiscoveryIndexUrl,
    normalizeMinerUiBaseUrl,
    fetchLiveRankedCandidates,
    DEFAULT_MINER_UI_BASE_URL,
    DISCOVERY_API_PATH,
  };
}

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const watchedRepos = document.querySelector("#watchedRepos");
const rankedCandidatesJson = document.querySelector("#rankedCandidatesJson");
// Optional live-fetch controls (#4859): absent in the unit harness and older popups, so every use is guarded.
const minerUiBaseUrl = document.querySelector("#minerUiBaseUrl");
const fetchLive = document.querySelector("#fetchLive");

if (!form || !status || !watchedRepos || !rankedCandidatesJson) {
  // options.html is not mounted (unit-test harness or partial load).
} else {
void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const repos = parseWatchedRepos(watchedRepos.value);
    const rankedCandidates = parseRankedCandidatesJson(rankedCandidatesJson.value);
    const settingsToSync = { watchedRepos: repos };
    if (minerUiBaseUrl) settingsToSync.minerUiBaseUrl = normalizeMinerUiBaseUrl(minerUiBaseUrl.value);
    await chrome.storage.sync.set(settingsToSync);
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

if (fetchLive) {
  fetchLive.addEventListener("click", async () => {
    try {
      const baseUrl = normalizeMinerUiBaseUrl(minerUiBaseUrl ? minerUiBaseUrl.value : "");
      const rankedCandidates = await fetchLiveRankedCandidates(baseUrl);
      await chrome.storage.sync.set({ minerUiBaseUrl: baseUrl });
      await chrome.storage.local.set({ rankedCandidates, rankedCandidatesSavedAt: Date.now() });
      await refreshSettings();
      showStatus(`Fetched ${rankedCandidates.length} ranked candidate(s) from the miner UI.`);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error));
    }
  });
}
}

async function refreshSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [], minerUiBaseUrl: "" });
  await removeLegacyDiscoveryIndexUrl();
  const local = await chrome.storage.local.get({ rankedCandidates: [] });
  const repos = Array.isArray(stored.watchedRepos) ? stored.watchedRepos : [];
  watchedRepos.value = repos.join("\n");
  if (minerUiBaseUrl) {
    minerUiBaseUrl.value =
      typeof stored.minerUiBaseUrl === "string" && stored.minerUiBaseUrl ? stored.minerUiBaseUrl : "";
  }
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
