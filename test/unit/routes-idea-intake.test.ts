import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import {
  F1_COMPLEX_IDEA_EXAMPLE,
  F1_SIMPLE_IDEA_EXAMPLE,
} from "../../packages/gittensory-engine/src/idea-intake-bridge";
import { createTestEnv } from "../helpers/d1";

const PATH = "/v1/idea-intake/translate";

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`,
    "content-type": "application/json",
  };
}

describe("POST /v1/idea-intake/translate (#4798)", () => {
  it("returns a validated task-graph for F1 worked examples", async () => {
    const app = createApp();
    const env = createTestEnv();

    const simple = await app.request(
      PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(F1_SIMPLE_IDEA_EXAMPLE) },
      env,
    );
    expect(simple.status).toBe(200);
    await expect(simple.json()).resolves.toMatchObject({
      ok: true,
      taskGraph: { repoFullName: "acme/widgets", tasks: [{ id: "task-1" }] },
    });

    const complex = await app.request(
      PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(F1_COMPLEX_IDEA_EXAMPLE) },
      env,
    );
    expect(complex.status).toBe(200);
    const body = (await complex.json()) as { ok: boolean; taskGraph?: { tasks: Array<{ id: string }> } };
    expect(body.ok).toBe(true);
    expect(body.taskGraph?.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("returns actionable 400 errors for invalid requests and malformed JSON", async () => {
    const app = createApp();
    const env = createTestEnv();

    const invalidShape = await app.request(
      PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: 123, idea: "Ship it" }) },
      env,
    );
    expect(invalidShape.status).toBe(400);
    await expect(invalidShape.json()).resolves.toMatchObject({ error: "invalid_idea_intake_request" });

    const malformed = await app.request(
      PATH,
      { method: "POST", headers: apiHeaders(env), body: "{not json" },
      env,
    );
    expect(malformed.status).toBe(400);

    const translateFailure = await app.request(
      PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: "bad", idea: "Ship export" }) },
      env,
    );
    expect(translateFailure.status).toBe(400);
    await expect(translateFailure.json()).resolves.toMatchObject({
      ok: false,
      errors: [{ code: "invalid_repo_full_name", field: "repoFullName" }],
    });
  });
});
