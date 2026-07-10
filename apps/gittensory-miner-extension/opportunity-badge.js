function issueLookupKey(repoFullName, issueNumber) {
  const repo = String(repoFullName ?? "").trim().toLowerCase();
  const number = Number(issueNumber);
  if (!repo || !Number.isInteger(number) || number <= 0) return null;
  return `${repo}#${number}`;
}

function lookupRankedOpportunity(rankedIssues, repoFullName, issueNumber) {
  const targetKey = issueLookupKey(repoFullName, issueNumber);
  if (!targetKey || !Array.isArray(rankedIssues)) return null;
  for (const entry of rankedIssues) {
    if (!entry || typeof entry !== "object") continue;
    const key = issueLookupKey(entry.repoFullName, entry.issueNumber);
    if (key === targetKey) return entry;
  }
  return null;
}

function scoreToTier(rankScore) {
  const score = Number(rankScore);
  if (!Number.isFinite(score)) return "Unknown";
  if (score >= 0.75) return "High";
  if (score >= 0.5) return "Medium";
  return "Low";
}

function buildOpportunityWhy(entry) {
  const reasons = [];
  if (Number(entry.laneFit) >= 0.7) reasons.push("Strong lane fit");
  if (Number(entry.freshness) >= 0.7) reasons.push("Fresh issue");
  if (Number(entry.potential) >= 0.7) reasons.push("High reward potential");
  if (Number(entry.feasibility) >= 0.7) reasons.push("Feasible scope");
  if (Number(entry.dupRisk) <= 0.3) reasons.push("Low duplicate risk");
  if (reasons.length === 0) reasons.push("Balanced opportunity signals");
  return reasons.slice(0, 2).join("; ");
}

function formatOpportunityBadge(entry) {
  const rankScore = Number(entry.rankScore);
  return {
    tier: scoreToTier(rankScore),
    score: Number.isFinite(rankScore) ? rankScore.toFixed(2) : "—",
    why: buildOpportunityWhy(entry),
    rankScore: Number.isFinite(rankScore) ? rankScore : null,
  };
}

function escapeOpportunityHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function renderOpportunityBadgeMarkup(badge) {
  if (!badge || typeof badge !== "object") return "";
  return `
    <div class="gittensory-miner-opportunity-badge__header">
      <span class="gittensory-miner-opportunity-badge__mark">G</span>
      <span>Gittensory opportunity</span>
      <span class="gittensory-miner-opportunity-badge__read-only">Read-only</span>
    </div>
    <div class="gittensory-miner-opportunity-badge__score">
      <strong>${escapeOpportunityHtml(badge.tier)}</strong>
      <span>${escapeOpportunityHtml(badge.score)}</span>
    </div>
    <p class="gittensory-miner-opportunity-badge__why">${escapeOpportunityHtml(badge.why)}</p>
  `;
}

const opportunityBadgeApi = {
  issueLookupKey,
  lookupRankedOpportunity,
  scoreToTier,
  buildOpportunityWhy,
  formatOpportunityBadge,
  escapeOpportunityHtml,
  renderOpportunityBadgeMarkup,
};

globalThis.__gittensoryMinerOpportunityBadge = opportunityBadgeApi;

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerOpportunityBadgeTestExports = opportunityBadgeApi;
}
