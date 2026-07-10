// Commit-history hygiene signals, read from structured GitHub PR-commits API fields only — no diff/text/YAML
// parsing. Surfaces three things a PR's own commits tab doesn't call out: a merge commit accidentally pulled into
// the PR's own history (usually from merging the base branch into a feature branch instead of rebasing, which
// muddies the diff), a commit left with git's own `fixup!`/`squash!` autosquash marker (meant to be squashed
// before merge, never merged as-is), and a commit whose message carries a `Co-authored-by:` trailer (multi-author
// attribution a reviewer may want visible). Reads only documented fields from the GitHub PR-commits API
// (commit.message, parents) and matches each independently against a single line at a time — no cross-line
// state, so it cannot suffer a patch scanner's ambiguous-syntax edge cases. Pure GitHub-metadata read, no repo
// content beyond the already-public commit list. Fail-safe: no token, a bad repo slug, or a fetch error all yield
// no finding. Bounded to one page of commits (MAX_COMMITS) — a PR with more is vanishingly rare, and a missed
// commit past the cap is simply a missed (not a wrong) finding.
import type {
  AnalyzerDiagnostics,
  CommitHygieneFinding,
  EnrichRequest,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";
import { githubHeaders } from "../github-headers.js";
import { DEFAULT_MAX_FINDINGS } from "./limits.js";

const GITHUB_API = "https://api.github.com";
const SLUG_RE = /^[A-Za-z0-9._-]+$/;
const MAX_COMMITS = 100;
const MAX_FINDINGS = DEFAULT_MAX_FINDINGS;
const SHA_PREFIX_LEN = 12;

// Git's own autosquash markers (`git commit --fixup`/`--squash`, `git rebase -i --autosquash`) — a documented,
// finite convention, not free-form text. Matched against the commit message's first line only.
const FIXUP_SUBJECT_RE = /^(?:fixup|squash)!\s+/i;
// GitHub's own commit-trailer convention for multi-author commits: https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors
const CO_AUTHOR_TRAILER_RE = /^Co-authored-by:\s*(.+<[^<>]+@[^<>]+>)\s*$/i;

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

/** The slice of a GitHub PR-commit list item this analyzer reads. */
interface CommitListItem {
  sha?: string;
  commit?: { message?: string };
  parents?: Array<{ sha?: string }>;
}

async function fetchPrCommits(
  owner: string,
  repo: string,
  prNumber: number,
  headers: Record<string, string>,
  fetchFn: typeof fetch,
  signal: AbortSignal | undefined,
  options: Pick<ScanOptions, "analysis" | "diagnostics">,
): Promise<CommitListItem[] | null> {
  const url =
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/` +
    `${encodeURIComponent(String(prNumber))}/commits?per_page=${MAX_COMMITS}`;
  const fetchOptions = {
    endpointCategory: "github-pr-commits",
    headers,
    signal,
    fetchImpl: fetchFn,
    diagnostics: options.diagnostics,
    phase: "commit-hygiene",
    subcall: "github-pr-commits",
    maxBytes: 512 * 1024,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<CommitListItem[]>(url, fetchOptions)
    : await boundedFetchJson<CommitListItem[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Pure reduction: a PR's commit list → commit-hygiene findings, in list order, each check independent of the
 *  others and of any other commit (no cross-commit or cross-line state). Bounded by maxFindings. */
export function analyzeCommitHygiene(
  commits: CommitListItem[],
  maxFindings = MAX_FINDINGS,
): CommitHygieneFinding[] {
  const findings: CommitHygieneFinding[] = [];

  commitLoop: for (const item of commits) {
    if (findings.length >= maxFindings) break;
    const sha = item.sha;
    if (!sha) continue;
    const shaPrefix = sha.slice(0, SHA_PREFIX_LEN);
    const message = item.commit?.message ?? "";
    const lines = message.split("\n");
    const subject = lines[0] ?? "";

    if ((item.parents?.length ?? 0) > 1) {
      findings.push({ shaPrefix, kind: "merge-commit-in-history" });
      if (findings.length >= maxFindings) break;
    }

    if (FIXUP_SUBJECT_RE.test(subject)) {
      findings.push({ shaPrefix, kind: "fixup-commit-present", subject: subject.trim() });
      if (findings.length >= maxFindings) break;
    }

    for (const line of lines) {
      const match = CO_AUTHOR_TRAILER_RE.exec(line.trim());
      if (match) {
        findings.push({ shaPrefix, kind: "unattributed-co-author", coAuthor: match[1]!.trim() });
        // One co-author trailer per commit is enough to surface (avoids noisy duplicates for multi-author
        // commits) — `continue commitLoop` exits this inner line-scan AND re-enters the outer loop's own
        // maxFindings check uniformly, the same way the merge-commit/fixup checks above do.
        if (findings.length >= maxFindings) break commitLoop;
        continue commitLoop;
      }
    }
  }

  return findings;
}

/** Analyzer entrypoint: a PR's commits → commit-hygiene findings. Fail-safe — no token, a bad repo slug, or a
 *  fetch error all yield no finding rather than an error. */
export async function scanCommitHygiene(
  req: EnrichRequest,
  fetchFn: typeof fetch = fetch,
  options: ScanOptions = {},
): Promise<CommitHygieneFinding[]> {
  const { repoFullName, githubToken, prNumber } = req;
  if (!githubToken) return [];
  const parts = repoFullName.split("/");
  const owner = parts[0];
  const repo = parts[1];
  if (parts.length !== 2 || !owner || !repo || !SLUG_RE.test(owner) || !SLUG_RE.test(repo)) return [];

  const headers = githubHeaders(githubToken);
  const commits = await fetchPrCommits(owner, repo, prNumber, headers, fetchFn, options.signal, options);
  if (!commits) return [];

  return analyzeCommitHygiene(commits);
}
