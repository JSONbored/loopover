import {
  getRepository,
  getRepositorySettings,
  listClosedContributorDraftIssues,
  listIssueSignalSample,
  listOpenIssues,
  listOpenPullRequests,
  listRecentMergedPullRequests,
  listRepoLabels,
  countOpenIssues,
  countOpenPullRequests,
  getLatestRepoGithubTotalsSnapshot,
  isGlobalAgentFrozen,
  listUpstreamDriftReports,
  recordAuditEvent,
} from "../db/repositories";
import type { IssueRecord, RepositoryRecord, RepositorySettings } from "../types";
import { isGlobalAgentPause } from "../settings/agent-execution";
import { isMaintainerAssociation } from "../github/commands";
import { timeoutFetch } from "../github/client";
import { sha256Hex } from "../utils/crypto";
import { jsonString, nowIso, repoParts } from "../utils/json";
import {
  buildCollisionReport,
  buildConfigQuality,
  buildContributorIntakeHealth,
  buildLabelAudit,
  buildLaneAdvice,
  buildQueueHealth,
  type ConfigQuality,
  type ContributorIntakeHealth,
  type LabelAudit,
  type LaneAdvice,
  type QueueHealth,
} from "../signals/engine";
import { isFocusManifestPublicSafe, type FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import {
  buildRepoPolicyReadiness,
  type RepoPolicyReadinessWarning,
  type RepoPolicyReadinessWarningCode,
} from "../signals/repo-policy-readiness";
import { registryHyperparameterDriftWarningsForRepo } from "../upstream/ruleset";

export const CONTRIBUTOR_ISSUE_DRAFT_MARKER_PREFIX = "gittensory-contributor-draft";

export type ContributorIssueDraftTopic =
  | `policy:${RepoPolicyReadinessWarningCode}`
  | "upstream:registry_drift"
  | `focus:wanted_path:${string}`;

export type ContributorIssueDraftStatus = "proposed" | "skipped_duplicate" | "skipped_declined" | "skipped_unsafe" | "created" | "skipped_create_failed";

export type ContributorIssueDraft = {
  fingerprint: string;
  topic: ContributorIssueDraftTopic;
  title: string;
  body: string;
  labels: string[];
  status: ContributorIssueDraftStatus;
  duplicateOf?: { number: number; title: string; reason: "marker" | "title" } | undefined;
  declinedBy?: { number: number; title: string; reason: "wontfix" | "cooldown" } | undefined;
  issue?: { number: number; url: string } | undefined;
};

export type ContributorIssueDraftGenerationResult = {
  repoFullName: string;
  generatedAt: string;
  dryRun: boolean;
  createRequested: boolean;
  proposed: number;
  skippedDuplicate: number;
  skippedDeclined: number;
  skippedUnsafe: number;
  created: number;
  skippedCreateFailed: number;
  drafts: ContributorIssueDraft[];
};

export type ContributorIssueDraftOptions = {
  dryRun?: boolean | undefined;
  create?: boolean | undefined;
  limit?: number | undefined;
  requestedBy?: string | undefined;
};

type ContributorIssueDraftContext = {
  repoFullName: string;
  repo: RepositoryRecord | null;
  settings: RepositorySettings;
  lane: LaneAdvice;
  configQuality: ConfigQuality;
  labelAudit: LabelAudit;
  queueHealth: QueueHealth;
  contributorIntakeHealth: ContributorIntakeHealth;
  focusManifest: FocusManifest;
  openIssues: IssueRecord[];
  declinedIssues?: IssueRecord[] | undefined;
  upstreamDriftWarnings: string[];
};

type DraftCandidate = {
  topic: ContributorIssueDraftTopic;
  title: string;
  labels: string[];
  sections: ContributorIssueDraftSections;
};

type ContributorIssueDraftSections = {
  background: string[];
  currentBehavior: string[];
  desiredBehavior: string[];
  implementationRequirements: string[];
  publicPrivateBoundaries: string[];
  acceptanceCriteria: string[];
  testingRequirements: string[];
};

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const GENERIC_TESTING_REQUIREMENTS = [
  "Run the repository's documented validation command before requesting review.",
  "Add tests for every new branch, fallback path, sanitizer rule, and regression.",
  "Public GitHub output must stay advisory and must not imply guaranteed participation outcomes.",
];

export function buildContributorIssueDraftTestingRequirements(manifest: FocusManifest): string[] {
  const policyExpectations = manifest.testExpectations.filter(isFocusManifestPublicSafe).map(formatContributorIssueDraftTestExpectation);
  if (policyExpectations.length === 0) return [...GENERIC_TESTING_REQUIREMENTS];
  return [
    ...policyExpectations,
    "Add tests for every new branch, fallback path, sanitizer rule, and regression.",
    "Public GitHub output must stay advisory and must not imply guaranteed participation outcomes.",
  ];
}

function formatContributorIssueDraftTestExpectation(expectation: string): string {
  const trimmed = expectation.trim();
  if (!trimmed) return GENERIC_TESTING_REQUIREMENTS[0]!;
  if (/^run\s+/i.test(trimmed) || trimmed.includes("must pass") || trimmed.endsWith(".")) return trimmed;
  return `Run ${trimmed} before requesting review.`;
}

export function contributorIssueDraftMarker(fingerprint: string): string {
  return `<!-- ${CONTRIBUTOR_ISSUE_DRAFT_MARKER_PREFIX}:${fingerprint} -->`;
}

export async function contributorIssueDraftFingerprint(repoFullName: string, topic: ContributorIssueDraftTopic, key: string): Promise<string> {
  return sha256Hex(`gittensory-contributor-draft:v1:${repoFullName.toLowerCase()}:${topic}:${key}`);
}

export function normalizeIssueTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findDuplicateContributorDraft(
  openIssues: IssueRecord[],
  draft: Pick<ContributorIssueDraft, "fingerprint" | "title">,
): { number: number; title: string; reason: "marker" | "title" } | null {
  const marker = contributorIssueDraftMarker(draft.fingerprint);
  for (const issue of openIssues) {
    if (issue.state !== "open") continue;
    if (issue.body?.includes(marker)) {
      return { number: issue.number, title: issue.title, reason: "marker" };
    }
  }
  const titleKey = normalizeIssueTitleKey(draft.title);
  if (!titleKey) return null;
  for (const issue of openIssues) {
    if (issue.state !== "open") continue;
    if (normalizeIssueTitleKey(issue.title) === titleKey) {
      return { number: issue.number, title: issue.title, reason: "title" };
    }
  }
  return null;
}

export const CONTRIBUTOR_ISSUE_DRAFT_DECLINED_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const DECLINED_DRAFT_WONTFIX_LABELS = new Set(["wontfix", "wont-fix", "invalid", "duplicate", "not-planned"]);

/**
 * Detect whether a draft was already declined through trusted maintainer evidence.
 * Matches by the stable marker fingerprint on a closed issue, but never lets an arbitrary
 * marker-bearing issue suppress generation: a `wontfix`-style label is trusted because
 * labels are maintainer-controlled, while cooldown suppression requires a maintainer-
 * associated issue author. Cooldowns use GitHub's close timestamp instead of `updated_at`
 * so comments or unrelated edits cannot refresh the suppression window.
 */
export function findDeclinedContributorDraft(
  closedIssues: IssueRecord[],
  draft: Pick<ContributorIssueDraft, "fingerprint">,
  options: { now?: number | undefined; cooldownMs?: number | undefined } = {},
): { number: number; title: string; reason: "wontfix" | "cooldown" } | null {
  const marker = contributorIssueDraftMarker(draft.fingerprint);
  const nowMs = options.now ?? Date.now();
  const cooldownMs = options.cooldownMs ?? CONTRIBUTOR_ISSUE_DRAFT_DECLINED_COOLDOWN_MS;
  for (const issue of closedIssues) {
    if (issue.state !== "closed") continue;
    if (!issue.body?.includes(marker)) continue;
    if (issue.labels.some((label) => DECLINED_DRAFT_WONTFIX_LABELS.has(label.trim().toLowerCase()))) {
      return { number: issue.number, title: issue.title, reason: "wontfix" };
    }
    if (!isMaintainerAssociation(issue.authorAssociation)) continue;
    const closedAtMs = issue.closedAt ? Date.parse(issue.closedAt) : Number.NaN;
    if (!Number.isFinite(closedAtMs) || nowMs - closedAtMs < cooldownMs) {
      return { number: issue.number, title: issue.title, reason: "cooldown" };
    }
  }
  return null;
}

export function buildContributorIssueDraftBody(fingerprint: string, sections: ContributorIssueDraftSections): string {
  const blocks: string[] = [contributorIssueDraftMarker(fingerprint), "", "## Background", "", ...sections.background, "", "## Current Behavior", "", ...sections.currentBehavior, "", "## Desired Behavior", "", ...sections.desiredBehavior, "", "## Implementation Requirements", "", ...sections.implementationRequirements.map((line) => `- ${line}`), "", "## Public/Private Output Boundaries", "", ...sections.publicPrivateBoundaries.map((line) => `- ${line}`), "", "## Acceptance Criteria", "", ...sections.acceptanceCriteria.map((line) => `- ${line}`), "", "## Testing Requirements", "", ...sections.testingRequirements.map((line) => `- ${line}`)];
  return blocks.join("\n");
}

export function isContributorIssueDraftPublicSafe(draft: Pick<ContributorIssueDraft, "title" | "body">): boolean {
  return isFocusManifestPublicSafe(draft.title) && isFocusManifestPublicSafe(draft.body);
}

export function buildContributorIssueDraftCandidates(context: ContributorIssueDraftContext): DraftCandidate[] {
  const candidates: DraftCandidate[] = [];
  const policy = buildRepoPolicyReadiness({
    repoFullName: context.repoFullName,
    focusManifest: context.focusManifest,
    settings: context.settings,
    lane: context.lane,
    configQuality: context.configQuality,
    labelAudit: context.labelAudit,
    queueHealth: context.queueHealth,
    contributorIntakeHealth: context.contributorIntakeHealth,
  });

  for (const warning of policy.publicWarnings) {
    if (warning.severity === "info") continue;
    const candidate = policyWarningCandidate(context.repoFullName, warning, context.focusManifest);
    if (candidate) candidates.push(candidate);
  }

  if (context.upstreamDriftWarnings.length > 0) {
    candidates.push(upstreamDriftCandidate(context.repoFullName, context.upstreamDriftWarnings, context.focusManifest));
  }

  for (const path of context.focusManifest.wantedPaths.slice(0, 3)) {
    const candidate = wantedPathCandidate(context.repoFullName, path, context.openIssues, context.focusManifest);
    if (candidate) candidates.push(candidate);
  }

  return dedupeCandidatesByTopic(candidates);
}

export async function generateContributorIssueDrafts(
  env: Env,
  repoFullName: string,
  options: ContributorIssueDraftOptions = {},
): Promise<ContributorIssueDraftGenerationResult> {
  // The caller's dryRun flag, OVERLAID with the global agent kill-switch: a paused/frozen agent must not file
  // contributor issues even when a caller passes {dryRun:false}. These POSTs use a raw token outside the
  // installation-Octokit dry-run chokepoint (#dry-run-chokepoint), so the brake is applied here. (#audit-rawfetch-pause)
  const dryRun = options.dryRun !== false || isGlobalAgentPause(env) || (await isGlobalAgentFrozen(env));
  const createRequested = options.create === true;
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const context = await loadContributorIssueDraftContext(env, repoFullName);
  const candidates = buildContributorIssueDraftCandidates(context).slice(0, limit);
  const drafts: ContributorIssueDraft[] = [];
  let proposed = 0;
  let skippedDuplicate = 0;
  let skippedDeclined = 0;
  let skippedUnsafe = 0;
  let created = 0;
  let skippedCreateFailed = 0;

  for (const candidate of candidates) {
    const fingerprint = await contributorIssueDraftFingerprint(repoFullName, candidate.topic, candidateKey(candidate));
    const body = buildContributorIssueDraftBody(fingerprint, candidate.sections);
    const draft: ContributorIssueDraft = {
      fingerprint,
      topic: candidate.topic,
      title: candidate.title,
      body,
      labels: candidate.labels,
      status: "proposed",
    };
    if (!isContributorIssueDraftPublicSafe(draft)) {
      draft.status = "skipped_unsafe";
      skippedUnsafe += 1;
      drafts.push(draft);
      continue;
    }
    const duplicate = findDuplicateContributorDraft(context.openIssues, draft);
    if (duplicate) {
      draft.status = "skipped_duplicate";
      draft.duplicateOf = duplicate;
      skippedDuplicate += 1;
      drafts.push(draft);
      continue;
    }
    /* v8 ignore next -- loadContributorIssueDraftContext always sets declinedIssues; the [] fallback only guards hand-built candidate contexts. */
    const declined = findDeclinedContributorDraft(context.declinedIssues ?? [], draft);
    if (declined) {
      draft.status = "skipped_declined";
      draft.declinedBy = declined;
      skippedDeclined += 1;
      drafts.push(draft);
      continue;
    }
    if (!dryRun && createRequested) {
      const issue = await createGitHubContributorIssue(env, repoFullName, draft);
      if (issue) {
        draft.status = "created";
        draft.issue = issue;
        created += 1;
        context.openIssues.push({
          repoFullName,
          number: issue.number,
          title: draft.title,
          state: "open",
          labels: draft.labels,
          linkedPrs: [],
          body: draft.body,
        });
      } else {
        draft.status = "skipped_create_failed";
        skippedCreateFailed += 1;
      }
    } else {
      proposed += 1;
    }
    drafts.push(draft);
  }

  if (!dryRun && createRequested && created > 0) {
    await recordAuditEvent(env, {
      eventType: "contributor.issue_drafts_created",
      outcome: "completed",
      metadata: {
        repoFullName,
        created,
        requestedBy: options.requestedBy ?? "api",
        fingerprints: drafts.filter((entry) => entry.status === "created").map((entry) => entry.fingerprint),
      },
    });
  }

  return {
    repoFullName,
    generatedAt: nowIso(),
    dryRun,
    createRequested,
    proposed,
    skippedDuplicate,
    skippedDeclined,
    skippedUnsafe,
    created,
    skippedCreateFailed,
    drafts,
  };
}

function candidateKey(candidate: DraftCandidate): string {
  if (candidate.topic.startsWith("focus:wanted_path")) return candidate.sections.background.join("|");
  return candidate.topic;
}

function dedupeCandidatesByTopic(candidates: DraftCandidate[]): DraftCandidate[] {
  const seen = new Set<string>();
  const result: DraftCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.topic)) continue;
    seen.add(candidate.topic);
    result.push(candidate);
  }
  return result;
}

