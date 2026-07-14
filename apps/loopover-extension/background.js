import { logoutExtensionSession, requestPullContext } from "./auth.js";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !["loopover:pull-context", "loopover:logout"].includes(message.type)) return false;
  const task = message.type === "loopover:logout" ? logoutExtensionSession() : requestPullContext(message);
  void task.then((payload) => sendResponse({ ok: true, payload })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
