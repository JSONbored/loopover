// Deterministic pre-filter for the unlinked-issue guardrail (#unlinked-issue-guardrail). PURE — no IO, no
// AI call — so it can run on every unlinked PR for free and only hand a SHORT, bounded candidate list to the
// expensive AI verifier (src/review/unlinked-issue-match.ts), which is the actual precision gate. This stage
// is deliberately RECALL-oriented (a coincidental token/path overlap is cheap to false-positive here — the AI
// step is what must be accurate), never the reverse: it must never silently drop a genuinely-matching issue
// just to save an AI call.

export type CandidateOpenIssue = {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
};

export type UnlinkedIssueCandidateMatch = {
  issue: CandidateOpenIssue;
  score: number;
  matchedTokens: string[];
  pathMentioned: boolean;
};

export type FindUnlinkedIssueCandidatesInput = {
  prTitle: string;
  prBody: string | null | undefined;
  changedPaths: string[];
  openIssues: CandidateOpenIssue[];
};

// Bound the AI-verifier fan-out per PR: even a repo with hundreds of open issues only ever sends its
// top-scoring handful for a real (paid/self-host-compute) AI call.
const MAX_CANDIDATES = 3;
// A path/basename mention is a much stronger signal than shared vocabulary — worth several tokens' score,
// and (deliberately) enough on its own to qualify a candidate even with zero token overlap (an issue that
// names the exact file this PR touches is worth checking regardless of shared wording).
const PATH_MENTION_SCORE_BONUS = 5;
// Token overlap alone only qualifies a candidate once it clears this bar — a single shared common word
// (even after stopword filtering) is not enough evidence to spend an AI call on.
const MIN_TOKEN_OVERLAP = 3;
// Tokens shorter than this are dropped before counting — short tokens (case IDs, "PR", "fix") are too
// common across unrelated issues to be distinctive evidence of a real match.
const MIN_TOKEN_LENGTH = 4;

// A small, curated stopword list for the vocabulary shared by nearly every PR/issue description
// regardless of topic — without this, "this PR fixes the issue where..." style boilerplate would dominate
// the token-overlap score and swamp genuinely distinctive words.
const STOPWORDS = new Set([
  "this", "that", "with", "from", "have", "when", "where", "which", "there", "their",
  "issue", "issues", "should", "would", "could", "about", "would", "into", "your", "were",
  "then", "than", "will", "does", "doesn", "cannot", "currently", "instead", "because",
  "these", "those", "being", "only", "also", "still", "even", "some", "each", "such",
]);

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token));
  return new Set(tokens);
}

/** True when an issue's body names one of the PR's changed files — either the full repo-relative path or
 *  just its basename (issues commonly reference "the X.ts file" without the full path). Basenames shorter
 *  than {@link MIN_TOKEN_LENGTH} are skipped as too generic (e.g. `db.ts`, `index.ts` collide across repos). */
function issueMentionsChangedPath(issueBody: string, changedPaths: string[]): boolean {
  const lowerBody = issueBody.toLowerCase();
  return changedPaths.some((path) => {
    const lowerPath = path.toLowerCase();
    if (lowerBody.includes(lowerPath)) return true;
    const basename = lowerPath.slice(lowerPath.lastIndexOf("/") + 1);
    return basename.length >= MIN_TOKEN_LENGTH && lowerBody.includes(basename);
  });
}

/**
 * Rank a repo's open issues by how strongly they overlap an unlinked PR, returning at most
 * {@link MAX_CANDIDATES} qualifying matches (highest score first, ties broken by lower issue number —
 * the earlier-filed issue is the more likely original target). An issue qualifies via EITHER a
 * distinctive-token overlap clearing {@link MIN_TOKEN_OVERLAP}, OR a changed-path mention in its body
 * (see {@link issueMentionsChangedPath}) — either alone is sufficient. Returns `[]` when nothing qualifies;
 * this function never calls out to AI or GitHub, so a repo with no genuine candidates costs nothing beyond
 * this pass.
 */
export function findUnlinkedIssueCandidates(input: FindUnlinkedIssueCandidatesInput): UnlinkedIssueCandidateMatch[] {
  const prTokens = tokenize(`${input.prTitle} ${input.prBody ?? ""}`);
  const matches: UnlinkedIssueCandidateMatch[] = [];
  for (const issue of input.openIssues) {
    const issueBody = issue.body ?? "";
    const issueTokens = tokenize(`${issue.title} ${issueBody}`);
    const matchedTokens = [...prTokens].filter((token) => issueTokens.has(token));
    const pathMentioned = issueBody.length > 0 && issueMentionsChangedPath(issueBody, input.changedPaths);
    if (matchedTokens.length < MIN_TOKEN_OVERLAP && !pathMentioned) continue;
    const score = matchedTokens.length + (pathMentioned ? PATH_MENTION_SCORE_BONUS : 0);
    matches.push({ issue, score, matchedTokens, pathMentioned });
  }
  matches.sort((a, b) => b.score - a.score || a.issue.number - b.issue.number);
  return matches.slice(0, MAX_CANDIDATES);
}
