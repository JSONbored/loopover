export type AiPolicySource = "AI-USAGE.md" | "CONTRIBUTING.md" | "none";

export type AiPolicyFatigueLevel = "none" | "watch" | "deprioritize" | "defer";
export type AiPolicyPriorityAdjustment = "none" | "deprioritize" | "defer";

export type AiPolicyFatigueEvidenceKind =
  | "terse_ai_attributed_rejection_cluster"
  | "recent_ai_doc_language"
  | "ai_attributed_closed_pr"
  | "cache_fresh"
  | "formal_ban_overrides";

export type AiPolicyFatigueEvidence = {
  kind: AiPolicyFatigueEvidenceKind;
  weight: number;
  summary: string;
  observedAt: string | null;
};

export type AiPolicyFatigueVerdict = {
  level: AiPolicyFatigueLevel;
  priorityAdjustment: AiPolicyPriorityAdjustment;
  score: number;
  recheckAfterHours: number;
  evidence: AiPolicyFatigueEvidence[];
};

export type AiPolicyVerdict = {
  allowed: boolean;
  matchedPhrase: string | null;
  source: AiPolicySource;
  fatigue?: AiPolicyFatigueVerdict | undefined;
};

type BanPhrase = {
  phrase: string;
  pattern: RegExp;
};

export type AiFatiguePullRequestMetadata = {
  id?: string | number | undefined;
  state: "open" | "closed" | "merged" | string;
  authorLogin?: string | undefined;
  title?: string | undefined;
  labels?: readonly string[] | undefined;
  createdAt?: string | Date | null | undefined;
  closedAt?: string | Date | null | undefined;
  mergedAt?: string | Date | null | undefined;
  reviewDecision?: "approved" | "changes_requested" | "commented" | "none" | string | undefined;
  closeReason?: "not_planned" | "completed" | "duplicate" | "spam" | string | undefined;
  maintainerResponse?: "terse_rejection" | "template_rejection" | "neutral" | "helpful" | string | undefined;
};

export type AiFatigueDocLanguageChange = {
  path: "AI-USAGE.md" | "CONTRIBUTING.md" | string;
  changedAt?: string | Date | null | undefined;
  addedText?: string | undefined;
  addedPhrases?: readonly string[] | undefined;
};

export type AiPolicyFatigueCacheEntry = {
  repoFullName: string;
  computedAt: string | Date;
  verdict: AiPolicyFatigueVerdict;
};

export type AiPolicyFatigueCacheState = {
  repoFullName: string;
  computedAt: string | null;
  expiresAt: string | null;
  ageHours: number | null;
  fresh: boolean;
};

export type AiPolicyFatigueInput = {
  docs: {
    aiUsage: string | null | undefined;
    contributing: string | null | undefined;
  };
  pullRequests?: readonly AiFatiguePullRequestMetadata[] | undefined;
  docChanges?: readonly AiFatigueDocLanguageChange[] | undefined;
  now?: string | Date | undefined;
  cache?: AiPolicyFatigueCacheEntry | null | undefined;
};

export type AiPolicyFatigueRankInput = {
  potential: number;
  feasibility: number;
  laneFit: number;
  freshness: number;
  dupRisk: number;
};

export type AiPolicyFatigueRankAdjustment = AiPolicyFatigueRankInput & {
  fatigueLevel: AiPolicyFatigueLevel;
  priorityAdjustment: AiPolicyPriorityAdjustment;
  fatigueMultiplier: number;
  deferUntilHours: number | null;
  reasons: string[];
};

const AI_POLICY_ALLOWED: AiPolicyVerdict = {
  allowed: true,
  matchedPhrase: null,
  source: "none",
};

const AI_FATIGUE_NONE: AiPolicyFatigueVerdict = {
  level: "none",
  priorityAdjustment: "none",
  score: 0,
  recheckAfterHours: 168,
  evidence: [],
};

