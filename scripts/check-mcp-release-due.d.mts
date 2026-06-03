export type GitHubIssueCandidate = {
  pull_request?: unknown;
  title?: unknown;
  body?: unknown;
  user?: {
    login?: unknown;
  } | null;
};

export function isReleaseWatchIssue(issue: GitHubIssueCandidate): boolean;
