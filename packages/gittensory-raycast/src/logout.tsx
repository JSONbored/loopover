import { showHUD, showToast, Toast } from "@raycast/api";
import { logoutAndClear } from "../lib/auth";
import { createRaycastStorageAdapter } from "./storage";

export default async function Command() {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Signing out…" });
  try {
    await logoutAndClear(createRaycastStorageAdapter());
    toast.style = Toast.Style.Success;
    toast.title = "Signed out";
    toast.message = "Local Gittensory session cleared";
    await showHUD("Gittensory logout complete");
  } catch (error) {
    toast.style = Toast.Style.Failure;
    toast.title = "Logout failed";
    toast.message = error instanceof Error ? error.message : "logout_failed";
  }
}