const BAN_PHRASES: BanPhrase[] = [
  {
    phrase: "no ai-generated pull requests",
    pattern: /\bno\s+ai[-\s]+generated\s+(?:pull\s+requests|prs|contributions)\b/i,
  },
  {
    phrase: "ai-generated prs are rejected",
    pattern:
      /\bai[-\s]+generated\s+(?:prs?|pull\s+requests|contributions?)\s+(?:are|will\s+be)\s+(?:banned|rejected|not\s+accepted)\b/i,
  },
  {
    phrase: "do not submit ai-generated code",
    pattern: /\bdo\s+not\s+(?:use|submit)\s+ai[-\s]+(?:written|generated)\s+code\b/i,
  },
  {
    phrase: "llm-generated code is not accepted",
    pattern: /\b(?:ai|llm)[-\s]+generated\s+code\s+(?:is|will\s+be)\s+(?:rejected|not\s+accepted)\b/i,
  },
];

const AI_ATTRIBUTION_PATTERNS = [
  /\bai[-\s]?(?:generated|assisted|authored)\b/iu,
  /\b(?:llm|chatgpt|copilot|codex|claude)[-\s]?(?:generated|assisted|authored)?\b/iu,
  /\b(?:automation|bot)[-\s]?(?:generated|submitted|authored)\b/iu,
];

const AI_DOC_LANGUAGE_PATTERNS = [
  /\bai\b/iu,
  /\bllm\b/iu,
  /\bautomation\b/iu,
  /\bautomated\s+(?:prs?|pull\s+requests|contributions?)\b/iu,
  /\bgenerated\s+(?:code|prs?|pull\s+requests|contributions?)\b/iu,
];

const Terse_REJECTION_RESPONSES = new Set(["terse_rejection", "template_rejection"]);
const FATIGUE_CACHE_TTL_HOURS = 24;

