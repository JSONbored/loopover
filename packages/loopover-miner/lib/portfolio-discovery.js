/** Local orchestration: materialize ranked fan-out rows into the portfolio queue (#2292). */
function normalizeMinRankScore(minRankScore) {
    if (minRankScore === undefined || minRankScore === null)
        return 0;
    if (typeof minRankScore !== "number" || !Number.isFinite(minRankScore) || minRankScore < 0) {
        throw new Error("invalid_min_rank_score");
    }
    return minRankScore;
}
function normalizeRankedIssue(issue) {
    if (!issue || typeof issue !== "object")
        return null;
    const candidate = issue;
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner || !repo || extra !== undefined)
        return null;
    if (!Number.isInteger(candidate.issueNumber) || candidate.issueNumber <= 0)
        return null;
    if (typeof candidate.rankScore !== "number" || !Number.isFinite(candidate.rankScore) || candidate.rankScore < 0) {
        return null;
    }
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!title)
        return null;
    const labels = Array.isArray(candidate.labels)
        ? candidate.labels.filter((label) => typeof label === "string" && label.trim() !== "").map((label) => label.trim())
        : [];
    return {
        repoFullName: `${owner}/${repo}`,
        issueNumber: candidate.issueNumber,
        title,
        labels,
        rankScore: candidate.rankScore,
    };
}
/**
 * Enqueue ranked discovery rows into the local portfolio backlog. Uses each row's `rankScore` as queue priority
 * (the #2292 placeholder field). Optionally appends `discovered_issue` audit events when an event ledger is supplied.
 * Never calls GitHub — callers rank locally first via `rankCandidateIssues`.
 */
export function enqueueRankedDiscovery(rankedIssues, options = {}) {
    if (!Array.isArray(rankedIssues))
        throw new Error("invalid_ranked_issues");
    const queueStore = options.queueStore;
    if (!queueStore || typeof queueStore.enqueue !== "function")
        throw new Error("invalid_queue_store");
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
            ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicG9ydGZvbGlvLWRpc2NvdmVyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInBvcnRmb2xpby1kaXNjb3ZlcnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNkZBQTZGO0FBMkI3RixTQUFTLHFCQUFxQixDQUFDLFlBQXVDO0lBQ3BFLElBQUksWUFBWSxLQUFLLFNBQVMsSUFBSSxZQUFZLEtBQUssSUFBSTtRQUFFLE9BQU8sQ0FBQyxDQUFDO0lBQ2xFLElBQUksT0FBTyxZQUFZLEtBQUssUUFBUSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsSUFBSSxZQUFZLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDM0YsTUFBTSxJQUFJLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO0lBQzVDLENBQUM7SUFDRCxPQUFPLFlBQVksQ0FBQztBQUN0QixDQUFDO0FBRUQsU0FBUyxvQkFBb0IsQ0FBQyxLQUFjO0lBQzFDLElBQUksQ0FBQyxLQUFLLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3JELE1BQU0sU0FBUyxHQUFHLEtBQWdDLENBQUM7SUFDbkQsTUFBTSxZQUFZLEdBQUcsT0FBTyxTQUFTLENBQUMsWUFBWSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0lBQ3JHLE1BQU0sQ0FBQyxLQUFLLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxHQUFHLFlBQVksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDckQsSUFBSSxDQUFDLEtBQUssSUFBSSxDQUFDLElBQUksSUFBSSxLQUFLLEtBQUssU0FBUztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ3hELElBQUksQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQyxXQUFXLENBQUMsSUFBSyxTQUFTLENBQUMsV0FBc0Is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