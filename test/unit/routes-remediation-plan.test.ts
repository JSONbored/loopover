import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";
import { MAX_FOCUS_MANIFEST_BYTES } from "../../src/signals/focus-manifest";

const PATH = "/v1/local/remediation-plan";
const BRANCH_ANALYSIS_PATH = "/v1/local/branch-analysis";

// Mirrors LOCAL_BRANCH_ANALYSIS_MAX_BODY_BYTES in src/api/routes.ts (1 MiB).
const MAX_BODY_BYTES = 1024 * 1024;

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

function branchPayload(login: string, repoFullName: string, extra?: Record<string, unknown>) {
  return {
    login,
    repoFullName,
    branchName: "feat/demo",
    changedFiles: [{ path: "src/demo.ts", additions: 10, deletions: 1 }],
    validation: [{ command: "npm test", status: "failed" }],
    ...extra,
  };
}

async function seedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } },
    installationId,
  );
}

describe("remediation-plan route", () => {
  it("returns 400 for invalid local branch analysis payloads", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PATH, { method: "POST", headers: apiHeaders(env), body: "{}" }, env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_local_branch_analysis_request" });
  });

  it("returns forbidden_contributor when a session login does not match the payload login", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "attacker" });
    await seedRepo(env, "owner", "private-repo", 301);
    const { token } = await createSessionForGitHubUser(env, { login: "attacker", id: 7 });
    const response = await app.request(
      PATH,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(branchPayload("victim", "owner/private-repo")),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
  });

  it("honors caller-supplied focusManifest instead of loading the repo manifest", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "miner", "demo", 301);
    const response = await app.request(
      PATH,
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify(
          branchPayload("oktofeesh1", "miner/demo", {
            focusManifest: { present: true, wantedPaths: ["src/"], source: "caller" },
          }),
        ),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      login: "oktofeesh1",
      repoFullName: "miner/demo",
      items: expect.any(Array),
    });
  });

  it("falls back to the persisted repo manifest when the caller omits focusManifest", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedRepo(env, "miner", "demo", 301);
    await upsertRepoFocusManifest(env, "miner/demo", { wantedPaths: ["src/"], preferredLabels: ["bug"] });
    const response = await app.request(
      PATH,
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify(branchPayload("oktofeesh1", "miner/demo")),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      login: "oktofeesh1",
      repoFullName: "miner/demo",
      summary: expect.any(String),
    });
  });
});

describe("local branch routes byte-cap ingestion bound", () => {
  for (const path of [PATH, BRANCH_ANALYSIS_PATH]) {
    it(`rejects an oversized request body with 413 payload_too_large via Content-Length (${path})`, async () => {
      const app = createApp();
      const env = createTestEnv();
      await seedRepo(env, "miner", "demo", 301);
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: { ...apiHeaders(env), "content-length": String(MAX_BODY_BYTES + 1) },
          body: JSON.stringify(branchPayload("oktofeesh1", "miner/demo")),
        },
        env,
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES });
    });

    it(`rejects an oversized streamed request body with 413 payload_too_large (${path})`, async () => {
      const app = createApp();
      const env = createTestEnv();
      await seedRepo(env, "miner", "demo", 301);
      // A body that exceeds the cap forces the streaming reader (readRequestBodyWithLimit) to bail
      // out even when the Content-Length header is absent/under the limit.
      const oversizedBody = JSON.stringify(
        branchPayload("oktofeesh1", "miner/demo", { body: "x".repeat(MAX_BODY_BYTES + 16) }),
      );
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: apiHeaders(env),
          body: oversizedBody,
        },
        env,
      );
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES });
    });

    it(`rejects a focusManifest that serializes beyond the byte cap with 400 (${path})`, async () => {
      const app = createApp();
      const env = createTestEnv();
      await seedRepo(env, "miner", "demo", 301);
      // Stays under the 1 MiB request-body cap but blows past the focus-manifest serialized byte cap,
      // so it must trip the focusManifestInputSchema refinement (not the body limit).
      const oversizedManifest = { present: true, note: "a".repeat(MAX_FOCUS_MANIFEST_BYTES + 1) };
      const requestBody = JSON.stringify(branchPayload("oktofeesh1", "miner/demo", { focusManifest: oversizedManifest }));
      expect(requestBody.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: apiHeaders(env),
          body: requestBody,
        },
        env,
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_local_branch_analysis_request" });
    });

    it(`accepts a normal-size body and within-cap focusManifest with 200 (${path})`, async () => {
      const app = createApp();
      const env = createTestEnv();
      await seedRepo(env, "miner", "demo", 301);
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: apiHeaders(env),
          body: JSON.stringify(
            branchPayload("oktofeesh1", "miner/demo", {
              focusManifest: { present: true, wantedPaths: ["src/"], source: "caller" },
            }),
          ),
        },
        env,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ login: "oktofeesh1", repoFullName: "miner/demo" });
    });
  }
});
