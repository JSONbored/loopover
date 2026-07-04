import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processJob } from "../../src/queue/processors";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { getLastRepoDocRefreshAttemptedAt } from "../../src/github/repo-doc-refresh-runner";
import { createTestEnv } from "../helpers/d1";
import type { JobMessage } from "../../src/types";

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

const TOKEN_URL = /\/access_tokens$/;

describe("repo-doc-refresh-sweep fan-out (#3003)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enqueues one job per enabled+due repo, skipping a disabled repo entirely", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "enabled-repo", full_name: "owner/enabled-repo", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/enabled-repo", { repoDocGeneration: { enabled: true } });
    await upsertRepositoryFromGitHub(env, { name: "disabled-repo", full_name: "owner/disabled-repo", private: false, owner: { login: "owner" } });
    // owner/disabled-repo has no repoDocGeneration config at all -- defaults to disabled.

    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "repo-doc-refresh-sweep", repoFullName: "owner/enabled-repo" });
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?").bind("repo_doc.refresh.fanout").first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, requestedBy: "schedule" });
  });

  it("skips an enabled repo that was already attempted within its own refresh interval", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } }, 555);
    await upsertRepoFocusManifest(env, "owner/widgets", { repoDocGeneration: { enabled: true, refreshIntervalDays: 7 } });
    // A prior attempt "just now" -- well within the 7-day interval, so this repo is not due yet.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (TOKEN_URL.test(input.toString()) ? Response.json({ token: "t" }) : new Response("unexpected", { status: 500 })));
    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "schedule", repoFullName: "owner/widgets" });
    vi.unstubAllGlobals();
    sent.length = 0;

    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(0);
  });

  it("staggers a second due repo's enqueue delay", async () => {
    const sent: Array<{ message: JobMessage; delaySeconds?: number }> = [];
    const env = createTestEnv({
      JOBS: { async send(m: JobMessage, options?: { delaySeconds?: number }) { sent.push({ message: m, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) }); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "owner/repo-a", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/repo-a", { repoDocGeneration: { enabled: true } });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "owner/repo-b", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/repo-b", { repoDocGeneration: { enabled: true } });

    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(2);
    expect(sent.some((s) => (s.delaySeconds ?? 0) > 0)).toBe(true);
  });

  it("no-ops safely on a missing repoFullName (test mode) without fanning out", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/widgets", { repoDocGeneration: { enabled: true } });

    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "test" });

    expect(sent).toHaveLength(0);
  });

  it("dispatches a per-repo message to performRepoDocRefresh, recording an attempt marker", async () => {
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } }, 555);
    // repoDocGeneration left disabled (default) -- performRepoDocRefresh should decline cleanly, not throw,
    // and still record that a refresh was attempted.
    await processJob(env, { type: "repo-doc-refresh-sweep", requestedBy: "schedule", repoFullName: "owner/widgets" });

    expect(await getLastRepoDocRefreshAttemptedAt(env, "owner/widgets")).not.toBeNull();
  });
});
