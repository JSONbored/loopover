import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeTrackRecordSummary,
  getTrackRecordSummary,
  TRACK_RECORD_SUMMARY_READ_VERSION,
  renderTrackRecordSummaryMarkdown,
  resolveTrackRecordSummaryConfig,
  shouldIncludeTrackRecordSummary,
} from "../dist/index.js";

const NOW = "2026-07-04T18:00:00.000Z";

test("barrel: exports track-record summary APIs (#3008)", () => {
  assert.equal(typeof resolveTrackRecordSummaryConfig, "function");
  assert.equal(typeof computeTrackRecordSummary, "function");
  assert.equal(typeof renderTrackRecordSummaryMarkdown, "function");
  assert.equal(typeof shouldIncludeTrackRecordSummary, "function");
});

test("resolveTrackRecordSummaryConfig defaults to disabled", () => {
  assert.deepEqual(resolveTrackRecordSummaryConfig(undefined), {
    includeTrackRecordSummary: false,
    warnings: [],
  });
  assert.deepEqual(resolveTrackRecordSummaryConfig({}), {
    includeTrackRecordSummary: false,
    warnings: [],
  });
});

test("resolveTrackRecordSummaryConfig honors the miner opt-in path", () => {
  const result = resolveTrackRecordSummaryConfig({
    miner: {
      trackRecordSummary: {
        enabled: true,
      },
    },
  });

  assert.deepEqual(result, {
    includeTrackRecordSummary: true,
    warnings: [],
  });
});

test("resolveTrackRecordSummaryConfig accepts boolean-like strings and numbers", () => {
  assert.equal(
    resolveTrackRecordSummaryConfig({ miner: { trackRecordSummary: { enabled: "yes" } } })
      .includeTrackRecordSummary,
    true,
  );
  assert.equal(
    resolveTrackRecordSummaryConfig({ miner: { trackRecordSummary: { enabled: "off" } } })
      .includeTrackRecordSummary,
    false,
  );
  assert.equal(
    resolveTrackRecordSummaryConfig({ miner: { trackRecordSummary: { enabled: 1 } } }).includeTrackRecordSummary,
    true,
  );
  assert.equal(
    resolveTrackRecordSummaryConfig({ miner: { trackRecordSummary: { enabled: 0 } } }).includeTrackRecordSummary,
    false,
  );
});

test("resolveTrackRecordSummaryConfig keeps a top-level alias but prefers miner config", () => {
  assert.equal(
    resolveTrackRecordSummaryConfig({
      trackRecordSummary: { enabled: "include" },
    }).includeTrackRecordSummary,
    true,
  );
  assert.equal(
    resolveTrackRecordSummaryConfig({
      miner: { trackRecordSummary: { enabled: false } },
      trackRecordSummary: { enabled: true },
    }).includeTrackRecordSummary,
    false,
  );
});

test("resolveTrackRecordSummaryConfig warns and fails closed on malformed values", () => {
  const result = resolveTrackRecordSummaryConfig({
    miner: { trackRecordSummary: { enabled: "maybe" } },
  });

  assert.deepEqual(result, {
    includeTrackRecordSummary: false,
    warnings: ["miner.trackRecordSummary.enabled must be a boolean-like value; defaulting to false."],
  });
});

test("shouldIncludeTrackRecordSummary accepts resolved config and manifest input", () => {
  assert.equal(shouldIncludeTrackRecordSummary({ includeTrackRecordSummary: true, warnings: [] }), true);
  assert.equal(shouldIncludeTrackRecordSummary({ includeTrackRecordSummary: false, warnings: [] }), false);
  assert.equal(
    shouldIncludeTrackRecordSummary({ miner: { trackRecordSummary: { enabled: "enabled" } } }),
    true,
  );
  assert.equal(shouldIncludeTrackRecordSummary(null), false);
});

