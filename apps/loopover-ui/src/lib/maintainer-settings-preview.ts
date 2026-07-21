export type MinerStatus = "confirmed" | "not_found" | "unavailable";
export type AuthorType = "User" | "Bot";
export type AuthorAssociation =
  | "OWNER"
  | "MEMBER"
  | "COLLABORATOR"
  | "CONTRIBUTOR"
  | "FIRST_TIMER"
  | "FIRST_TIME_CONTRIBUTOR"
  | "MANNEQUIN"
  | "NONE";

export type PreviewScenarioId =
  "confirmed-miner" | "non-miner" | "bot-author" | "maintainer-author" | "miner-api-unavailable";

export type PreviewScenario = {
  id: PreviewScenarioId;
  label: string;
  sample: {
    authorLogin: string;
    authorType: AuthorType;
    authorAssociation: AuthorAssociation;
    minerStatus: MinerStatus;
  };
};

export type PreviewFormState = {
  repoFullName: string;
  scenarioId: PreviewScenarioId;
  title: string;
  labels: string;
  linkedIssues: string;
  body: string;
};

export type SettingsPreviewRequest = {
  sample: {
    authorLogin: string;
    authorType: AuthorType;
    authorAssociation: AuthorAssociation;
    minerStatus: MinerStatus;
    title: string;
    labels: string[];
    linkedIssues: number[];
    body?: string;
  };
};

export const PREVIEW_SCENARIOS: PreviewScenario[] = [
  {
    id: "confirmed-miner",
    label: "Confirmed miner",
    sample: {
      authorLogin: "sample-miner",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      minerStatus: "confirmed",
    },
  },
  {
    id: "non-miner",
    label: "Non-miner",
    sample: {
      authorLogin: "drive-by-contributor",
      authorType: "User",
      authorAssociation: "FIRST_TIMER",
      minerStatus: "not_found",
    },
  },
  {
    id: "bot-author",
    label: "Bot",
    sample: {
      authorLogin: "automation[bot]",
      authorType: "Bot",
      authorAssociation: "NONE",
      minerStatus: "confirmed",
    },
  },
  {
    id: "maintainer-author",
    label: "Maintainer",
    sample: {
      authorLogin: "repo-maintainer",
      authorType: "User",
      authorAssociation: "OWNER",
      minerStatus: "confirmed",
    },
  },
  {
    id: "miner-api-unavailable",
    label: "Unavailable",
    sample: {
      authorLogin: "sample-miner",
      authorType: "User",
      authorAssociation: "CONTRIBUTOR",
      minerStatus: "unavailable",
    },
  },
];

const DEFAULT_PREVIEW_SCENARIO = PREVIEW_SCENARIOS[0] as PreviewScenario;

export function findPreviewScenario(id: PreviewScenarioId): PreviewScenario {
  return PREVIEW_SCENARIOS.find((scenario) => scenario.id === id) ?? DEFAULT_PREVIEW_SCENARIO;
}

export function extractPreviewRepoOptions(reviewability: Array<{ pr: string }>): string[] {
  return Array.from(
    new Set(
      reviewability
        .map((row) => row.pr.split("#")[0]?.trim() ?? "")
        .filter((repo) => /^[^/\s#]+\/[^/\s#]+$/.test(repo)),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export function splitRepoFullName(repoFullName: string): { owner: string; repo: string } | null {
  // Split into exactly two non-empty segments. The old `[owner, repo, extra]` destructuring only
  // inspected the 3rd segment, so any input whose 3rd `/`-segment was empty ("owner/repo/",
  // "owner/repo//stale") slipped through as a truncated owner/repo pair (#7783).
  const parts = repoFullName.trim().split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Parses a `reviewability` row's `pr` field (`owner/repo#123`, #6489) into its owner/repo/number parts. */
export function splitReviewabilityPr(
  pr: string,
): { owner: string; repo: string; number: number } | null {
  const [repoFullName, numberPart] = pr.split("#");
  const repoParts = repoFullName ? splitRepoFullName(repoFullName) : null;
  const number = Number(numberPart);
  if (!repoParts || !Number.isInteger(number) || number <= 0) return null;
  return { ...repoParts, number };
}

export function parsePreviewLabels(value: string): string[] {
  return uniqueStrings(
    value
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
  ).slice(0, 50);
}

export function parseLinkedIssues(value: string): number[] {
  return uniqueNumbers(
    value
      .split(/[,\s]+/)
      .map((issue) => Number(issue.replace(/^#/, "")))
      .filter((issue) => Number.isInteger(issue) && issue > 0),
  ).slice(0, 50);
}

export function buildSettingsPreviewRequest(form: PreviewFormState): SettingsPreviewRequest {
  const scenario = findPreviewScenario(form.scenarioId);
  const title = form.title.trim() || "Sample pull request";
  const body = form.body.trim();
  return {
    sample: {
      ...scenario.sample,
      title,
      labels: parsePreviewLabels(form.labels),
      linkedIssues: parseLinkedIssues(form.linkedIssues),
      ...(body ? { body } : {}),
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}