function policyWarningCandidate(repoFullName: string, warning: RepoPolicyReadinessWarning, manifest: FocusManifest): DraftCandidate | null {
  const title = policyWarningTitle(warning);
  if (!title || !isFocusManifestPublicSafe(title)) return null;
  return {
    topic: `policy:${warning.code}`,
    title,
    labels: policyWarningLabels(warning),
    sections: {
      background: [
        `Maintainers need a tracked contributor issue for ${repoFullName} so policy guidance can scale beyond hand-authored templates.`,
        warning.detail,
      ],
      currentBehavior: ["Contributor issues are hand-authored without a repeatable policy-backed draft contract."],
      desiredBehavior: [warning.action, "Publish a structured issue miners can execute without private maintainer context."],
      implementationRequirements: [
        "Use the repo focus manifest and current signal snapshots as the source of truth.",
        "Keep the change scoped to the warning category and avoid unrelated UI or docs-site churn unless safety requires it.",
        "Default to dry-run review; do not auto-post GitHub issues without explicit maintainer approval.",
      ],
      publicPrivateBoundaries: [
        "Public GitHub issues must stay advisory and must not imply guaranteed participation outcomes.",
        "Do not expose credentials, miner keys, or private maintainer-only evaluation language.",
        "Keep private maintainer notes in authenticated Gittensory surfaces only.",
      ],
      acceptanceCriteria: [
        "The warning category is addressed with tests and documentation where applicable.",
        "Focus manifest and settings guidance stay consistent for contributors.",
        "No forbidden public language appears in generated maintainer or GitHub output.",
      ],
      testingRequirements: buildContributorIssueDraftTestingRequirements(manifest),
    },
  };
}