test("computeTrackRecordSummary derives a positive public record from matching outcomes", () => {
  const summary = computeTrackRecordSummary({
    login: "MinerOne",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: 11,
        repoFullName: "jsonbored/loopover",
        authorLogin: "minerone",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
        mergedAt: "2026-06-02T00:00:00Z",
      },
      {
        id: "pr-12",
        repoFullName: "owner/repo",
        authorLogin: "MinerOne",
        state: "closed",
        createdAt: "2026-06-03T00:00:00Z",
        closedAt: "2026-06-04T00:00:00Z",
      },
      {
        id: "pr-13",
        repoFullName: "owner/repo",
        authorLogin: "MINERONE",
        state: "accepted",
        createdAt: "2026-06-05T00:00:00Z",
      },
      {
        id: "open-1",
        repoFullName: "owner/repo",
        authorLogin: "MinerOne",
        state: "open",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ],
    incidents: [],
  });

  assert.equal(summary.enabled, true);
  assert.equal(summary.login, "minerone");
  assert.deepEqual(summary.outcomes, {
    merged: 2,
    closedWithoutMerge: 1,
    resolved: 3,
    openIgnored: 1,
    ignored: 0,
  });
  assert.equal(summary.mergeRate.ratio, 2 / 3);
  assert.equal(summary.mergeRate.percent, 67);
  assert.equal(summary.mergeRate.label, "67%");
  assert.equal(summary.tenure.firstObservedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(summary.tenure.days, 33);
  assert.equal(summary.tenure.label, "1 month");
  assert.deepEqual(summary.audit.consideredOutcomeIds, ["11", "pr-12", "pr-13"]);
  assert.deepEqual(summary.audit.ignoredOutcomeIds, ["open-1"]);
});

test("computeTrackRecordSummary treats a merged timestamp as authoritative", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "squashed",
        repoFullName: "owner/repo",
        authorLogin: "miner",
        state: "closed",
        createdAt: "2026-06-01T00:00:00Z",
        closedAt: "2026-06-03T00:00:00Z",
        mergedAt: "2026-06-03T00:00:00Z",
      },
    ],
  });

  assert.equal(summary.outcomes.merged, 1);
  assert.equal(summary.outcomes.closedWithoutMerge, 0);
  assert.equal(summary.mergeRate.label, "100%");
});

test("computeTrackRecordSummary ignores other authors and unknown states", () => {
  const summary = computeTrackRecordSummary({
    login: "target",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "other",
        repoFullName: "owner/repo",
        authorLogin: "someone-else",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
        mergedAt: "2026-06-02T00:00:00Z",
      },
      {
        id: "unknown",
        repoFullName: "owner/repo",
        authorLogin: "target",
        state: "queued",
        createdAt: "2026-06-02T00:00:00Z",
      },
    ],
  });

  assert.equal(summary.outcomes.resolved, 0);
  assert.equal(summary.outcomes.ignored, 2);
  assert.deepEqual(summary.audit.ignoredOutcomeIds, ["other", "unknown"]);
});

test("computeTrackRecordSummary normalizes public outcome state aliases", () => {
  const summary = computeTrackRecordSummary({
    login: "alias",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "merge",
        repoFullName: "owner/repo",
        authorLogin: "alias",
        state: "merge",
        createdAt: "2026-06-01T00:00:00Z",
      },
      {
        id: "declined",
        repoFullName: "owner/repo",
        authorLogin: "alias",
        state: "declined",
        createdAt: "2026-06-02T00:00:00Z",
      },
      {
        id: "not-merged",
        repoFullName: "owner/repo",
        authorLogin: "alias",
        state: "not-merged",
        createdAt: "2026-06-03T00:00:00Z",
      },
      {
        id: "draft",
        repoFullName: "owner/repo",
        authorLogin: "alias",
        state: "draft",
        createdAt: "2026-06-04T00:00:00Z",
      },
    ],
  });

  assert.deepEqual(summary.outcomes, {
    merged: 1,
    closedWithoutMerge: 2,
    resolved: 3,
    openIgnored: 1,
    ignored: 0,
  });
  assert.equal(summary.mergeRate.label, "33%");
});

test("computeTrackRecordSummary falls back to the current clock only when now is malformed", () => {
  const before = Date.now();
  const summary = computeTrackRecordSummary({
    login: "clock",
    now: "not-a-date",
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "old",
        repoFullName: "owner/repo",
        authorLogin: "clock",
        state: "merged",
        createdAt: "1970-01-01T00:00:00Z",
      },
    ],
  });
  const after = Date.now();
  const lowerBoundDays = Math.floor((before - Date.parse("1970-01-01T00:00:00Z")) / 86_400_000);
  const upperBoundDays = Math.floor((after - Date.parse("1970-01-01T00:00:00Z")) / 86_400_000);

  assert.ok(summary.tenure.days !== null);
  assert.ok(summary.tenure.days >= lowerBoundDays);
  assert.ok(summary.tenure.days <= upperBoundDays);
});

