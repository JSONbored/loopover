/** Local orchestration: materialize ranked fan-out rows into the portfolio queue (#2292). */

function normalizeMinRankScore(minRankScore) {
  if (minRankScore === undefined || minRankScore === null) return 0;
  if (typeof minRankScore !== "number" || !Number.isFinite(minRankScore) || minRankScore < 0) {
    throw new Error("invalid_min_rank_score");
  }
  return minRankScore;
}

function normalizeRankedIssue(issue) {
  if (!issue || typeof issue !== "object") return null;
  const repoFullName = typeof issue.repoFullName === "string" ? issue.repoFullName.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!Number.isInteger(issue.issueNumber) || issue.issueNumber <= 0) return null;
  if (typeof issue.rankScore !== "number" || !Number.isFinite(issue.rankScore) || issue.rankScore < 0) {
    return null;
  }
  const title = typeof issue.title === "string" ? issue.title.trim() : "";
  if (!title) return null;
  const labels = Array.isArray(issue.labels)
    ? issue.labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim())
    : [];
  return {
    repoFullName: `${owner}/${repo}`,
    issueNumber: issue.issueNumber,
    title,
    labels,
    rankScore: issue.rankScore,
  };
}

/**
 * Enqueue ranked discovery rows into the local portfolio backlog. Uses each row's `rankScore` as queue priority
 * (the #2292 placeholder field). Optionally appends `discovered_issue` audit events when an event ledger is supplied.
 * Never calls GitHub — callers rank locally first via `rankCandidateIssues`.
 */
export function enqueueRankedDiscovery(rankedIssues, options = {}) {
  if (!Array.isArray(rankedIssues)) throw new Error("invalid_ranked_issues");
  const queueStore = options.queueStore;
  if (!queueStore || typeof queueStore.enqueue !== "function") throw new Error("invalid_queue_store");

  let eventLedger = null;
  if (options.eventLedger !== undefined) {
    eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function") {
      throw new Error("invalid_event_ledger");
    }
  }

  const minRankScore = normalizeMinRankScore(options.minRankScore);
  // #5563: threaded through from the caller's already-resolved forge host, so a non-default (GitHub Enterprise)
  // tenant's ranked issues land in the queue scoped to their own host instead of colliding with a same-named
  // owner/repo on github.com. Omitted/nullish falls through to the queue store's own github.com default.
  const apiBaseUrl = options.apiBaseUrl;

  const summary = {
    enqueued: 0,
    skippedBelowMinRank: 0,
    skippedInvalid: 0,
    eventsAppended: 0,
  };

  for (const issue of rankedIssues) {
    const normalized = normalizeRankedIssue(issue);
    if (!normalized) {
      summary.skippedInvalid += 1;
      continue;
    }
    if (normalized.rankScore < minRankScore) {
      summary.skippedBelowMinRank += 1;
      continue;
    }

    queueStore.enqueue({
      repoFullName: normalized.repoFullName,
      identifier: `issue:${normalized.issueNumber}`,
      priority: normalized.rankScore,
      apiBaseUrl,
    });
    summary.enqueued += 1;

    if (eventLedger) {
      eventLedger.appendEvent({
        type: "discovered_issue",
        repoFullName: normalized.repoFullName,
        payload: {
          issueNumber: normalized.issueNumber,
          rankScore: normalized.rankScore,
          title: normalized.title,
          labels: normalized.labels,
        },
      });
      summary.eventsAppended += 1;
    }
  }

  return summary;
}
