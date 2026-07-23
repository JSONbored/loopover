import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateSuccessorMatch, REVERSAL_SUPERSEDED_EVENT_TYPE, SUPERSEDED_FILE_OVERLAP_MIN } from "../../src/review/reversal-superseded";
import { recordSupersededReversals } from "../../src/review/outcomes-wire";
import { recordAuditEvent, upsertPullRequestFile, upsertPullRequestFromGitHub } from "../../src/db/repositories";
import * as repositories from "../../src/db/repositories";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { createTestEnv } from "../helpers/d1";

// #8166: the one-shot culture's reversal shape — a bot-closed PR superseded by a merged successor. The pure
// matcher's conservatism and the wire's recording/idempotency are the two load-bearing properties.

const side = (over: Partial<Parameters<typeof evaluateSuccessorMatch>[0]> = {}) => ({
  authorLogin: "alice",
  linkedIssues: [42],
  files: ["src/a.ts", "src/b.ts"],
  ...over,
});

describe("evaluateSuccessorMatch (#8166)", () => {
  it("matches on a shared linked issue — the strongest intent signal — regardless of author/files", () => {
    const heuristics = evaluateSuccessorMatch(side({ authorLogin: "bob", files: [] }), side());
    expect(heuristics).toMatchObject({ sameLinkedIssue: true, sameAuthorFileOverlap: false });
  });

  it("matches on same author + majority file overlap when no linked issue is shared", () => {
    const heuristics = evaluateSuccessorMatch(
      side({ linkedIssues: [], files: ["src/a.ts", "src/b.ts", "src/new.ts"] }),
      side({ linkedIssues: [] }),
    );
    expect(heuristics).toMatchObject({ sameLinkedIssue: false, sameAuthorFileOverlap: true, fileOverlapRatio: 1 });
  });

  it("is conservative: below-threshold overlap, different/unknown authors, and empty closed-file lists all record NOTHING", () => {
    // Overlap below the floor (1 of 3 files).
    expect(
      evaluateSuccessorMatch(side({ linkedIssues: [], files: ["src/a.ts"] }), side({ linkedIssues: [], files: ["src/a.ts", "src/b.ts", "src/c.ts"] })),
    ).toBeNull();
    // Different author.
    expect(evaluateSuccessorMatch(side({ linkedIssues: [], authorLogin: "bob" }), side({ linkedIssues: [] }))).toBeNull();
    // Unknown authors never match the author path.
    expect(evaluateSuccessorMatch(side({ linkedIssues: [], authorLogin: null }), side({ linkedIssues: [], authorLogin: null }))).toBeNull();
    expect(evaluateSuccessorMatch(side({ linkedIssues: [], authorLogin: "  " }), side({ linkedIssues: [], authorLogin: "  " }))).toBeNull();
    // Closed PR with no recorded files: ratio is null, the author path can never fire.
    const noFiles = evaluateSuccessorMatch(side({ linkedIssues: [] }), side({ linkedIssues: [], files: [] }));
    expect(noFiles).toBeNull();
    // Neither side links issues and files half-overlap exactly at the floor: matches (boundary is inclusive).
    expect(
      evaluateSuccessorMatch(side({ linkedIssues: [], files: ["src/a.ts"] }), side({ linkedIssues: [], files: ["src/a.ts", "src/b.ts"] })),
    ).toMatchObject({ sameAuthorFileOverlap: true, fileOverlapRatio: SUPERSEDED_FILE_OVERLAP_MIN });
  });

  it("author comparison is case-insensitive and trimmed", () => {
    expect(
      evaluateSuccessorMatch(side({ linkedIssues: [], authorLogin: " Alice " }), side({ linkedIssues: [], authorLogin: "alice" })),
    ).not.toBeNull();
  });
});

