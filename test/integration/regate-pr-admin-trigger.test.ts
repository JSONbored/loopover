import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { processJob } from "../../src/queue/job-dispatch";
import * as processors from "../../src/queue/processors";
import type { JobMessage } from "../../src/types";

// #8898: the manual admin trigger that finally gives the `agent-regate-pr` job's `force` field a real producer.
describe("POST /v1/internal/jobs/regate-pr (#8898)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues an agent-regate-pr job with force:true and threads force into regatePullRequest end-to-end", async () => {
    const app = createApp();
    const sent: JobMessage[] = [];
    const env = createTestEnv({
      JOBS: { async send(message: unknown) { sent.push(message as JobMessage); } } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 456);
    const headers = { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };

    // A whitespace-padded repoFullName is trimmed and resolved to the stored casing before the job is built.
    const res = await app.request(
      "/v1/internal/jobs/regate-pr",
      { method: "POST", headers, body: JSON.stringify({ repoFullName: " JSONbored/gittensory ", prNumber: 42 }) },
      env,
    );
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, status: "queued", repoFullName: "JSONbored/gittensory", prNumber: 42, force: true });
    const job = sent.at(-1);
    expect(job).toMatchObject({ type: "agent-regate-pr", repoFullName: "JSONbored/gittensory", prNumber: 42, installationId: 456, force: true });
    // The job carries a manual-trigger delivery id so downstream rate-limit admission treats it as real work.
    expect((job as { deliveryId: string }).deliveryId).toMatch(/^manual-regate:/);

    // End-to-end: dispatching the enqueued job hands `force` straight through to regatePullRequest.
    const regateSpy = vi.spyOn(processors, "regatePullRequest").mockResolvedValue(undefined);
    await processJob(env, job as JobMessage);
    expect(regateSpy).toHaveBeenCalledTimes(1);
    // regatePullRequest(env, repairHeadSha, repoFullName, prNumber, installationId, deliveryId, force, prCreatedAt)
    expect(regateSpy.mock.calls[0]?.[6]).toBe(true);
    expect(regateSpy.mock.calls[0]?.[2]).toBe("JSONbored/gittensory");
    expect(regateSpy.mock.calls[0]?.[3]).toBe(42);
  });

  it("400s a missing/blank repo, 400s a non-positive-integer PR number, 404s an uninstalled repo", async () => {
    const app = createApp();
    const env = createTestEnv({ JOBS: { async send() {} } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "gittensory", full_name: "JSONbored/gittensory", private: false, owner: { login: "JSONbored" } }, 456);
    const headers = { authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}`, "content-type": "application/json" };

    // Malformed JSON body → parsed as {} → no repoFullName → 400 (covers the .catch fallback + the blank guard).
    const noRepo = await app.request("/v1/internal/jobs/regate-pr", { method: "POST", headers, body: "{" }, env);
    expect(noRepo.status).toBe(400);
    await expect(noRepo.json()).resolves.toEqual({ error: "repoFullName required" });

    // Non-numeric PR number → NaN → the left arm of the guard short-circuits → 400.
    const nanPr = await app.request("/v1/internal/jobs/regate-pr", { method: "POST", headers, body: JSON.stringify({ repoFullName: "JSONbored/gittensory", prNumber: "not-a-number" }) }, env);
    expect(nanPr.status).toBe(400);
    await expect(nanPr.json()).resolves.toEqual({ error: "prNumber required" });

    // Zero PR number → an integer, so the right arm (<= 0) is what rejects it → 400.
    const zeroPr = await app.request("/v1/internal/jobs/regate-pr", { method: "POST", headers, body: JSON.stringify({ repoFullName: "JSONbored/gittensory", prNumber: 0 }) }, env);
    expect(zeroPr.status).toBe(400);

    // A repo with no stored installation → nothing to authenticate the re-gate against → 404.
    const uninstalled = await app.request("/v1/internal/jobs/regate-pr", { method: "POST", headers, body: JSON.stringify({ repoFullName: "acme/unknown", prNumber: 7 }) }, env);
    expect(uninstalled.status).toBe(404);
    await expect(uninstalled.json()).resolves.toEqual({ error: "repo not installed" });
  });
});
