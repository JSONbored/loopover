import {
  DEFAULT_API_ORIGIN,
  clearExtensionSession,
  loadExtensionSession,
  logoutExtensionSession,
  saveExtensionApiOrigin,
  storeExtensionSessionToken,
} from "./auth.js";

const form = document.querySelector("#settings");
const status = document.querySelector("#status");
const apiOrigin = document.querySelector("#apiOrigin");
const sessionToken = document.querySelector("#sessionToken");
const sessionExpiresAt = document.querySelector("#sessionExpiresAt");
const sessionSummary = document.querySelector("#sessionSummary");
const logout = document.querySelector("#logout");
const clearLocal = document.querySelector("#clearLocal");

void refreshSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveExtensionApiOrigin(apiOrigin.value.trim() || DEFAULT_API_ORIGIN);
    const token = sessionToken.value.trim();
    if (token) {
      await storeExtensionSessionToken({ token, expiresAt: sessionExpiresAt.value.trim(), scopes: ["extension:pull_context"] });
    }
    await refreshSettings();
    showStatus(token ? "Extension session saved locally." : "Settings saved.");
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error));
  }
});

logout.addEventListener("click", async () => {
  logout.disabled = true;
  try {
    await logoutExtensionSession();
    await refreshSettings();
    showStatus("Logged out and cleared the local extension session.");
  } catch (error) {
    await clearExtensionSession();
    await refreshSettings();
    showStatus(error instanceof Error ? error.message : String(error));
  } finally {
    logout.disabled = false;
  }
});

clearLocal.addEventListener("click", async () => {
  await clearExtensionSession();
  await refreshSettings();
  showStatus("Local extension session cleared.");
});

async function refreshSettings() {
  const settings = await loadExtensionSession();
  apiOrigin.value = settings.apiOrigin || DEFAULT_API_ORIGIN;
  sessionToken.value = "";
  sessionToken.placeholder = settings.sessionToken ? "Stored locally - leave blank to keep current token" : "Paste gts_ extension session token";
  sessionExpiresAt.value = settings.expiresAt || "";
  logout.disabled = !settings.sessionToken;
  clearLocal.disabled = !settings.sessionToken;
  if (!settings.sessionToken) {
    sessionSummary.textContent = "No extension session stored.";
  } else if (settings.expired) {
    sessionSummary.textContent = "Stored extension session is expired. Save a fresh token or clear local state.";
  } else {
    const expires = settings.expiresAt ? ` Expires ${settings.expiresAt}.` : "";
    sessionSummary.textContent = `Extension session stored in browser local storage.${expires}`;
  }
}

function showStatus(message) {
  status.textContent = message;
  window.setTimeout(() => {
    status.textContent = "";
  }, 2600);
}
