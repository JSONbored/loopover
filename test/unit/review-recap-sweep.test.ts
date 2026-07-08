import { describe, expect, it } from "vitest";
import { processJob } from "../../src/queue/processors";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { getLastReviewRecapAttemptedAt } from "../../src/services/review-recap-runner";
import { createTestEnv } from "../helpers/d1";
import type { JobMessage } from "../../src/types";

describe("review-recap-sweep fan-out (#1963)", () => {
  it("enqueues one generate-review-recap job per enabled+due repo, skipping disabled repos", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "enabled-repo", full_name: "owner/enabled-repo", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/enabled-repo", { reviewRecap: { enabled: true } });
    await upsertRepositoryFromGitHub(env, { name: "disabled-repo", full_name: "owner/disabled-repo", private: false, owner: { login: "owner" } });

    await processJob(env, { type: "review-recap-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "generate-review-recap", repoFullName: "owner/enabled-repo" });
    const fanout = await env.DB.prepare("select outcome, metadata_json from audit_events where event_type = ?")
      .bind("review_recap.fanout")
      .first<{ outcome: string; metadata_json: string }>();
    expect(fanout?.outcome).toBe("queued");
    expect(JSON.parse(fanout?.metadata_json ?? "{}")).toMatchObject({ repoCount: 1, requestedBy: "schedule" });
  });

  it("skips an enabled repo that was already attempted within its cadence", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/widgets", { reviewRecap: { enabled: true, cadenceDays: 7 } });
    await processJob(env, { type: "generate-review-recap", requestedBy: "test", repoFullName: "owner/widgets" });
    sent.length = 0;

    await processJob(env, { type: "review-recap-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(0);
  });

  it("staggers a second due repo's enqueue delay", async () => {
    const sent: Array<{ message: JobMessage; delaySeconds?: number }> = [];
    const env = createTestEnv({
      JOBS: {
        async send(m: JobMessage, options?: { delaySeconds?: number }) {
          sent.push({ message: m, ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) });
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "repo-a", full_name: "owner/repo-a", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/repo-a", { reviewRecap: { enabled: true } });
    await upsertRepositoryFromGitHub(env, { name: "repo-b", full_name: "owner/repo-b", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/repo-b", { reviewRecap: { enabled: true } });

    await processJob(env, { type: "review-recap-sweep", requestedBy: "schedule" });

    expect(sent).toHaveLength(2);
    expect(sent.some((s) => (s.delaySeconds ?? 0) > 0)).toBe(true);
  });

  it("no-ops safely on a missing repoFullName in test mode without fanning out", async () => {
    const sent: JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(message: JobMessage) { sent.push(message); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/widgets", { reviewRecap: { enabled: true } });

    await processJob(env, { type: "review-recap-sweep", requestedBy: "test" });

    expect(sent).toHaveLength(0);
  });

  it("records an attempt marker when dispatching a per-repo sweep message", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: "owner/widgets", private: false, owner: { login: "owner" } });
    await upsertRepoFocusManifest(env, "owner/widgets", { reviewRecap: { enabled: true } });

    await processJob(env, { type: "review-recap-sweep", requestedBy: "schedule", repoFullName: "owner/widgets" });

    expect(await getLastReviewRecapAttemptedAt(env, "owner/widgets")).not.toBeNull();
  });
});