function policyWarningTitle(warning: RepoPolicyReadinessWarning): string {
  const slug = warning.code.replace(/_/g, "-");
  return `feat(issues): address ${slug} policy readiness for repo`;
}

function policyWarningLabels(warning: RepoPolicyReadinessWarning): string[] {
  if (warning.category === "issue_discovery") return ["enhancement", "signals", "agent"];
  if (warning.category === "validation") return ["enhancement", "signals"];
  if (warning.category === "maintainer_burden") return ["documentation", "signals"];
  return ["enhancement", "developer-experience", "signals"];
}

function upstreamDriftCandidate(repoFullName: string, warnings: string[], manifest: FocusManifest): DraftCandidate {
  return {
    topic: "upstream:registry_drift",
    title: `feat(issues): reconcile upstream registry drift for ${repoFullName}`,
    labels: ["signals", "enhancement"],
    sections: {
      background: [
        "Gittensory detected upstream Gittensor registry drift that may require fixture or guidance updates for this repo.",
        ...warnings.slice(0, 5),
      ],
      currentBehavior: ["Upstream drift is visible in private signals but may not yet have a contributor-ready tracking issue."],
      desiredBehavior: [
        "Add or update regression coverage for affected registry surfaces.",
        "Keep public GitHub guidance aligned with the current upstream ruleset.",
      ],
      implementationRequirements: [
        "Inspect the private upstream drift report before changing scoring fixtures.",
        "Limit changes to modules affected by the drift summary.",
      ],
      publicPrivateBoundaries: [
        "Do not publish private contributor ordering or compensation estimates on GitHub.",
        "Keep maintainer triage notes in authenticated Gittensory views only.",
      ],
      acceptanceCriteria: [
        "Upstream drift warnings for this repo are resolved or documented as expected semantic change.",
        "Tests cover any new parsing or registry normalization branches.",
      ],
      testingRequirements: buildContributorIssueDraftTestingRequirements(manifest),
    },
  };
}

