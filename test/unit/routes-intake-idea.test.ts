import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildTaskGraph, IDEA_TITLE_MAX_CHARS, validateIdeaSubmission } from "../../src/idea-intake";
import { createTestEnv } from "../helpers/d1";

// #6755: POST /v1/loop/intake-idea — the REST mirror bringing loopover_intake_idea to the same parity its
// same-tier sibling loopover_check_slop_risk (/v1/lint/slop-risk) already has. The route delegates to the pure
// validateIdeaSubmission/buildTaskGraph (covered by their own unit tests), so these pin the ROUTE contract: the
// task-graph and verdict are returned unmodified, a malformed/empty submission comes back as the engine's
// actionable error list rather than a silent failure, and the deliberately-loose schema still lets the engine
// (not zod) own the real bounds — e.g. an out-of-range `priority` is a string, so only the engine rejects it.
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });
const PATH = "/v1/loop/intake-idea";

const post = (env: Env, body: unknown) =>
  createApp().request(PATH, { method: "POST", headers: apiHeaders(env), body: JSON.stringify(body) }, env);

const VALID = { id: "idea-1", title: "Retry uploads on 5xx", body: "Uploads fail silently on 5xx.", targetRepo: "acme/widgets" };

describe("POST /v1/loop/intake-idea (#6755)", () => {
  it("turns a valid submission into a scored task-graph", async () => {
    const env = createTestEnv();
    const response = await post(env, VALID);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; verdict: string; taskGraph: { ideaId: string; issues: unknown[] } };
    expect(payload.ok).toBe(true);
    expect(["go", "raise", "avoid"]).toContain(payload.verdict);
    expect(payload.taskGraph.ideaId).toBe("idea-1");
    // No decomposition supplied => the single-issue baseline.
    expect(payload.taskGraph.issues).toHaveLength(1);
  });

  it("assembles the caller-supplied decomposition instead of the baseline", async () => {
    const env = createTestEnv();
    const response = await post(env, {
      ...VALID,
      decomposition: [
        { key: "a", title: "Add retry helper", body: "Introduce the helper." },
        { key: "b", title: "Wire the helper in", body: "Use it in the upload client.", dependsOn: ["a"] },
      ],
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; taskGraph: { issues: Array<{ key: string }> } };
    expect(payload.ok).toBe(true);
    expect(payload.taskGraph.issues.map((i) => i.key)).toEqual(["a", "b"]);
  });

  it("returns exactly what the pure bridge returns for every accepted shape", async () => {
    const env = createTestEnv();
    const cases: unknown[] = [
      VALID,
      { ...VALID, priority: "high" },
      { ...VALID, priority: "normal" },
      { ...VALID, constraints: ["no new deps"], acceptanceHints: ["covered by a unit test"] },
      { ...VALID, decomposition: [{ key: "a", title: "Only issue", body: "Body." }] },
      { ...VALID, decomposition: [{ key: "a", title: "First", body: "Body." }, { key: "b", title: "Second", body: "Body.", dependsOn: ["a"] }] },
    ];
    for (const body of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(200);
      // PARITY: the route must return exactly what the pure functions the MCP tool calls return.
      const validated = validateIdeaSubmission(body);
      expect(validated.ok, JSON.stringify(body)).toBe(true);
      if (!validated.ok) continue;
      const graph = buildTaskGraph(validated.idea, (body as { decomposition?: never }).decomposition);
      await expect(response.json(), JSON.stringify(body)).resolves.toEqual(
        JSON.parse(JSON.stringify({ ok: true, verdict: graph.rubric.verdict, taskGraph: graph })),
      );
    }
  });

  it("returns the engine's actionable error list for a malformed or empty submission", async () => {
    const env = createTestEnv();
    // Each of these passes the deliberately-loose zod schema and is rejected by the engine instead.
    const cases: Array<[unknown, string]> = [
      [{}, "id_required"],
      [{ ...VALID, id: "" }, "id_required"],
      [{ ...VALID, title: "" }, "title_required"],
      [{ ...VALID, body: "" }, "body_required"],
      [{ ...VALID, targetRepo: "" }, "target_repo_required"],
      [{ ...VALID, targetRepo: "not-a-repo" }, "target_repo_malformed"],
      [{ ...VALID, title: "x".repeat(IDEA_TITLE_MAX_CHARS + 1) }, "title_too_long"],
      [{ ...VALID, priority: "urgent" }, "priority_invalid"],
    ];
    for (const [body, expectedError] of cases) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const payload = (await response.json()) as { ok: boolean; errors: string[] };
      expect(payload.ok, JSON.stringify(body)).toBe(false);
      expect(payload.errors, JSON.stringify(body)).toContain(expectedError);
    }
    // An empty submission reports every missing field at once, not just the first.
    const all = (await (await post(env, {})).json()) as { errors: string[] };
    expect(all.errors).toEqual(expect.arrayContaining(["id_required", "title_required", "body_required", "target_repo_required"]));
  });

  it("rejects a schema-invalid or unparseable body with 400", async () => {
    const env = createTestEnv();
    // These cannot reach the engine: the mirrored shape rejects them, exactly as the MCP tool's does.
    for (const body of [
      { ...VALID, title: 7 },
      { ...VALID, constraints: [7] },
      { ...VALID, constraints: "no new deps" },
      { ...VALID, decomposition: [{ key: "a", title: "Missing body" }] },
      { ...VALID, decomposition: Array.from({ length: 51 }, (_, i) => ({ key: `k${i}`, title: "T", body: "B" })) },
    ]) {
      const response = await post(env, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_intake_idea_request" });
    }
    const malformed = await createApp().request(PATH, { method: "POST", headers: apiHeaders(createTestEnv()), body: "{not json" }, createTestEnv());
    expect(malformed.status).toBe(400);
  });

  it("never emits the maintainer-only gittensor:priority label, and leaks no wallet/hotkey terms", async () => {
    const env = createTestEnv();
    const text = JSON.stringify(await (await post(env, { ...VALID, priority: "high" })).json());
    expect(text).not.toContain("gittensor:priority");
    expect(text).not.toMatch(/wallet|hotkey|coldkey|trust score/i);
  });
});
