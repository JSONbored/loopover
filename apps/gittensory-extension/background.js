import { logoutExtensionSession, requestPullContext } from "./auth.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["gittensory:pull-context", "gittensory:logout"].includes(message.type)) return false;
  const task = message.type === "gittensory:logout" ? logoutExtensionSession() : requestPullContext(message);
  void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