function wantedPathCandidate(repoFullName: string, wantedPath: string, openIssues: IssueRecord[], manifest: FocusManifest): DraftCandidate | null {
  const pathKey = wantedPath.replace(/\//g, " ").trim();
  const title = `feat(${pathSlug(wantedPath)}): expand high-value work in ${wantedPath}`;
  if (!isFocusManifestPublicSafe(title)) return null;
  if (openIssues.some((issue) => issue.state === "open" && (issue.title.toLowerCase().includes(pathKey.toLowerCase()) || issue.body?.includes(wantedPath)))) {
    return null;
  }
  const publicNotes = manifest.publicNotes.filter(isFocusManifestPublicSafe).slice(0, 2);
  return {
    topic: `focus:wanted_path:${wantedPath}`,
    title,
    labels: ["enhancement", "miner-value", "signals"],
    sections: {
      background: [
        `Repo focus policy marks ${wantedPath} as a wanted contribution area for ${repoFullName}.`,
        ...(publicNotes.length > 0 ? publicNotes : ["Prefer backend, MCP, GitHub App, and scoring work over website-only polish."]),
      ],
      currentBehavior: [`Open backlog does not yet highlight actionable work scoped to ${wantedPath}.`],
      desiredBehavior: [
        `Add a focused change within ${wantedPath} that improves miner/contributor value.`,
        "Link the implementation issue before opening a PR when the focus manifest prefers tracked work.",
      ],
      implementationRequirements: [
        `Stay within ${wantedPath} unless safety or release readiness requires adjacent files.`,
        "Avoid blocked manifest paths and keep PRs narrowly scoped.",
        ...(manifest.testExpectations.length > 0 ? manifest.testExpectations.map((entry) => `Run ${entry} before requesting review.`) : []),
      ],
      publicPrivateBoundaries: [
        "Public issues must not promise compensation, sort contributors, or expose private maintainer-only claims.",
        "Keep maintainerNotes private; use publicNotes only when explicitly opted in.",
      ],
      acceptanceCriteria: [
        `The change materially improves ${wantedPath} without expanding beyond the requested scope.`,
        "Manifest-guided guidance and tests stay aligned.",
      ],
      testingRequirements: buildContributorIssueDraftTestingRequirements(manifest),
    },
  };
}

function pathSlug(path: string): string {
  const cleaned = path.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 24) || "scope";
}