test("computeTrackRecordSummary keeps http evidence and rejects unsafe schemes", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
    incidents: [
      { login: "miner", kind: "moderation", publicEvidenceUrl: "http://example.test/public-record" },
      { login: "miner", kind: "moderation", publicEvidenceUrl: "ftp://example.test/not-public" },
      { login: "miner", kind: "moderation", publicEvidenceUrl: "https://example.test/bad path" },
    ],
  });

  assert.deepEqual(summary.incidents.evidenceUrls, ["http://example.test/public-record"]);
  assert.match(renderTrackRecordSummaryMarkdown(summary), /http:\/\/example\.test\/public-record/u);
});

test("computeTrackRecordSummary returns neutral zero-history values for a new miner", () => {
  const summary = computeTrackRecordSummary({
    login: "new-miner",
    outcomes: [],
    incidents: [],
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
  });

  assert.equal(summary.mergeRate.ratio, null);
  assert.equal(summary.mergeRate.percent, null);
  assert.equal(summary.mergeRate.label, "not enough resolved public PR history");
  assert.equal(summary.tenure.firstObservedAt, null);
  assert.equal(summary.tenure.days, null);
  assert.equal(summary.tenure.label, "not enough public history");
  assert.equal(summary.incidents.hasPublicIncident, false);
  assert.equal(summary.incidents.label, "no public conduct incidents found");
});

test("computeTrackRecordSummary clamps future tenure to less than one day", () => {
  const summary = computeTrackRecordSummary({
    login: "future",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "future-pr",
        repoFullName: "owner/repo",
        authorLogin: "future",
        state: "merged",
        createdAt: "2026-08-01T00:00:00Z",
        mergedAt: "2026-08-02T00:00:00Z",
      },
    ],
  });

  assert.equal(summary.tenure.days, 0);
  assert.equal(summary.tenure.label, "less than 1 day");
});

test("computeTrackRecordSummary handles date objects, invalid dates, and generated row ids", () => {
  const summary = computeTrackRecordSummary({
    login: "dates",
    now: new Date(NOW),
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        repoFullName: "owner/repo",
        authorLogin: "dates",
        state: "merged",
        createdAt: new Date("2025-07-04T18:00:00Z"),
        mergedAt: "not a date",
      },
      {
        repoFullName: "owner/repo",
        authorLogin: "dates",
        state: "closed",
        createdAt: "not a date",
        closedAt: null,
      },
    ],
  });

  assert.equal(summary.tenure.days, 365);
  assert.equal(summary.tenure.label, "1 year");
  assert.deepEqual(summary.audit.consideredOutcomeIds, ["row-1", "row-2"]);
  assert.deepEqual(summary.audit.firstObservedCandidates, ["2025-07-04T18:00:00.000Z"]);
});

test("computeTrackRecordSummary renders month and year tenure labels deterministically", () => {
  const tenures = [
    ["2026-07-03T18:00:00Z", "1 day"],
    ["2026-06-25T18:00:00Z", "9 days"],
    ["2026-03-01T18:00:00Z", "4 months"],
    ["2024-12-01T18:00:00Z", "1y 7m"],
  ].map(([createdAt, expected]) => {
    const summary = computeTrackRecordSummary({
      login: "tenure",
      now: NOW,
      config: { includeTrackRecordSummary: true, warnings: [] },
      outcomes: [
        {
          id: createdAt,
          repoFullName: "owner/repo",
          authorLogin: "tenure",
          state: "merged",
          createdAt,
          mergedAt: createdAt,
        },
      ],
    });
    return [createdAt, summary.tenure.label, expected];
  });

  assert.deepEqual(tenures, [
    ["2026-07-03T18:00:00Z", "1 day", "1 day"],
    ["2026-06-25T18:00:00Z", "9 days", "9 days"],
    ["2026-03-01T18:00:00Z", "4 months", "4 months"],
    ["2024-12-01T18:00:00Z", "1y 7m", "1y 7m"],
  ]);
});

