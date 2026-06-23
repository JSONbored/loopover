import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { computeStateMigrationReadiness } from "../../src/review/state-migration";
import { createTestEnv } from "../helpers/d1";

async function run(env: Env, sql: string, ...binds: unknown[]) {
  await env.DB.prepare(sql).bind(...binds).run();
}

async function seedCutoverRepo(env: Env, fullName = "JSONbored/gittensory", headSha = "abc123") {
  const [owner, name] = fullName.split("/");
  await upsertRepositoryFromGitHub(env, { name: name!, full_name: fullName, private: false, owner: { login: owner! }, default_branch: "main" }, 1);
  await run(env, "UPDATE repositories SET is_registered = 1, registry_config_json = ? WHERE full_name = ?", JSON.stringify({ repo: fullName, emissionShare: 0.01, issueDiscoveryShare: 0, labelMultipliers: {}, maintainerCut: 0, raw: {} }), fullName);
  await upsertPullRequestFromGitHub(env, fullName, { number: 7, title: "Converge state migration", state: "open", user: { login: "miner" }, labels: [], head: { sha: headSha, ref: "feat" }, base: { ref: "main" } });
}

async function seedMigratedState(env: Env, fullName = "JSONbored/gittensory", headSha = "abc123") {
  await run(
    env,
    `INSERT INTO review_targets (id, project, kind, repo, number, head_sha, decided_sha, approved_sha, status, decision_json)
     VALUES (?, ?, 'pr', ?, ?, ?, ?, ?, 'queued', ?)`,
    `${fullName}:pr:${fullName}#7`,
    fullName,
    fullName,
    7,
    headSha,
    headSha,
    headSha,
    JSON.stringify({ verdict: "merge", reasonCode: "all_clear" }),
  );
  await run(
    env,
    `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary)
     VALUES ('audit-1', ?, ?, 'gate_decision', 'merge', 'reviewbot', ?, 'all_clear')`,
    fullName,
    `${fullName}#7`,
    headSha,
  );
  await run(env, `INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, 'miner', 3, 2, 1, 0, CURRENT_TIMESTAMP)`, fullName);
  await run(env, `INSERT INTO tunables_overrides (project, confidence_floor, scope_cap_files, scope_cap_lines) VALUES (?, 0.8, 10, 400)`, fullName);
  await run(env, `INSERT INTO tunables_overrides_shadow (project, confidence_floor, scope_cap_files, scope_cap_lines, validated_until) VALUES (?, 0.82, 8, 300, CURRENT_TIMESTAMP)`, fullName);
  await run(env, `INSERT INTO override_audit (id, project, event_type, detail) VALUES ('override-1', ?, 'apply', 'seeded migration')`, fullName);
}

describe("computeStateMigrationReadiness", () => {
  it("returns a clean dry-run when migrated cutover state is present", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
    await seedCutoverRepo(env);
    await seedMigratedState(env);

    const report = await computeStateMigrationReadiness(env);
    expect(report.dryRun).toBe(true);
    expect(report.cutoverRepos).toEqual(["jsonbored/gittensory"]);
    expect(report.ready).toBe(true);
    expect(report.stormGuard.massReenqueueRisk).toBe(false);
    expect(report.stormGuard.cachedHeadMatches).toBe(1);
    expect(report.blockers).toEqual([]);
  });

  it("flags storm risk when an open cutover PR lacks migrated decision-cache state", async () => {
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
    await seedCutoverRepo(env);
    await run(env, `INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, 'miner', 1, 0, 1, 0, CURRENT_TIMESTAMP)`, "JSONbored/gittensory");
    await run(
      env,
      `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, head_sha, summary)
       VALUES ('audit-1', 'JSONbored/gittensory', 'JSONbored/gittensory#7', 'gate_decision', 'merge', 'reviewbot', 'abc123', 'all_clear')`,
    );
    await run(env, `INSERT INTO override_audit (id, project, event_type, detail) VALUES ('override-1', 'JSONbored/gittensory', 'apply', 'seeded migration')`);

    const report = await computeStateMigrationReadiness(env);
    expect(report.ready).toBe(false);
    expect(report.stormGuard.massReenqueueRisk).toBe(true);
    expect(report.stormGuard.missingTargetRows).toEqual([{ repoFullName: "JSONbored/gittensory", pullNumber: 7, headSha: "abc123" }]);
    expect(report.blockers.join(" ")).toMatch(/missing.*review_targets|decision cache/i);
  });
});

describe("GET /v1/internal/state-migration-readiness", () => {
  const bearer = (env: Env) => ({ authorization: `Bearer ${env.INTERNAL_JOB_TOKEN}` });

  it("is bearer-gated and returns the dry-run readiness report", async () => {
    const app = createApp();
    const env = createTestEnv({ GITTENSORY_REVIEW_REPOS: "JSONbored/gittensory" });
    await seedCutoverRepo(env);
    await seedMigratedState(env);

    expect((await app.request("/v1/internal/state-migration-readiness", {}, env)).status).toBe(401);
    const res = await app.request("/v1/internal/state-migration-readiness", { headers: bearer(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Awaited<ReturnType<typeof computeStateMigrationReadiness>>;
    expect(body.dryRun).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.stormGuard.massReenqueueRisk).toBe(false);
  });
});