describe("recordSupersededReversals (#8166 wire)", () => {
  const REPO = "owner/repo";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seedClosedPr(env: Env, number: number, options: { author?: string; body?: string; files?: string[]; dryRun?: boolean } = {}) {
    await upsertPullRequestFromGitHub(env, REPO, {
      number,
      title: `PR ${number}`,
      state: "closed",
      body: options.body ?? "Closes #42",
      user: { login: options.author ?? "alice" },
      head: { sha: `sha${number}` },
      labels: [],
    });
    for (const path of options.files ?? ["src/a.ts", "src/b.ts"]) {
      await upsertPullRequestFile(env, { repoFullName: REPO, pullNumber: number, path, status: "modified", additions: 1, deletions: 1, changes: 2, payload: {} });
    }
    await recordAuditEvent(env, {
      eventType: "agent.action.close",
      targetKey: `${REPO}#${number}`,
      outcome: "completed",
      ...(options.dryRun ? { metadata: { mode: "dry_run" } } : {}),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
  }

  async function seedMergedPr(env: Env, number: number, options: { author?: string; body?: string; files?: string[] } = {}) {
    await upsertPullRequestFromGitHub(env, REPO, {
      number,
      title: `PR ${number}`,
      state: "closed",
      merged_at: new Date().toISOString(),
      body: options.body ?? "Closes #42",
      user: { login: options.author ?? "alice" },
      head: { sha: `sha${number}` },
      labels: [],
    });
    for (const path of options.files ?? ["src/a.ts", "src/b.ts"]) {
      await upsertPullRequestFile(env, { repoFullName: REPO, pullNumber: number, path, status: "modified", additions: 1, deletions: 1, changes: 2, payload: {} });
    }
  }

  async function supersededRows(env: Env) {
    const rows = await env.DB.prepare("SELECT target_key, metadata_json FROM audit_events WHERE event_type = ?")
      .bind(REVERSAL_SUPERSEDED_EVENT_TYPE)
      .all<{ target_key: string; metadata_json: string }>();
    return rows.results ?? [];
  }

  it("records the superseded reversal + the per-rule reversed overrides that feed the corpus's positive class", async () => {
    const env = createTestEnv();
    await seedClosedPr(env, 7);
    // The closed PR's own fired signal — the thing the override must mark reversed.
    await createSignalStore(env).recordRuleFired({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: `${REPO}#7`,
      outcome: "unaddressed",
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      metadata: { confidence: 0.8 },
    });
    await seedMergedPr(env, 9);

    await recordSupersededReversals(env, REPO, 9, "alice");

    const rows = await supersededRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_key).toBe(`${REPO}#7`);
    const metadata = JSON.parse(rows[0]!.metadata_json) as { supersededBy: number; heuristics: { sameLinkedIssue: boolean } };
    expect(metadata.supersededBy).toBe(9);
    expect(metadata.heuristics.sameLinkedIssue).toBe(true);

    const overrides = await env.DB.prepare("SELECT metadata_json FROM audit_events WHERE event_type = 'signal.human_override:linked_issue_scope_mismatch' AND target_key = ?")
      .bind(`${REPO}#7`)
      .all<{ metadata_json: string }>();
    expect(overrides.results).toHaveLength(1);
    expect(JSON.parse(overrides.results![0]!.metadata_json).verdict).toBe("reversed");
  });

  it("is idempotent per closed target and skips: itself, dry-run closes, and non-matching candidates", async () => {
    const env = createTestEnv();
    await seedClosedPr(env, 7); // matches (shared issue #42)
    await seedClosedPr(env, 8, { body: "Different work entirely", author: "someone-else", files: ["docs/x.md"] }); // no match
    await seedClosedPr(env, 11, { dryRun: true }); // dry-run close is not a bot close
    await seedMergedPr(env, 9);

    await recordSupersededReversals(env, REPO, 9, "alice");
    await recordSupersededReversals(env, REPO, 9, "alice"); // second pass must be a no-op

    const rows = await supersededRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target_key).toBe(`${REPO}#7`);
  });

  it("skips a self-close (the merged PR was itself bot-closed once), garbage target keys, and closes with no stored record", async () => {
    const env = createTestEnv();
    await seedMergedPr(env, 9);
    // The merged PR itself carries a historical bot-close row -- must never supersede itself.
    await recordAuditEvent(env, { eventType: "agent.action.close", targetKey: `${REPO}#9`, outcome: "completed", createdAt: new Date(Date.now() - 90_000).toISOString() });
    // A garbled target key whose number cannot parse.
    await recordAuditEvent(env, { eventType: "agent.action.close", targetKey: `${REPO}#junk`, outcome: "completed", createdAt: new Date(Date.now() - 90_000).toISOString() });
    // A real-looking close with NO stored pull_requests record behind it.
    await recordAuditEvent(env, { eventType: "agent.action.close", targetKey: `${REPO}#55`, outcome: "completed", createdAt: new Date(Date.now() - 90_000).toISOString() });

    await recordSupersededReversals(env, REPO, 9, "alice");
    expect(await supersededRows(env)).toHaveLength(0);
  });

  it("stays best-effort per write: a rejecting audit-event write and rejecting override writes are swallowed, the review_audit record survives", async () => {
    const env = createTestEnv();
    await seedClosedPr(env, 7);
    await seedMergedPr(env, 9);
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("D1 write error"));
    // A synchronous construction failure is the only shape that rejects BOTH override recorders
    // (the #8104 one catches per-code internally, so a queryRuleHistory throw never escapes it).
    vi.spyOn(signalTrackingWire, "createSignalStore").mockImplementation(() => {
      throw new Error("signal store down");
    });

    await expect(recordSupersededReversals(env, REPO, 9, "alice")).resolves.toBeUndefined();

    const audit = await env.DB.prepare("SELECT event_type FROM review_audit WHERE event_type = ?")
      .bind(REVERSAL_SUPERSEDED_EVENT_TYPE)
      .all<{ event_type: string }>();
    expect(audit.results).toHaveLength(1);
    // The mocked write rejected, so no audit_events superseded row can exist — proves the spy actually intercepted.
    expect(await supersededRows(env)).toHaveLength(0);
  });

  it("treats an undefined D1 result set as no candidates and falls back to the stored author when the payload has none", async () => {
    const env = createTestEnv();
    await seedMergedPr(env, 9);
    const origPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) =>
      sql.includes("SELECT DISTINCT target_key")
        ? ({ bind: () => ({ all: async () => ({ results: undefined }) }) } as never)
        : origPrepare(sql)) as typeof env.DB.prepare;

    // Null payload author exercises the mergedRecord.authorLogin fallback.
    await expect(recordSupersededReversals(env, REPO, 9, null)).resolves.toBeUndefined();
    env.DB.prepare = origPrepare;
    expect(await supersededRows(env)).toHaveLength(0);
  });

  it("records nothing when the merged PR has no stored record, and fails safe (never throws) on a broken DB", async () => {
    const env = createTestEnv();
    await recordSupersededReversals(env, REPO, 999, "alice");
    expect(await supersededRows(env)).toHaveLength(0);

    const broken = createTestEnv();
    broken.DB = { prepare: () => { throw new Error("boom"); } } as never;
    await expect(recordSupersededReversals(broken, REPO, 1, "alice")).resolves.toBeUndefined();
  });
});
