const DEFAULT_API_ORIGIN = "https://gittensory-api.aethereal.dev";

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const apiOrigin = document.querySelector("#apiOrigin");
const sessionToken = document.querySelector("#sessionToken");

void chrome.storage.sync.get(["apiOrigin", "sessionToken"]).then((settings) => {
  apiOrigin.value = settings.apiOrigin || DEFAULT_API_ORIGIN;
  sessionToken.value = settings.sessionToken || "";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.sync.set({
    apiOrigin: apiOrigin.value.trim() || DEFAULT_API_ORIGIN,
    sessionToken: sessionToken.value.trim(),
  });
  status.textContent = "Saved.";
  window.setTimeout(() => {
    status.textContent = "";
  }, 1800);
});
