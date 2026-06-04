import { z } from "zod";
import { sanitizePublicComment } from "../github/commands";

export const SCENARIO_INPUT_VERSION = 1 as const;

export const scenarioInputKinds = ["fact", "assumption", "estimate", "unavailable"] as const;
export type ScenarioInputKind = (typeof scenarioInputKinds)[number];

export const scenarioTypes = [
  "open_pr_pressure",
  "pending_pr_resolution",
  "branch_preflight",
  "linked_issue_context",
  "general_repo",
] as const;
export type ScenarioType = (typeof scenarioTypes)[number];

export const scenarioSignalSources = [
  "github_observed",
  "user_supplied",
  "local_metadata",
  "registry",
  "gittensory_projection",
  "missing",
] as const;
export type ScenarioSignalSource = (typeof scenarioSignalSources)[number];

const FORBIDDEN_PUBLIC_LANGUAGE =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|reward[-\s]?estimate|farming|raw trust|trust[-\s]?score|scoreability|private[-\s]?reviewability|public[-\s]?score[-\s]?(?:estimate|prediction)/i;

const FORBIDDEN_SOURCE_UPLOAD_KEYS =
  /^(?:sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff)$/i;

const scenarioSignalEntrySchema = z
  .object({
    id: z.string().min(1).max(120),
    kind: z.enum(scenarioInputKinds),
    label: z.string().min(1).max(200),
    detail: z.string().min(1).max(2000),
    source: z.enum(scenarioSignalSources),
  })
  .strict();

export type ScenarioSignalEntry = z.infer<typeof scenarioSignalEntrySchema>;

const scenarioRepoConfigSchema = z
  .object({
    repoFullName: z.string().min(3).max(200),
    registered: z.boolean().optional(),
    maintainerLane: z.boolean().optional(),
  })
  .strict();

export type ScenarioRepoConfig = z.infer<typeof scenarioRepoConfigSchema>;

const scenarioIssueStateSchema = z
  .object({
    openIssueCount: z.number().int().min(0).optional(),
    linkedIssueNumbers: z.array(z.number().int().positive()).max(50).optional(),
  })
  .strict();

export type ScenarioIssueState = z.infer<typeof scenarioIssueStateSchema>;

const scenarioPullRequestStateSchema = z
  .object({
    openPrCount: z.number().int().min(0).optional(),
    draftPrCount: z.number().int().min(0).optional(),
    stalePrCount: z.number().int().min(0).optional(),
    targetPullNumber: z.number().int().positive().optional(),
  })
  .strict();

export type ScenarioPullRequestState = z.infer<typeof scenarioPullRequestStateSchema>;

const scenarioBranchStateSchema = z
  .object({
    branchName: z.string().min(1).max(200).optional(),
    baseRef: z.string().min(1).max(200).optional(),
    headRef: z.string().min(1).max(200).optional(),
    pendingCommitCount: z.number().int().min(0).optional(),
    changedFileCount: z.number().int().min(0).optional(),
    eligibilityStatus: z.enum(["eligible", "ineligible", "unknown"]).optional(),
  })
  .strict();

export type ScenarioBranchState = z.infer<typeof scenarioBranchStateSchema>;

export const agentScenarioInputSchema = z
  .object({
    version: z.literal(SCENARIO_INPUT_VERSION),
    scenarioType: z.enum(scenarioTypes),
    repo: scenarioRepoConfigSchema,
    issueState: scenarioIssueStateSchema.optional(),
    pullRequestState: scenarioPullRequestStateSchema.optional(),
    branchState: scenarioBranchStateSchema.optional(),
    facts: z.array(scenarioSignalEntrySchema).max(100),
    assumptions: z.array(scenarioSignalEntrySchema).max(100),
    estimates: z.array(scenarioSignalEntrySchema).max(100),
    unavailableSignals: z.array(scenarioSignalEntrySchema).max(100),
    advisoryOnly: z.literal(true),
    notAutonomousPrBot: z.literal(true),
    notPublicScoring: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateBucketKinds(value.facts, "facts", "fact", ctx);
    validateBucketKinds(value.assumptions, "assumptions", "assumption", ctx);
    validateBucketKinds(value.estimates, "estimates", "estimate", ctx);
    validateBucketKinds(value.unavailableSignals, "unavailableSignals", "unavailable", ctx);
  });

export type AgentScenarioInput = z.infer<typeof agentScenarioInputSchema>;

