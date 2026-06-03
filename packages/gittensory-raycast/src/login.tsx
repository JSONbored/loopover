import { getPreferenceValues, open, showHUD, showToast, Toast } from "@raycast/api";
import { loginAndPersist } from "../lib/auth";
import { normalizeApiOrigin } from "../lib/config";
import { saveApiOrigin } from "../lib/storage";
import { createRaycastStorageAdapter } from "./storage";

type Preferences = { apiOrigin?: string };

export default async function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const apiOrigin = normalizeApiOrigin(preferences.apiOrigin);
  const adapter = createRaycastStorageAdapter();
  await saveApiOrigin(adapter, apiOrigin);
  const toast = await showToast({ style: Toast.Style.Animated, title: "Starting GitHub Device Flow…" });
  try {
    const session = await loginAndPersist(adapter, apiOrigin, {
      onStart: async (start) => {
        await open(start.verificationUri);
        toast.message = `Enter code ${start.userCode} in your browser`;
      },
    });
    toast.style = Toast.Style.Success;
    toast.title = "Signed in";
    toast.message = session.login ? `Authenticated as ${session.login}` : "Gittensory session ready";
    await showHUD("Gittensory login complete");
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Login failed";
    toast.message = error instanceof Error ? error.message : "device_flow_failed";
  }
}