test("computeTrackRecordSummary detects a prior public incident and avoids a clean claim", () => {
  const summary = computeTrackRecordSummary({
    login: "MinerOne",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "pr-1",
        repoFullName: "owner/repo",
        authorLogin: "minerone",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ],
    incidents: [
      {
        login: "minerone",
        kind: "code-of-conduct",
        active: true,
        recordedAt: "2026-06-10T00:00:00Z",
        publicEvidenceUrl: "https://example.test/moderation/minerone",
      },
    ],
  });

  assert.equal(summary.incidents.hasPublicIncident, true);
  assert.equal(summary.incidents.checkedPublicRecords, 1);
  assert.equal(summary.incidents.activePublicRecords, 1);
  assert.equal(summary.incidents.label, "public conduct incident present");
  assert.deepEqual(summary.incidents.evidenceUrls, ["https://example.test/moderation/minerone"]);
});

test("computeTrackRecordSummary ignores inactive, unknown, mismatched, and invalid-url incident rows", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
    incidents: [
      { login: "miner", kind: "moderation", active: false, publicEvidenceUrl: "https://example.test/inactive" },
      { login: "miner", kind: "unknown-thing", active: true, publicEvidenceUrl: "https://example.test/unknown" },
      { login: "other", kind: "ban", active: true, publicEvidenceUrl: "https://example.test/other" },
      { login: "miner", kind: "ban", active: true, publicEvidenceUrl: "javascript:alert(1)" },
    ],
  });

  assert.equal(summary.incidents.checkedPublicRecords, 3);
  assert.equal(summary.incidents.activePublicRecords, 1);
  assert.equal(summary.incidents.hasPublicIncident, true);
  assert.deepEqual(summary.incidents.evidenceUrls, []);
});

test("computeTrackRecordSummary deduplicates and sorts public evidence URLs", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
    incidents: [
      { login: "miner", kind: "ban", publicEvidenceUrl: "https://example.test/z" },
      { login: "miner", kind: "ban", publicEvidenceUrl: "https://example.test/a" },
      { login: "miner", kind: "ban", publicEvidenceUrl: "https://example.test/z" },
    ],
  });

  assert.deepEqual(summary.incidents.evidenceUrls, ["https://example.test/a", "https://example.test/z"]);
});

test("renderTrackRecordSummaryMarkdown renders nothing when disabled", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: false, warnings: [] },
    outcomes: [
      {
        id: "pr-1",
        repoFullName: "owner/repo",
        authorLogin: "miner",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ],
  });

  assert.equal(renderTrackRecordSummaryMarkdown(summary), "");
});

test("renderTrackRecordSummaryMarkdown renders a short deterministic public block", () => {
  const summary = computeTrackRecordSummary({
    login: "Miner_Name",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "pr-1",
        repoFullName: "owner/repo",
        authorLogin: "miner_name",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
      },
      {
        id: "pr-2",
        repoFullName: "owner/repo",
        authorLogin: "miner_name",
        state: "open",
        createdAt: "2026-07-01T00:00:00Z",
      },
    ],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);

  assert.equal(
    markdown,
    [
      "### Public contributor record",
      "",
      "- GitHub login: miner\\_name",
      "- Resolved public PRs: 1 (1 merged, 0 closed without merge)",
      "- Public merge rate: 100%",
      "- Public tenure: 1 month",
      "- Public conduct record: no public conduct incidents found",
      "- Open PRs ignored for rate: 1",
      "",
    ].join("\n"),
  );
});

test("renderTrackRecordSummaryMarkdown includes public incident evidence only when present", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
    incidents: [
      {
        login: "miner",
        kind: "ban",
        publicEvidenceUrl: "https://example.test/moderation/miner",
      },
    ],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);

  assert.match(markdown, /Public conduct record: public conduct incident present/u);
  assert.match(markdown, /Public evidence: https:\/\/example\.test\/moderation\/miner/u);
  assert.doesNotMatch(markdown, /no public conduct incidents found/u);
});

test("renderTrackRecordSummaryMarkdown escapes markdown controls and collapses newlines", () => {
  const summary = computeTrackRecordSummary({
    login: "miner_*[`bad`]\nnext",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "pr-1",
        repoFullName: "owner/repo",
        authorLogin: "miner_*[`bad`]\nnext",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);

  assert.ok(markdown.includes("- GitHub login: miner\\_\\*\\[\\`bad\\`\\] next"));
});

test("renderTrackRecordSummaryMarkdown never renders blocked internal field names from computed input", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "trustScore:99\nreward:100",
        repoFullName: "owner/repo",
        authorLogin: "miner",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
        url: "https://example.test/pr/1?reward=100",
      },
    ],
    incidents: [
      {
        login: "miner",
        kind: "ban",
        publicEvidenceUrl: "https://example.test/evidence",
      },
    ],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);

  for (const term of ["trustScore", "reward", "ranking", "wallet", "hotkey", "coldkey"]) {
    assert.equal(markdown.includes(term), false, term);
  }
});

