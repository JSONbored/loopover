import { Detail, getPreferenceValues, List } from "@raycast/api";
import { getSessionStatus } from "../lib/auth";
import { normalizeApiOrigin } from "../lib/config";
import { sanitizePublicText } from "../lib/sanitize";
import { saveApiOrigin } from "../lib/storage";
import { createRaycastStorageAdapter } from "./storage";

type Preferences = { apiOrigin?: string };

export default async function Command() {
  const preferences = getPreferenceValues<Preferences>();
  const apiOrigin = normalizeApiOrigin(preferences.apiOrigin);
  const adapter = createRaycastStorageAdapter();
  await saveApiOrigin(adapter, apiOrigin);
  const status = await getSessionStatus(adapter);
  if (!status.signedIn) {
    const detail = status.expired ? "Session expired. Run Login again." : "Not signed in. Run Login to authenticate.";
    return <Detail markdown={sanitizePublicText(detail)} />;
  }
  const login = sanitizePublicText(status.login ?? "unknown");
  const expiresAt = status.expiresAt ? sanitizePublicText(status.expiresAt) : "unknown";
  const scopes = (status.scopes ?? []).map((scope) => sanitizePublicText(scope)).join(", ") || "none";
  return (
    <List>
      <List.Item title="Signed in" subtitle={login} />
      <List.Item title="API origin" subtitle={apiOrigin} />
      <List.Item title="Expires" subtitle={expiresAt} />
      <List.Item title="Scopes" subtitle={scopes} />
    </List>
  );
}