function parseInstant(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function requireNow(value: string | Date | undefined): Date {
  const parsed = parseInstant(value);
  return parsed ? new Date(parsed) : new Date();
}

function hoursBetween(left: string, right: Date): number {
  return Math.max(0, (right.getTime() - new Date(left).getTime()) / 3_600_000);
}

function recencyWeight(observedAt: string | null, now: Date, halfLifeDays: number): number {
  if (!observedAt) return 0.35;
  const ageDays = hoursBetween(observedAt, now) / 24;
  return Math.exp(-ageDays / halfLifeDays);
}

function roundScore(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function roundHours(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function collapseInline(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
}

function metadataText(pr: AiFatiguePullRequestMetadata): string {
  return [pr.title, ...(pr.labels ?? []), pr.authorLogin].filter((value): value is string => Boolean(value)).join(" ");
}

function isAiAttributed(pr: AiFatiguePullRequestMetadata): boolean {
  const text = metadataText(pr);
  return AI_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isClosedWithoutMerge(pr: AiFatiguePullRequestMetadata): boolean {
  const state = pr.state.trim().toLowerCase();
  if (state === "merged") return false;
  if (parseInstant(pr.mergedAt)) return false;
  return state === "closed" || state === "rejected" || state === "declined";
}

function isTerseRejection(pr: AiFatiguePullRequestMetadata): boolean {
  const response = pr.maintainerResponse?.trim().toLowerCase();
  const reviewDecision = pr.reviewDecision?.trim().toLowerCase();
  const closeReason = pr.closeReason?.trim().toLowerCase();
  return (
    (response ? Terse_REJECTION_RESPONSES.has(response) : false) ||
    reviewDecision === "changes_requested" ||
    closeReason === "spam" ||
    closeReason === "not_planned"
  );
}

function docText(change: AiFatigueDocLanguageChange): string {
  return [change.addedText, ...(change.addedPhrases ?? [])].filter((value): value is string => Boolean(value)).join(" ");
}

function isAiDocLanguage(change: AiFatigueDocLanguageChange): boolean {
  const text = docText(change);
  if (!text.trim()) return false;
  if (!scanAiPolicyText(text, change.path === "AI-USAGE.md" ? "AI-USAGE.md" : "CONTRIBUTING.md").allowed) {
    return false;
  }
  return AI_DOC_LANGUAGE_PATTERNS.some((pattern) => pattern.test(text));
}

function evidence(kind: AiPolicyFatigueEvidenceKind, weight: number, summary: string, observedAt: string | null): AiPolicyFatigueEvidence {
  return {
    kind,
    weight: roundScore(weight),
    summary: collapseInline(summary),
    observedAt,
  };
}

function fatigueLevel(score: number, hasCluster: boolean): AiPolicyFatigueLevel {
  if (score >= 0.72 || (hasCluster && score >= 0.58)) return "defer";
  if (score >= 0.4) return "deprioritize";
  if (score >= 0.18) return "watch";
  return "none";
}

function priorityAdjustment(level: AiPolicyFatigueLevel): AiPolicyPriorityAdjustment {
  if (level === "defer") return "defer";
  if (level === "deprioritize" || level === "watch") return "deprioritize";
  return "none";
}

function recheckAfterHours(level: AiPolicyFatigueLevel): number {
  if (level === "defer") return 12;
  if (level === "deprioritize") return 24;
  if (level === "watch") return 48;
  return 168;
}

function fatigueMultiplier(level: AiPolicyFatigueLevel): number {
  if (level === "defer") return 0.05;
  if (level === "deprioritize") return 0.35;
  if (level === "watch") return 0.7;
  return 1;
}

function finiteScore(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function isCacheFresh(cache: AiPolicyFatigueCacheEntry | null | undefined, now: Date): boolean {
  const computedAt = parseInstant(cache?.computedAt);
  if (!cache || !computedAt) return false;
  return hoursBetween(computedAt, now) <= FATIGUE_CACHE_TTL_HOURS;
}

function normalizeRepoFullName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u.test(normalized)) {
    throw new Error("AI policy fatigue cache entries require a repo full name in owner/name form.");
  }
  return normalized;
}

function addHours(instant: string, hours: number): string {
  return new Date(new Date(instant).getTime() + hours * 3_600_000).toISOString();
}

function cacheVerdict(cache: AiPolicyFatigueCacheEntry, now: Date): AiPolicyFatigueVerdict {
  const computedAt = parseInstant(cache.computedAt);
  return {
    ...cache.verdict,
    evidence: [
      evidence("cache_fresh", 0, `cached fatigue verdict reused from ${computedAt ?? "unknown time"}`, computedAt),
      ...cache.verdict.evidence,
    ],
  };
}

function markdownSafe(value: string): string {
  return collapseInline(value).replace(/[\\`*_[\]<>|]/gu, "\\$&");
}

function renderEvidenceItem(item: AiPolicyFatigueEvidence): string {
  const observed = item.observedAt ? ` (${item.observedAt})` : "";
  return `- ${markdownSafe(item.kind)}: ${item.weight.toFixed(6)}${observed} - ${markdownSafe(item.summary)}`;
}

/**
 * Conservative by design (#2305): explicit ban phrases deny a repo, but ambiguous or absent policy text stays
 * allowed. False negatives can be tightened with new literal phrases; false positives would hide valid work.
 */
export function scanAiPolicyText(content: string | null | undefined, source: AiPolicySource): AiPolicyVerdict {
  const text = content ?? "";
  if (source === "none" || text.trim().length === 0) {
    return { allowed: true, matchedPhrase: null, source };
  }
  for (const ban of BAN_PHRASES) {
    if (ban.pattern.test(text)) {
      return { allowed: false, matchedPhrase: ban.phrase, source };
    }
  }
  return { allowed: true, matchedPhrase: null, source };
}

export function resolveAiPolicyVerdict(docs: {
  aiUsage: string | null | undefined;
  contributing: string | null | undefined;
}): AiPolicyVerdict {
  // An empty or whitespace-only AI-USAGE.md carries no policy and must fall through to CONTRIBUTING.md,
  // exactly as an absent (null/undefined) file does — otherwise a stub AI-USAGE.md silently fails open and
  // swallows a real ban declared in CONTRIBUTING.md (#2305).
  if (docs.aiUsage !== null && docs.aiUsage !== undefined && docs.aiUsage.trim().length > 0) {
    return scanAiPolicyText(docs.aiUsage, "AI-USAGE.md");
  }
  if (docs.contributing !== null && docs.contributing !== undefined) {
    return scanAiPolicyText(docs.contributing, "CONTRIBUTING.md");
  }
  return { ...AI_POLICY_ALLOWED };
}

export function resolveAiPolicyFatigueVerdict(input: AiPolicyFatigueInput): AiPolicyVerdict {
  const hardPolicy = resolveAiPolicyVerdict(input.docs);
  const now = requireNow(input.now);
  if (!hardPolicy.allowed) {
    return {
      ...hardPolicy,
      fatigue: {
        level: "none",
        priorityAdjustment: "none",
        score: 0,
        recheckAfterHours: 168,
        evidence: [
          evidence(
            "formal_ban_overrides",
            0,
            `formal AI policy ban from ${hardPolicy.source} remains authoritative`,
            null,
          ),
        ],
      },
    };
  }
  if (isCacheFresh(input.cache, now)) {
    return {
      ...hardPolicy,
      fatigue: cacheVerdict(input.cache!, now),
    };
  }

  const evidenceItems: AiPolicyFatigueEvidence[] = [];
  const aiAttributedClosed = (input.pullRequests ?? []).filter((pr) => isAiAttributed(pr) && isClosedWithoutMerge(pr));
  const terseRejected = aiAttributedClosed.filter(isTerseRejection);
  if (aiAttributedClosed.length > 0) {
    const newest = aiAttributedClosed
      .map((pr) => parseInstant(pr.closedAt) ?? parseInstant(pr.createdAt))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    evidenceItems.push(
      evidence(
        "ai_attributed_closed_pr",
        Math.min(0.35, 0.18 + aiAttributedClosed.length / 20),
        `${aiAttributedClosed.length} closed AI-attributed PR metadata row(s) observed`,
        newest,
      ),
    );
  }
  if (terseRejected.length >= 2) {
    const newest = terseRejected
      .map((pr) => parseInstant(pr.closedAt) ?? parseInstant(pr.createdAt))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const ratio = terseRejected.length / Math.max(1, aiAttributedClosed.length);
    evidenceItems.push(
      evidence(
        "terse_ai_attributed_rejection_cluster",
        Math.min(0.62, ratio * 0.45 + Math.min(0.17, terseRejected.length / 20)),
        `${terseRejected.length}/${aiAttributedClosed.length} AI-attributed closed PRs have terse or templated rejection metadata`,
        newest,
      ),
    );
  }

  for (const change of input.docChanges ?? []) {
    if (!isAiDocLanguage(change)) continue;
    const observedAt = parseInstant(change.changedAt);
    const weight = 0.28 * recencyWeight(observedAt, now, 30);
    evidenceItems.push(
      evidence(
        "recent_ai_doc_language",
        weight,
        `${change.path} added AI/automation language short of a formal ban phrase`,
        observedAt,
      ),
    );
  }

  const totalScore = roundScore(evidenceItems.reduce((sum, item) => sum + item.weight, 0));
  const hasCluster = evidenceItems.some((item) => item.kind === "terse_ai_attributed_rejection_cluster");
  const level = fatigueLevel(totalScore, hasCluster);
  const fatigue: AiPolicyFatigueVerdict = {
    level,
    priorityAdjustment: priorityAdjustment(level),
    score: totalScore,
    recheckAfterHours: recheckAfterHours(level),
    evidence: evidenceItems,
  };
  return {
    ...hardPolicy,
    fatigue: fatigue.evidence.length === 0 ? { ...AI_FATIGUE_NONE } : fatigue,
  };
}

export function renderAiPolicyFatigueMarkdown(verdict: AiPolicyVerdict): string {
  const fatigue = verdict.fatigue ?? AI_FATIGUE_NONE;
  const lines = [
    "# AI Policy Fatigue",
    "",
    `Hard policy allowed: ${verdict.allowed ? "yes" : "no"}`,
    `Policy source: ${markdownSafe(verdict.source)}`,
    `Fatigue level: ${fatigue.level}`,
    `Priority adjustment: ${fatigue.priorityAdjustment}`,
    `Fatigue score: ${fatigue.score.toFixed(6)}`,
    `Recheck after: ${fatigue.recheckAfterHours}h`,
    "",
    "## Evidence",
    "",
    fatigue.evidence.length === 0 ? "- none" : fatigue.evidence.map(renderEvidenceItem).join("\n"),
  ];
  return `${lines.join("\n")}\n`;
}

export function applyAiPolicyFatigueToRankInput(
  rankInput: AiPolicyFatigueRankInput,
  verdict: AiPolicyVerdict,
): AiPolicyFatigueRankAdjustment {
  const fatigue = verdict.fatigue ?? AI_FATIGUE_NONE;
  const multiplier = verdict.allowed ? fatigueMultiplier(fatigue.level) : 0;
  const reasons: string[] = [];
  if (!verdict.allowed) {
    reasons.push(`formal AI policy denial from ${verdict.source}`);
  }
  if (fatigue.priorityAdjustment !== "none") {
    reasons.push(`AI-fatigue ${fatigue.priorityAdjustment} signal (${fatigue.level})`);
  }
  for (const item of fatigue.evidence.slice(0, 3)) {
    reasons.push(item.summary);
  }
  return {
    potential: roundScore(finiteScore(rankInput.potential, 0) * multiplier),
    feasibility: finiteScore(rankInput.feasibility, 0),
    laneFit: finiteScore(rankInput.laneFit, 0),
    freshness: finiteScore(rankInput.freshness, 0),
    dupRisk: verdict.allowed ? finiteScore(rankInput.dupRisk, 1) : 1,
    fatigueLevel: fatigue.level,
    priorityAdjustment: verdict.allowed ? fatigue.priorityAdjustment : "defer",
    fatigueMultiplier: multiplier,
    deferUntilHours: verdict.allowed && fatigue.priorityAdjustment === "defer" ? fatigue.recheckAfterHours : null,
    reasons,
  };
}

export function createAiPolicyFatigueCacheEntry(input: {
  repoFullName: string;
  verdict: AiPolicyFatigueVerdict;
  computedAt?: string | Date | undefined;
}): AiPolicyFatigueCacheEntry {
  return {
    repoFullName: normalizeRepoFullName(input.repoFullName),
    computedAt: requireNow(input.computedAt).toISOString(),
    verdict: input.verdict,
  };
}

export function describeAiPolicyFatigueCache(
  cache: AiPolicyFatigueCacheEntry | null | undefined,
  now?: string | Date | undefined,
): AiPolicyFatigueCacheState {
  const computedAt = parseInstant(cache?.computedAt);
  const current = requireNow(now);
  if (!cache || !computedAt) {
    return {
      repoFullName: cache?.repoFullName ? collapseInline(cache.repoFullName).toLowerCase() : "unknown",
      computedAt: null,
      expiresAt: null,
      ageHours: null,
      fresh: false,
    };
  }
  const ageHours = roundHours(hoursBetween(computedAt, current));
  const expiresAt = addHours(computedAt, FATIGUE_CACHE_TTL_HOURS);
  return {
    repoFullName: normalizeRepoFullName(cache.repoFullName),
    computedAt,
    expiresAt,
    ageHours,
    fresh: ageHours <= FATIGUE_CACHE_TTL_HOURS,
  };
}