test("renderTrackRecordSummaryMarkdown fails closed if a blocked public field is introduced", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
  });

  assert.throws(
    () =>
      renderTrackRecordSummaryMarkdown({
        ...summary,
        incidents: { ...summary.incidents, label: "trust score leaked" },
      }),
    /blocked public field/u,
  );
});

test("renderTrackRecordSummaryMarkdown tolerates a login containing a blocklisted substring (#6772 / #7444)", () => {
  const summary = computeTrackRecordSummary({
    login: "team-wallet",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);
  assert.match(markdown, /GitHub login: team-wallet/u);
});

test("renderTrackRecordSummaryMarkdown tolerates evidence URLs containing a blocklisted path substring (#7444)", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [],
    incidents: [
      {
        login: "miner",
        kind: "ban",
        publicEvidenceUrl: "https://example.test/org/wallet-connect/issues/1",
      },
    ],
  });
  const markdown = renderTrackRecordSummaryMarkdown(summary);
  assert.match(markdown, /Public evidence: https:\/\/example\.test\/org\/wallet-connect\/issues\/1/u);
});

test("computeTrackRecordSummary is byte-stable for equivalent repeated calls", () => {
  const input = {
    login: "miner",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      {
        id: "b",
        repoFullName: "owner/repo",
        authorLogin: "miner",
        state: "closed",
        createdAt: "2026-06-02T00:00:00Z",
      },
      {
        id: "a",
        repoFullName: "owner/repo",
        authorLogin: "miner",
        state: "merged",
        createdAt: "2026-06-01T00:00:00Z",
      },
    ],
    incidents: [{ login: "miner", kind: "ban", publicEvidenceUrl: "https://example.test/a" }],
  } as const;

  assert.equal(JSON.stringify(computeTrackRecordSummary(input)), JSON.stringify(computeTrackRecordSummary(input)));
  assert.equal(
    renderTrackRecordSummaryMarkdown(computeTrackRecordSummary(input)),
    renderTrackRecordSummaryMarkdown(computeTrackRecordSummary(input)),
  );
});

test("computeTrackRecordSummary accepts manifest config directly", () => {
  const summary = computeTrackRecordSummary({
    login: "miner",
    now: NOW,
    config: { miner: { trackRecordSummary: { enabled: "true" } } },
    outcomes: [],
  });

  assert.equal(summary.enabled, true);
});

test("getTrackRecordSummary wraps the computed summary in a stable versioned envelope: populated (#6246)", () => {
  const input = {
    login: "MinerOne",
    now: NOW,
    config: { includeTrackRecordSummary: true, warnings: [] },
    outcomes: [
      { id: 11, repoFullName: "jsonbored/loopover", authorLogin: "minerone", state: "merged", createdAt: "2026-06-01T00:00:00Z", mergedAt: "2026-06-02T00:00:00Z" },
      { id: "pr-12", repoFullName: "owner/repo", authorLogin: "MinerOne", state: "closed", createdAt: "2026-06-03T00:00:00Z", closedAt: "2026-06-04T00:00:00Z" },
    ],
    incidents: [],
  } as const;
  const result = getTrackRecordSummary(input);
  assert.equal(result.version, TRACK_RECORD_SUMMARY_READ_VERSION);
  assert.equal(result.version, 1);
  // The envelope carries exactly the computed summary, unmodified.
  assert.deepEqual(result.summary, computeTrackRecordSummary(input));
  assert.equal(result.summary.enabled, true);
  assert.equal(result.summary.login, "minerone");
  assert.equal(result.summary.outcomes.merged, 1);
  assert.equal(result.summary.outcomes.closedWithoutMerge, 1);
});

test("getTrackRecordSummary returns a versioned envelope for an empty/no-history miner (#6246)", () => {
  const result = getTrackRecordSummary({ login: "ghost", now: NOW, outcomes: [], incidents: [] });
  assert.equal(result.version, 1);
  assert.equal(result.summary.login, "ghost");
  assert.equal(result.summary.outcomes.merged, 0);
  assert.equal(result.summary.outcomes.closedWithoutMerge, 0);
  // No config supplied → the summary defaults to disabled, same as computeTrackRecordSummary.
  assert.equal(result.summary.enabled, false);
});
