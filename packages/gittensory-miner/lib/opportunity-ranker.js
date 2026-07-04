import {
  DEFAULT_MINER_GOAL_SPEC,
  parseMinerGoalSpecContent,
  rankMetadataOpportunities,
} from "@jsonbored/gittensory-engine";

function finiteEpochMs(value) {
  return Number.isFinite(value) ? value : Date.now();
}

function finiteNonNegativeInt(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const repoFullName =
    typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
  const issueNumber = candidate.issueNumber;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const [owner, repo, extra] = repoFullName.split("/");
  if (!owner || !repo || extra !== undefined) return null;
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || !title) return null;
  const canonicalRepoFullName = `${owner}/${repo}`;
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels
        .filter((label) => typeof label === "string" && label.trim())
        .map((label) => label.trim())
    : [];
  return {
    owner,
    repo,
    repoFullName: canonicalRepoFullName,
    issueNumber,
    title,
    labels,
    commentsCount: Number.isFinite(candidate.commentsCount) ? candidate.commentsCount : 0,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : null,
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : null,
    htmlUrl: typeof candidate.htmlUrl === "string" ? candidate.htmlUrl : null,
    aiPolicyAllowed: candidate.aiPolicyAllowed !== false,
    aiPolicySource:
      candidate.aiPolicySource === "AI-USAGE.md" ||
      candidate.aiPolicySource === "CONTRIBUTING.md" ||
      candidate.aiPolicySource === "none"
        ? candidate.aiPolicySource
        : "none",
  };
}

function buildGoalSpecsByRepo(options = {}) {
  const goalSpecsByRepo = { ...(options.goalSpecsByRepo ?? {}) };
  const rawContentByRepo = options.goalSpecContentByRepo ?? {};
  for (const [repoFullName, content] of Object.entries(rawContentByRepo)) {
    if (typeof content !== "string" || !content.trim()) continue;
    goalSpecsByRepo[repoFullName] = parseMinerGoalSpecContent(content).spec;
  }
  return goalSpecsByRepo;
}

function buildRankContext(options = {}) {
  return {
    nowMs: finiteEpochMs(options.nowMs),
    highRiskDuplicateClusters: finiteNonNegativeInt(options.highRiskDuplicateClusters),
    openPullRequests: finiteNonNegativeInt(options.openPullRequests),
    goalSpecsByRepo: buildGoalSpecsByRepo(options),
  };
}

function collectCandidates(candidates) {
  const input = Array.isArray(candidates) ? candidates : [];
  let skippedInvalid = 0;
  const normalized = [];
  const seen = new Set();
  for (const candidate of input) {
    const entry = normalizeCandidate(candidate);
    if (!entry) {
      skippedInvalid += 1;
      continue;
    }
    const key = `${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return { normalized, skippedInvalid };
}

function rankedUsesDefaultGoalSpec(ranked, options = {}) {
  const goalSpecsByRepo = buildGoalSpecsByRepo(options);
  const specRepos = Object.keys(goalSpecsByRepo);
  if (ranked.length === 0) return specRepos.length === 0;
  return ranked.some((issue) => {
    const target = issue.repoFullName.trim().toLowerCase();
    return !specRepos.some((repo) => repo.trim().toLowerCase() === target);
  });
}

/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export function rankCandidateIssues(candidates, options = {}) {
  const { normalized } = collectCandidates(candidates);
  return rankMetadataOpportunities(normalized, buildRankContext(options));
}

export function rankCandidateIssuesWithSummary(candidates, options = {}) {
  const { normalized, skippedInvalid } = collectCandidates(candidates);
  const ranked = rankMetadataOpportunities(normalized, buildRankContext(options));
  return {
    issues: ranked,
    skippedInvalid,
    usedDefaultGoalSpec: rankedUsesDefaultGoalSpec(ranked, options),
    defaultGoalSpec: DEFAULT_MINER_GOAL_SPEC,
  };
}
