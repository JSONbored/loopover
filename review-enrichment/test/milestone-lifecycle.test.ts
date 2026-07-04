// Units for the milestone-lifecycle analyzer. Own file (not enrichment.test.ts) so concurrent analyzer PRs don't
// collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMilestoneLifecycle,
  scanMilestoneLifecycle,
} from "../dist/analyzers/milestone-lifecycle.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "test-token",
  ...extra,
});

const NOW = Date.parse("2026-01-10T00:00:00Z");

test("evaluateMilestoneLifecycle: flags an open milestone whose due date has passed", () => {
  const findings = evaluateMilestoneLifecycle(
    { title: "v1.0", due_on: "2026-01-05T00:00:00Z", state: "open" },
    NOW,
  );
  assert.deepEqual(findings, [{ milestoneTitle: "v1.0", kind: "overdue-milestone", daysOverdue: 5 }]);
});

test("evaluateMilestoneLifecycle: an open milestone whose due date is in the future is not flagged", () => {
  const findings = evaluateMilestoneLifecycle(
    { title: "v1.0", due_on: "2026-02-01T00:00:00Z", state: "open" },
    NOW,
  );
  assert.deepEqual(findings, []);
});

test("evaluateMilestoneLifecycle: an open milestone due exactly now (0 full days overdue) is not flagged", () => {
  const findings = evaluateMilestoneLifecycle({ title: "v1.0", due_on: new Date(NOW).toISOString(), state: "open" }, NOW);
  assert.deepEqual(findings, []);
});

test("evaluateMilestoneLifecycle: an open milestone with no due date is not flagged", () => {
  const findings = evaluateMilestoneLifecycle({ title: "v1.0", due_on: null, state: "open" }, NOW);
  assert.deepEqual(findings, []);
});

test("evaluateMilestoneLifecycle: flags a milestone that has already been closed", () => {
  const findings = evaluateMilestoneLifecycle(
    { title: "v1.0", due_on: "2026-02-01T00:00:00Z", state: "closed" },
    NOW,
  );
  assert.deepEqual(findings, [{ milestoneTitle: "v1.0", kind: "milestone-already-closed" }]);
});

test("evaluateMilestoneLifecycle: a closed milestone takes priority over an overdue due date (mutually exclusive)", () => {
  const findings = evaluateMilestoneLifecycle(
    { title: "v1.0", due_on: "2026-01-01T00:00:00Z", state: "closed" },
    NOW,
  );
  assert.deepEqual(findings, [{ milestoneTitle: "v1.0", kind: "milestone-already-closed" }]);
});

test("evaluateMilestoneLifecycle: no milestone yields no finding", () => {
  assert.deepEqual(evaluateMilestoneLifecycle(null, NOW), []);
  assert.deepEqual(evaluateMilestoneLifecycle(undefined, NOW), []);
});

test("evaluateMilestoneLifecycle: a milestone with no title is treated as absent, not thrown", () => {
  assert.deepEqual(evaluateMilestoneLifecycle({ due_on: "2020-01-01T00:00:00Z", state: "open" }, NOW), []);
});

test("evaluateMilestoneLifecycle: a malformed due_on does not throw and is not flagged", () => {
  const findings = evaluateMilestoneLifecycle({ title: "v1.0", due_on: "not-a-date", state: "open" }, NOW);
  assert.deepEqual(findings, []);
});

test("scanMilestoneLifecycle: end-to-end resolves an overdue-milestone finding", async () => {
  const findings = await scanMilestoneLifecycle(
    req(),
    async () => jsonResponse({ milestone: { title: "v1.0", due_on: "2026-01-05T00:00:00Z", state: "open" } }),
    { now: NOW },
  );
  assert.deepEqual(findings, [{ milestoneTitle: "v1.0", kind: "overdue-milestone", daysOverdue: 5 }]);
});

test("scanMilestoneLifecycle: requests the expected URL shape", async () => {
  let requestedUrl;
  await scanMilestoneLifecycle(req(), async (url) => {
    requestedUrl = url;
    return jsonResponse({});
  });
  assert.equal(requestedUrl, "https://api.github.com/repos/octo/repo/issues/7");
});

test("scanMilestoneLifecycle: no milestone on the issue yields no finding", async () => {
  const findings = await scanMilestoneLifecycle(req(), async () => jsonResponse({ milestone: null }));
  assert.deepEqual(findings, []);
});

test("scanMilestoneLifecycle: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanMilestoneLifecycle(
    req({ githubToken: undefined }),
    async () => jsonResponse({ milestone: { title: "v1.0", due_on: "2020-01-01T00:00:00Z", state: "open" } }),
  );
  assert.deepEqual(findings, []);
});

test("scanMilestoneLifecycle: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanMilestoneLifecycle(
    req({ repoFullName: "not-a-valid-slug" }),
    async () => jsonResponse({ milestone: { title: "v1.0", due_on: "2020-01-01T00:00:00Z", state: "open" } }),
  );
  assert.deepEqual(findings, []);
});

test("scanMilestoneLifecycle: a fetch failure yields no finding", async () => {
  const findings = await scanMilestoneLifecycle(req(), async () => jsonResponse({ message: "bad" }, 500));
  assert.deepEqual(findings, []);
});
