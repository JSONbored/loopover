import { describe, expect, it, vi } from "vitest";

// Force the loader to throw so the route's defensive 503 catch is exercised.
vi.mock("../../src/services/public-quality-metrics", () => ({
  loadPublicQualityMetrics: () => Promise.reject(new Error("quality boom")),
}));

import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";
import { upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";

describe("GET /v1/public/repos/:owner/:repo/quality — error path", () => {
  it("returns 503 when quality metrics computation throws", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "quality", full_name: "acme/quality", private: false, owner: { login: "acme" }, default_branch: "main" }, 560);
    await upsertRepositorySettings(env, { repoFullName: "acme/quality", publicQualityMetrics: true });

    const res = await createApp().request("/v1/public/repos/acme/quality/quality", {}, env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: "public_quality_metrics_unavailable",
    });
  });
});
