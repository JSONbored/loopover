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

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOptionsInternals = {
    parseWatchedRepos,
    parseRankedCandidatesJson,
  };
}

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const watchedRepos = document.querySelector("#watchedRepos");
const discoveryIndexUrl = document.querySelector("#discoveryIndexUrl");
const rankedCandidatesJson = document.querySelector("#rankedCandidatesJson");

if (!form || !status || !watchedRepos || !discoveryIndexUrl || !rankedCandidatesJson) {
  // options.html is not mounted (unit-test harness or partial load).
} else {
void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const repos = parseWatchedRepos(watchedRepos.value);
    const rankedCandidates = parseRankedCandidatesJson(rankedCandidatesJson.value);
    await chrome.storage.sync.set({
      watchedRepos: repos,
      discoveryIndexUrl: discoveryIndexUrl.value.trim(),
    });
    await chrome.storage.local.set({ rankedCandidates });
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
}

async function refreshSettings() {
  const stored = await chrome.storage.sync.get({ watchedRepos: [], discoveryIndexUrl: "" });
  const local = await chrome.storage.local.get({ rankedCandidates: [] });
  const repos = Array.isArray(stored.watchedRepos) ? stored.watchedRepos : [];
  watchedRepos.value = repos.join("\n");
  discoveryIndexUrl.value = typeof stored.discoveryIndexUrl === "string" ? stored.discoveryIndexUrl : "";
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
