// Units for the pending review-request staleness analyzer. Own file (not enrichment.test.ts) so concurrent
// analyzer PRs don't collide. All network is mocked. Runs against the compiled dist/.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePendingReviewRequests,
  latestReviewRequestTimes,
  scanPendingReviewRequests,
} from "../dist/analyzers/pending-review-requests.js";

const jsonResponse = (body, code = 200) => new Response(JSON.stringify(body), { status: code });

const req = (extra = {}) => ({
  repoFullName: "octo/repo",
  prNumber: 7,
  githubToken: "test-token",
  ...extra,
});

const NOW = Date.parse("2026-01-10T00:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

const reviewRequestedEvent = (login, createdAt) => ({
  event: "review_requested",
  created_at: createdAt,
  requested_reviewer: { login },
});
const teamRequestedEvent = (slug, createdAt) => ({
  event: "review_requested",
  created_at: createdAt,
  requested_team: { slug },
});

test("latestReviewRequestTimes: keeps the LATEST review_requested timestamp per reviewer", () => {
  const times = latestReviewRequestTimes([
    reviewRequestedEvent("alice", "2026-01-01T00:00:00Z"),
    reviewRequestedEvent("alice", "2026-01-05T00:00:00Z"),
  ]);
  assert.equal(times.get("alice"), "2026-01-05T00:00:00Z");
});

test("latestReviewRequestTimes: keys teams as team:slug (lowercased), independent of users", () => {
  const times = latestReviewRequestTimes([
    teamRequestedEvent("Backend", "2026-01-02T00:00:00Z"),
    reviewRequestedEvent("alice", "2026-01-01T00:00:00Z"),
  ]);
  assert.equal(times.get("team:backend"), "2026-01-02T00:00:00Z");
  assert.equal(times.get("alice"), "2026-01-01T00:00:00Z");
});

test("latestReviewRequestTimes: ignores non-review_requested events and events with no created_at", () => {
  const times = latestReviewRequestTimes([
    { event: "labeled", created_at: "2026-01-01T00:00:00Z" },
    { event: "review_requested", requested_reviewer: { login: "alice" } }, // no created_at
    { event: "review_requested", created_at: "2026-01-01T00:00:00Z" }, // no reviewer/team
  ]);
  assert.equal(times.size, 0);
});

test("evaluatePendingReviewRequests: flags a user request at/over the 48h threshold", () => {
  const times = new Map([["alice", hoursAgo(48)]]);
  const findings = evaluatePendingReviewRequests({ users: [{ login: "alice" }] }, times, NOW);
  assert.deepEqual(findings, [{ reviewer: "alice", hoursPending: 48 }]);
});

test("evaluatePendingReviewRequests: does not flag a request just under the threshold", () => {
  const times = new Map([["alice", hoursAgo(47)]]);
  const findings = evaluatePendingReviewRequests({ users: [{ login: "alice" }] }, times, NOW);
  assert.deepEqual(findings, []);
});

test("evaluatePendingReviewRequests: flags a stale team request, reported as team:slug", () => {
  const times = new Map([["team:backend", hoursAgo(72)]]);
  const findings = evaluatePendingReviewRequests({ teams: [{ slug: "backend" }] }, times, NOW);
  assert.deepEqual(findings, [{ reviewer: "team:backend", hoursPending: 72 }]);
});

test("evaluatePendingReviewRequests: a pending reviewer with no matching timeline event is skipped, not guessed at", () => {
  const findings = evaluatePendingReviewRequests({ users: [{ login: "alice" }] }, new Map(), NOW);
  assert.deepEqual(findings, []);
});

test("evaluatePendingReviewRequests: reviewer lookup is case-insensitive", () => {
  const times = new Map([["alice", hoursAgo(50)]]);
  const findings = evaluatePendingReviewRequests({ users: [{ login: "Alice" }] }, times, NOW);
  assert.deepEqual(findings, [{ reviewer: "Alice", hoursPending: 50 }]);
});

test("evaluatePendingReviewRequests: no findings when there are no pending users or teams", () => {
  assert.deepEqual(evaluatePendingReviewRequests({}, new Map(), NOW), []);
});

test("scanPendingReviewRequests: end-to-end resolves a stale finding", async () => {
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    return jsonResponse([reviewRequestedEvent("alice", hoursAgo(60))]);
  }, { now: NOW });
  assert.deepEqual(findings, [{ reviewer: "alice", hoursPending: 60 }]);
});

