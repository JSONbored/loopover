const DEFAULT_API_ORIGIN = "https://gittensory-api.aethereal.dev";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "gittensory:pull-context") return false;
  void loadPullContext(message)
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function loadPullContext(message) {
  const settings = await chrome.storage.sync.get(["apiOrigin", "sessionToken"]);
  const apiOrigin = String(settings.apiOrigin || DEFAULT_API_ORIGIN).replace(/\/$/, "");
  const token = String(settings.sessionToken || "");
  if (!token) throw new Error("Set an extension session token in Gittensory extension options.");
  const url = new URL(`${apiOrigin}/v1/extension/pull-context`);
  url.searchParams.set("owner", message.owner);
  url.searchParams.set("repo", message.repo);
  url.searchParams.set("pullNumber", String(message.pullNumber));
  const response = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
  return payload;
}