async function loadContributorIssueDraftContext(env: Env, repoFullName: string): Promise<ContributorIssueDraftContext> {
  // Intentionally the raw DB `settings` alongside the raw (cache-only, never live-fetched) `focusManifest`,
  // not resolveRepositorySettings's merged view: downstream consumers (e.g. buildContributorIssueDraftTestingRequirements)
  // read `focusManifest` on its own for the yml-authored policy (wantedPaths/testExpectations/etc.), separate
  // from `settings` for the currently-active dashboard/API behavior (#2912).
  const [repo, settings, openIssues, declinedIssues, focusManifest, upstreamReports, issues, pullRequests, recentMergedPullRequests, labels, queueCounts] = await Promise.all([
    getRepository(env, repoFullName),
    getRepositorySettings(env, repoFullName),
    listOpenIssues(env, repoFullName),
    listClosedContributorDraftIssues(env, repoFullName, `<!-- ${CONTRIBUTOR_ISSUE_DRAFT_MARKER_PREFIX}`),
    loadRepoFocusManifest(env, repoFullName, { fetcher: async () => null }),
    listUpstreamDriftReports(env, 20),
    listIssueSignalSample(env, repoFullName),
    listOpenPullRequests(env, repoFullName),
    listRecentMergedPullRequests(env, repoFullName),
    listRepoLabels(env, repoFullName),
    loadContributorIssueDraftQueueCounts(env, repoFullName),
  ]);
  const collisions = buildCollisionReport(repoFullName, issues, pullRequests, recentMergedPullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions, queueCounts);
  const configQuality = buildConfigQuality(repo, issues, pullRequests, repoFullName);
  const labelAudit = buildLabelAudit(repo, labels, issues, pullRequests, repoFullName);
  const contributorIntakeHealth = buildContributorIntakeHealth(repo, issues, pullRequests, repoFullName, collisions, queueCounts);
  return {
    repoFullName,
    repo,
    settings,
    lane: buildLaneAdvice(repo, repoFullName),
    configQuality,
    labelAudit,
    queueHealth,
    contributorIntakeHealth,
    focusManifest,
    openIssues,
    declinedIssues,
    upstreamDriftWarnings: registryHyperparameterDriftWarningsForRepo(upstreamReports, repoFullName),
  };
}