test("scanPendingReviewRequests: no pending reviewers/teams short-circuits before fetching the timeline", async () => {
  let timelineCalled = false;
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [], teams: [] });
    timelineCalled = true;
    return jsonResponse([]);
  });
  assert.deepEqual(findings, []);
  assert.equal(timelineCalled, false);
});

test("scanPendingReviewRequests: requests the expected URL shapes", async () => {
  const urls = [];
  await scanPendingReviewRequests(req(), async (url) => {
    urls.push(url);
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    return jsonResponse([reviewRequestedEvent("alice", hoursAgo(1))]);
  });
  assert.equal(urls[0], "https://api.github.com/repos/octo/repo/pulls/7/requested_reviewers");
  assert.match(urls[1], /^https:\/\/api\.github\.com\/repos\/octo\/repo\/issues\/7\/timeline\?per_page=100&page=1$/);
});

test("scanPendingReviewRequests: a short timeline page (< per_page) stops pagination without a second request", async () => {
  let calls = 0;
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    calls += 1;
    return jsonResponse([reviewRequestedEvent("alice", hoursAgo(60))]);
  }, { now: NOW });
  assert.equal(calls, 1);
  assert.deepEqual(findings, [{ reviewer: "alice", hoursPending: 60 }]);
});

test("scanPendingReviewRequests: walks a second timeline page to find a reviewer's true latest request", async () => {
  const page1 = Array.from({ length: 100 }, () => ({ event: "labeled", created_at: hoursAgo(200) }));
  const page2 = [reviewRequestedEvent("alice", hoursAgo(10))]; // fresh — request was recently re-issued
  let calls = 0;
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    calls += 1;
    return jsonResponse(url.includes("page=2") ? page2 : page1);
  }, { now: NOW });
  assert.equal(calls, 2);
  assert.deepEqual(findings, []); // alice's true latest request is fresh (10h), not stale
});

test("scanPendingReviewRequests: an unconfirmed-complete timeline (still-full last page) fails closed", async () => {
  const fullPage = Array.from({ length: 100 }, () => reviewRequestedEvent("alice", hoursAgo(200)));
  let calls = 0;
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    calls += 1;
    return jsonResponse(fullPage);
  }, { now: NOW });
  assert.equal(calls, 5); // MAX_TIMELINE_PAGES, not unbounded
  assert.deepEqual(findings, []); // completeness unconfirmed -> fails closed, not a false-stale finding
});

test("scanPendingReviewRequests: a later-timeline-page fetch failure fails the whole call closed", async () => {
  const findings = await scanPendingReviewRequests(req(), async (url) => {
    if (url.includes("requested_reviewers")) return jsonResponse({ users: [{ login: "alice" }], teams: [] });
    if (url.includes("page=2")) return jsonResponse({ message: "boom" }, 500);
    return jsonResponse(Array.from({ length: 100 }, () => reviewRequestedEvent("alice", hoursAgo(200))));
  }, { now: NOW });
  assert.deepEqual(findings, []);
});

test("scanPendingReviewRequests: no GitHub token → skipped (no finding, no throw)", async () => {
  const findings = await scanPendingReviewRequests(req({ githubToken: undefined }), async () => jsonResponse({}));
  assert.deepEqual(findings, []);
});

test("scanPendingReviewRequests: a malformed repoFullName is skipped, not thrown", async () => {
  const findings = await scanPendingReviewRequests(
    req({ repoFullName: "not-a-valid-slug" }),
    async () => jsonResponse({}),
  );
  assert.deepEqual(findings, []);
});

test("scanPendingReviewRequests: the requested-reviewers fetch failing yields no finding", async () => {
  const findings = await scanPendingReviewRequests(req(), async () => jsonResponse({ message: "bad" }, 500));
  assert.deepEqual(findings, []);
});