export type PublicScenarioInputSnapshot = {
  version: typeof SCENARIO_INPUT_VERSION;
  scenarioType: ScenarioType;
  repo: ScenarioRepoConfig;
  issueState?: ScenarioIssueState;
  pullRequestState?: ScenarioPullRequestState;
  branchState?: ScenarioBranchState;
  facts: Array<Pick<ScenarioSignalEntry, "id" | "kind" | "label" | "detail" | "source">>;
  assumptions: Array<Pick<ScenarioSignalEntry, "id" | "kind" | "label" | "detail" | "source">>;
  estimates: Array<Pick<ScenarioSignalEntry, "id" | "kind" | "label" | "detail" | "source">>;
  unavailableSignals: Array<Pick<ScenarioSignalEntry, "id" | "kind" | "label" | "detail" | "source">>;
  advisoryOnly: true;
  notAutonomousPrBot: true;
  notPublicScoring: true;
};

export function createScenarioSignalEntry(args: {
  id: string;
  kind: ScenarioInputKind;
  label: string;
  detail: string;
  source: ScenarioSignalSource;
}): ScenarioSignalEntry {
  return scenarioSignalEntrySchema.parse(args);
}

export function parseAgentScenarioInput(raw: unknown): AgentScenarioInput {
  return normalizeScenarioInput(agentScenarioInputSchema.parse(raw));
}

export function normalizeScenarioInput(input: AgentScenarioInput): AgentScenarioInput {
  return agentScenarioInputSchema.parse({
    ...input,
    facts: sortEntries(input.facts),
    assumptions: sortEntries(input.assumptions),
    estimates: sortEntries(input.estimates),
    unavailableSignals: sortEntries(input.unavailableSignals),
  });
}

export function buildScenarioInput(args: {
  scenarioType: ScenarioType;
  repoFullName: string;
  registered?: boolean;
  maintainerLane?: boolean;
  issueState?: ScenarioIssueState;
  pullRequestState?: ScenarioPullRequestState;
  branchState?: ScenarioBranchState;
  facts?: ScenarioSignalEntry[];
  assumptions?: ScenarioSignalEntry[];
  estimates?: ScenarioSignalEntry[];
  unavailableSignals?: ScenarioSignalEntry[];
}): AgentScenarioInput {
  return normalizeScenarioInput({
    version: SCENARIO_INPUT_VERSION,
    scenarioType: args.scenarioType,
    repo: compactRepoConfig(args),
    ...(args.issueState !== undefined ? { issueState: args.issueState } : {}),
    ...(args.pullRequestState !== undefined ? { pullRequestState: args.pullRequestState } : {}),
    ...(args.branchState !== undefined ? { branchState: args.branchState } : {}),
    facts: args.facts ?? [],
    assumptions: args.assumptions ?? [],
    estimates: args.estimates ?? [],
    unavailableSignals: args.unavailableSignals ?? [],
    advisoryOnly: true,
    notAutonomousPrBot: true,
    notPublicScoring: true,
  });
}

export function assertScenarioLocalBranchInputSafe(payload: Record<string, unknown>): void {
  if (/^(1|true|yes)$/i.test(String(process.env.GITTENSORY_UPLOAD_SOURCE ?? "false"))) {
    throw new Error("GITTENSORY_UPLOAD_SOURCE=true is not supported; scenario inputs remain metadata-only.");
  }
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_SOURCE_UPLOAD_KEYS.test(key)) {
      throw new Error(`Refusing scenario local-branch field ${key}; source contents are never uploaded.`);
    }
  }
  const changedFiles = payload.changedFiles;
  if (Array.isArray(changedFiles)) {
    for (const entry of changedFiles) {
      if (!entry || typeof entry !== "object") continue;
      for (const nestedKey of Object.keys(entry as Record<string, unknown>)) {
        if (FORBIDDEN_SOURCE_UPLOAD_KEYS.test(nestedKey)) {
          throw new Error(`Refusing changedFiles.${nestedKey}; source contents are never uploaded.`);
        }
        const value = (entry as Record<string, unknown>)[nestedKey];
        if (typeof value === "string" && value.length > 4000) {
          throw new Error("Refusing oversized changedFiles payload; metadata-only paths are required.");
        }
      }
    }
  }
}