async function loadContributorIssueDraftQueueCounts(env: Env, repoFullName: string): Promise<{ openIssues: number; openPullRequests: number }> {
  const [totals, openIssues, openPullRequests] = await Promise.all([
    getLatestRepoGithubTotalsSnapshot(env, repoFullName),
    countOpenIssues(env, repoFullName),
    countOpenPullRequests(env, repoFullName),
  ]);
  return {
    openIssues: totals?.openIssuesTotal ?? openIssues,
    openPullRequests: totals?.openPullRequestsTotal ?? openPullRequests,
  };
}

async function createGitHubContributorIssue(env: Env, repoFullName: string, draft: ContributorIssueDraft): Promise<{ number: number; url: string } | null> {
  const token = env.GITTENSORY_CONTRIBUTOR_ISSUE_TOKEN ?? env.GITTENSORY_DRIFT_ISSUE_TOKEN ?? env.GITHUB_PUBLIC_TOKEN;
  if (!token) return null;
  const { owner, name } = repoParts(repoFullName);
  if (!owner || !name) return null;
  const response = await timeoutFetch(`https://api.github.com/repos/${owner}/${name}/issues`, {
    method: "POST",
    headers: githubHeaders(token),
    body: jsonString({
      title: draft.title,
      body: draft.body,
      labels: draft.labels,
    }),
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { number?: number; html_url?: string };
  return payload.number && payload.html_url ? { number: payload.number, url: payload.html_url } : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };
}
