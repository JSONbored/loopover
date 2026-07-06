// Local mirror of the record/type shapes `scoring/preview.ts`, `scoring/model.ts`, and
// `scoring/pending-pr-scenarios.ts` need from the backend's `src/types.ts` and `src/signals/engine.ts`.
// The engine package cannot import across into `src/` (see the package's own tsconfig: `rootDir: "src"`,
// `types: []` — it stays isolated from the Cloudflare Worker/D1 ambient types the backend depends on), so
// these shapes are duplicated here rather than imported. `src/types.ts` and `src/signals/engine.ts` stay
// the canonical source; keep this file in sync with them by hand.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type RepoTimeDecayOverrides = {
  gracePeriodHours?: number | null | undefined;
  sigmoidMidpointDays?: number | null | undefined;
  sigmoidSteepness?: number | null | undefined;
  minMultiplier?: number | null | undefined;
};

export type RegistryRepoConfig = {
  repo: string;
  emissionShare: number;
  issueDiscoveryShare: number;
  labelMultipliers: Record<string, number>;
  trustedLabelPipeline?: boolean | null;
  maintainerCut: number;
  defaultLabelMultiplier?: number | null;
  fixedBaseScore?: number | null;
  eligibilityMode?: string | null;
  timeDecay?: RepoTimeDecayOverrides | null;
  raw: Record<string, JsonValue>;
};

export type RepositoryRecord = {
  fullName: string;
  owner: string;
  name: string;
  installationId?: number | null | undefined;
  isInstalled: boolean;
  isRegistered: boolean;
  isPrivate: boolean;
  htmlUrl?: string | null | undefined;
  defaultBranch?: string | null | undefined;
  registryConfig?: RegistryRepoConfig | null | undefined;
};

export type PullRequestRecord = {
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin?: string | null | undefined;
  authorAssociation?: string | null | undefined;
  headSha?: string | null | undefined;
  headRef?: string | null | undefined;
  baseRef?: string | null | undefined;
  htmlUrl?: string | null | undefined;
  mergedAt?: string | null | undefined;
  isDraft?: boolean | null | undefined;
  mergeableState?: string | null | undefined;
  reviewDecision?: string | null | undefined;
  body?: string | null | undefined;
  createdAt?: string | null | undefined;
  updatedAt?: string | null | undefined;
  closedAt?: string | null | undefined;
  linkedIssueClaimedAt?: string | null | undefined;
  labels: string[];
  linkedIssues: number[];
  slopRisk?: number | null | undefined;
  slopBand?: string | null | undefined;
  mergeAttemptCount?: number | null | undefined;
  mergeBlockedSha?: string | null | undefined;
  mergeBlockedReason?: string | null | undefined;
  approvedHeadSha?: string | null | undefined;
  lastRegatedAt?: string | null | undefined;
  lastPublishedSurfaceSha?: string | null | undefined;
  changedFiles?: string[] | undefined;
};

export type PullRequestReviewRecord = {
  id: string;
  repoFullName: string;
  pullNumber: number;
  reviewerLogin?: string | null | undefined;
  state: string;
  authorAssociation?: string | null | undefined;
  submittedAt?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type CheckSummaryRecord = {
  id: string;
  repoFullName: string;
  pullNumber?: number | null | undefined;
  headSha?: string | null | undefined;
  name: string;
  status: string;
  conclusion?: string | null | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  detailsUrl?: string | null | undefined;
  payload: Record<string, JsonValue>;
};

export type ScoringModelSnapshotRecord = {
  id: string;
  sourceKind: "raw-github" | "api" | "fallback" | "test";
  sourceUrl: string;
  fetchedAt: string;
  activeModel: "current_density_model" | "pending_saturation_model" | "exponential_saturation_model" | "unknown";
  constants: Record<string, number>;
  programmingLanguages: Record<string, JsonValue>;
  registrySnapshotId?: string | null | undefined;
  warnings: string[];
  payload: Record<string, JsonValue>;
};

export type ScorePreviewRecord = {
  id: string;
  scoringModelSnapshotId: string;
  repoFullName: string;
  targetType: "planned_pr" | "pull_request" | "local_diff" | "variant";
  targetKey: string;
  contributorLogin?: string | null | undefined;
  input: Record<string, JsonValue>;
  result: Record<string, JsonValue>;
  generatedAt: string;
};

export type ContributorEvidenceRecord = {
  login: string;
  payload: Record<string, JsonValue>;
  generatedAt: string;
};

export type ContributorRole = "outside_contributor" | "repo_maintainer" | "org_member" | "collaborator" | "owner" | "unknown";

export type RoleContext = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  role: ContributorRole;
  maintainerLane: boolean;
  normalContributorEvidenceAllowed: boolean;
  source: "github_association" | "repo_owner_match" | "gittensor_api" | "cache" | "unknown";
  association?: string | null | undefined;
  reasons: string[];
  guidance: string;
};
