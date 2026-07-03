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
  if (!repoFullName || !Number.isInteger(issueNumber) || issueNumber <= 0 || !title) return null;
  const labels = Array.isArray(candidate.labels)
    ? candidate.labels.filter((label) => typeof label === "string" && label.trim())
    : [];
  return {
    owner: typeof candidate.owner === "string" ? candidate.owner : repoFullName.split("/")[0] ?? "",
    repo: typeof candidate.repo === "string" ? candidate.repo : repoFullName.split("/")[1] ?? "",
    repoFullName,
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

/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export function rankCandidateIssues(candidates, options = {}) {
  const normalized = [];
  const seen = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const entry = normalizeCandidate(candidate);
    if (!entry) continue;
    const key = `${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return rankMetadataOpportunities(normalized, buildRankContext(options));
}

export function rankCandidateIssuesWithSummary(candidates, options = {}) {
  const input = Array.isArray(candidates) ? candidates : [];
  const ranked = rankCandidateIssues(candidates, options);
  return {
    issues: ranked,
    skippedInvalid: Math.max(0, input.length - ranked.length),
    usedDefaultGoalSpec: Object.keys(buildGoalSpecsByRepo(options)).length === 0,
    defaultGoalSpec: DEFAULT_MINER_GOAL_SPEC,
  };
}