export function scenarioInputFromLocalBranchMetadata(args: {
  scenarioType: ScenarioType;
  login: string;
  repoFullName: string;
  branchName?: string;
  baseRef?: string;
  changedFileCount?: number;
  linkedIssues?: number[];
  scenarioNotes?: string[];
  eligibilityStatus?: "eligible" | "ineligible" | "unknown";
}): AgentScenarioInput {
  const facts: ScenarioSignalEntry[] = [
    createScenarioSignalEntry({
      id: "actor",
      kind: "fact",
      label: "Contributor",
      detail: `Planning scenario for ${args.login}.`,
      source: "github_observed",
    }),
    createScenarioSignalEntry({
      id: "repo",
      kind: "fact",
      label: "Repository",
      detail: `Repo context is ${args.repoFullName}.`,
      source: "local_metadata",
    }),
  ];
  if (args.branchName) {
    facts.push(
      createScenarioSignalEntry({
        id: "branch",
        kind: "fact",
        label: "Branch",
        detail: `Active branch ${args.branchName}${args.baseRef ? ` against ${args.baseRef}` : ""}.`,
        source: "local_metadata",
      }),
    );
  }
  const assumptions =
    args.scenarioNotes?.map((note, index) =>
      createScenarioSignalEntry({
        id: `assumption_${index + 1}`,
        kind: "assumption",
        label: "Caller assumption",
        detail: note.trim(),
        source: "user_supplied",
      }),
    ) ?? [];
  const unavailableSignals: ScenarioSignalEntry[] = [];
  if (args.eligibilityStatus === "unknown") {
    unavailableSignals.push(
      createScenarioSignalEntry({
        id: "branch_eligibility",
        kind: "unavailable",
        label: "Branch eligibility",
        detail: "Branch eligibility evidence is missing or stale.",
        source: "missing",
      }),
    );
  }
  const branchState = compactBranchState(args);
  return buildScenarioInput({
    scenarioType: args.scenarioType,
    repoFullName: args.repoFullName,
    ...(branchState ? { branchState } : {}),
    ...(args.linkedIssues?.length ? { issueState: { linkedIssueNumbers: args.linkedIssues } } : {}),
    facts,
    assumptions,
    unavailableSignals,
  });
}

export function serializeScenarioInputPublic(input: AgentScenarioInput): PublicScenarioInputSnapshot {
  const normalized = normalizeScenarioInput(input);
  const snapshot: PublicScenarioInputSnapshot = {
    version: normalized.version,
    scenarioType: normalized.scenarioType,
    repo: normalized.repo,
    ...(normalized.issueState !== undefined ? { issueState: normalized.issueState } : {}),
    ...(normalized.pullRequestState !== undefined ? { pullRequestState: normalized.pullRequestState } : {}),
    ...(normalized.branchState !== undefined ? { branchState: normalized.branchState } : {}),
    facts: normalized.facts.map(sanitizeScenarioEntryPublic),
    assumptions: normalized.assumptions.map(sanitizeScenarioEntryPublic),
    estimates: normalized.estimates.map(sanitizeScenarioEntryPublic),
    unavailableSignals: normalized.unavailableSignals.map(sanitizeScenarioEntryPublic),
    advisoryOnly: true,
    notAutonomousPrBot: true,
    notPublicScoring: true,
  };
  assertPublicScenarioSnapshotSafe(snapshot);
  return snapshot;
}

export function serializeScenarioInputPrivate(input: AgentScenarioInput): AgentScenarioInput {
  return normalizeScenarioInput(input);
}

function sanitizeScenarioEntryPublic(entry: ScenarioSignalEntry): ScenarioSignalEntry {
  return {
    ...entry,
    label: sanitizePublicComment(entry.label),
    detail: sanitizePublicComment(entry.detail),
  };
}

function assertPublicScenarioSnapshotSafe(snapshot: PublicScenarioInputSnapshot): void {
  const serialized = JSON.stringify(snapshot);
  /* v8 ignore start -- Public entries are sanitized before this guard; defensive check for future fields. */
  if (FORBIDDEN_PUBLIC_LANGUAGE.test(serialized)) {
    throw new Error("Public scenario serialization still contains forbidden language.");
  }
  /* v8 ignore end */
}

function validateBucketKinds(
  entries: ScenarioSignalEntry[],
  bucket: "facts" | "assumptions" | "estimates" | "unavailableSignals",
  expectedKind: ScenarioInputKind,
  ctx: z.RefinementCtx,
): void {
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== expectedKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Entry ${entry.id} must use kind ${expectedKind} in ${bucket}`,
        path: [bucket, index, "kind"],
      });
    }
  }
}

function sortEntries(entries: ScenarioSignalEntry[]): ScenarioSignalEntry[] {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

function compactRepoConfig(args: { repoFullName: string; registered?: boolean; maintainerLane?: boolean }): ScenarioRepoConfig {
  const repo: ScenarioRepoConfig = { repoFullName: args.repoFullName.trim() };
  if (args.registered !== undefined) repo.registered = args.registered;
  if (args.maintainerLane !== undefined) repo.maintainerLane = args.maintainerLane;
  return repo;
}

function compactBranchState(args: {
  branchName?: string;
  baseRef?: string;
  changedFileCount?: number;
  eligibilityStatus?: "eligible" | "ineligible" | "unknown";
}): ScenarioBranchState | undefined {
  if (!args.branchName && !args.baseRef && args.changedFileCount === undefined && !args.eligibilityStatus) {
    return undefined;
  }
  const branchState: ScenarioBranchState = {};
  if (args.branchName) branchState.branchName = args.branchName;
  if (args.baseRef) branchState.baseRef = args.baseRef;
  if (args.changedFileCount !== undefined) branchState.changedFileCount = args.changedFileCount;
  if (args.eligibilityStatus) branchState.eligibilityStatus = args.eligibilityStatus;
  return branchState;
}
