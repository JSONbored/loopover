import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const FULL_NAME = "owner/repo";
const PATH_PREVIEW = "/v1/repos/owner/repo/activation-preview";
const PATH_ACTIVATE = "/v1/repos/owner/repo/activation";

describe("maintainer activation routes", () => {
  it("lets a maintainer preview activation and flip on advisory mode in one action", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "operator-admin", id: 1 });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const preview = await app.request(PATH_PREVIEW, { headers }, env);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { repoFullName: string; recommendedAction: string | null; currentGateMode: string; evaluatedCount: number };
    expect(previewBody).toMatchObject({ repoFullName: FULL_NAME, recommendedAction: "enable_advisory", currentGateMode: "off", evaluatedCount: 0 });

    const activate = await app.request(PATH_ACTIVATE, { method: "POST", headers, body: "{}" }, env);
    expect(activate.status).toBe(200);
    expect(await activate.json()).toMatchObject({
      repoFullName: FULL_NAME,
      gateCheckMode: "enabled",
      linkedIssueGateMode: "advisory",
      duplicatePrGateMode: "advisory",
      qualityGateMode: "advisory",
    });

    // The flip persisted, and the preview now reports nothing left to enable.
    expect((await getRepositorySettings(env, FULL_NAME)).gateCheckMode).toBe("enabled");
    const afterPreview = await app.request(PATH_PREVIEW, { headers }, env);
    expect((await afterPreview.json() as { recommendedAction: string | null }).recommendedAction).toBeNull();
  });

  it("forbids a non-maintainer session from the activation preview", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "random-user", id: 2 });
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(403);
  });

  it("allows a server-to-server token", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}` } }, env);
    expect(response.status).toBe(200);
  });
});
