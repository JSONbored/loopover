import {
  buildCollisionReport,
  buildPreflightResult,
  buildPublicReadinessScore,
  buildQueueHealth,
  unionScopedOverlapClusters,
  type IssueQualityReport,
} from "../signals/engine";
import type { FocusManifest } from "../signals/focus-manifest";
import { sanitizePublicComment } from "../github/commands";
import { GITTENSOR_HOME_URL } from "../github/footer";
import type { BountyRecord, GatePolicyPack, IssueRecord, PullRequestRecord, RepositoryRecord } from "../types";

// Opt-in funnel (#694): a non-Gittensor adopter running the `oss-anti-slop` pack learns that Gittensor pays
// contributors for OSS work like this. Public-safe "earn" wording only (never reward/payout/score).
const OSS_ANTI_SLOP_FUNNEL = {
  message: "This repo runs the Gittensor anti-slop gate. Gittensor lets GitHub contributors earn for open-source work like this — register to start earning.",
  registerUrl: GITTENSOR_HOME_URL,
} as const;
import { buildPullRequestAdvisory, evaluateGateCheck, type GateCheckConclusion } from "./advisory";

/**
 * Pre-submission "will my PR pass the gate?" prediction for a MINER, computed BEFORE a PR exists.
 *
 * Parity: it runs the EXACT same engine the maintainer PR pipeline runs — buildPullRequestAdvisory +
 * evaluateGateCheck over a synthetic PR built from the contributor's local branch metadata. The verdict a
 * miner sees pre-submission is therefore the same verdict the gate would compute post-submission.
 *
 * Boundary: the gate POLICY is sourced ONLY from the repo's PUBLIC `.gittensory.yml` (`manifest.gate`) +
 * safe defaults — never the maintainer's private dashboard/DB settings. The `.gittensory.yml` is in the
 * repo and publicly viewable, so this leaks nothing a contributor could not already read. The result is
 * explicitly labelled "predicted" and notes that private overrides and AI-consensus blockers are not
 * evaluated pre-submission.
 */
export type PredictedGateVerdict = {
  predicted: true;
  basis: "public_config";
  /** Which policy pack the repo's public config selects (#692/#693). Under `oss-anti-slop` the predicted
   *  verdict applies to ANY author (no confirmed-contributor gate) — so an agent on a non-Gittensor repo
   *  gets a meaningful "will this pass?" answer with no Gittensor account. */
  pack: GatePolicyPack;
  conclusion: GateCheckConclusion;
  title: string;
  summary: string;
  readinessScore: number | null;
  confirmedContributor: boolean | undefined;
  blockers: Array<{ code: string; title: string; detail: string; action?: string | undefined }>;
  warnings: Array<{ code: string; title: string; detail: string; action?: string | undefined }>;
  /** Opt-in conversion funnel (#694): present only under the `oss-anti-slop` pack — a non-Gittensor
   *  adopter's path to "earn on Gittensor". `null` under `gittensor` (the contributor is already there). */
  funnel: { message: string; registerUrl: string } | null;
  note: string;
};

const PREDICTED_GATE_NOTE =
  "Predicted from the repo's public .gittensory.yml gate config + safe defaults. The maintainer may have " +
  "private dashboard overrides not reflected here, and the dual-model AI-consensus blocker is only " +
  "evaluated on a real PR. Only confirmed Gittensor contributors are ever hard-blocked.";

export type PredictedGateInput = {
  repoFullName: string;
  contributorLogin: string;
  title: string;
  body?: string | undefined;
  labels?: string[] | undefined;
  linkedIssues?: number[] | undefined;
  authorAssociation?: string | undefined;
};

function publicSafeFinding(finding: { code: string; title: string; detail: string; action?: string | undefined }) {
  return {
    code: finding.code,
    title: sanitizePublicComment(finding.title),
    detail: sanitizePublicComment(finding.detail),
    action: finding.action ? sanitizePublicComment(finding.action) : undefined,
  };
}

export function buildPredictedGateVerdict(args: {
  input: PredictedGateInput;
  manifest: FocusManifest;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  bounties?: BountyRecord[] | undefined;
  issueQuality?: IssueQualityReport | null | undefined;
  /** The contributor's OWN confirmed-Gittensor status (self-data). `false` → the real gate would stay
   *  neutral for them; `undefined` → not gated on contributor status. */
  confirmedContributor?: boolean | undefined;
}): PredictedGateVerdict {
  const { input, manifest, repo, issues, pullRequests } = args;
  const gate = manifest.gate;

  // A synthetic open PR from the local branch metadata — fed to the SAME advisory builder as a real PR.
  const syntheticPr: PullRequestRecord = {
    repoFullName: input.repoFullName,
    number: 0,
    title: input.title,
    state: "open",
    authorLogin: input.contributorLogin,
    authorAssociation: input.authorAssociation ?? null,
    body: input.body ?? null,
    labels: input.labels ?? [],
    linkedIssues: input.linkedIssues ?? [],
  };

  const preflight = buildPreflightResult(
    {
      repoFullName: input.repoFullName,
      contributorLogin: input.contributorLogin,
      title: input.title,
      body: input.body,
      labels: input.labels,
      linkedIssues: input.linkedIssues,
      authorAssociation: input.authorAssociation,
    },
    repo,
    issues,
    pullRequests,
    args.bounties ?? [],
    args.issueQuality,
  );
  const collisions = buildCollisionReport(input.repoFullName, issues, pullRequests);
  const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
  const readiness = buildPublicReadinessScore({
    pr: syntheticPr,
    preflight,
    queueHealth,
    scopedOverlapCount: unionScopedOverlapClusters(collisions, syntheticPr, preflight.collisions).length,
  });

  // Linked-issue finding is surfaced when the repo's public policy treats it as anything but `off`, so the
  // gate can evaluate it; evaluateGateCheck decides whether it actually blocks (block) or stays advisory.
  const requireLinkedIssue = gate.linkedIssue !== null && gate.linkedIssue !== "off";
  const advisory = buildPullRequestAdvisory(repo, syntheticPr, { otherOpenPullRequests: pullRequests, requireLinkedIssue });

  // Pack-aware (#693): under `oss-anti-slop` the gate blocks ANY author, so drop the confirmed-contributor
  // gate entirely (mirrors gateCheckPolicy). `gittensor` keeps it. Pack comes from the PUBLIC .gittensory.yml.
  const pack: GatePolicyPack = gate.pack ?? "gittensor";
  const effectiveConfirmedContributor = pack === "oss-anti-slop" ? undefined : args.confirmedContributor;

  const evaluation = evaluateGateCheck(advisory, {
    linkedIssueGateMode: gate.linkedIssue ?? undefined,
    duplicatePrGateMode: gate.duplicates ?? undefined,
    qualityGateMode: gate.readinessMode ?? undefined,
    qualityGateMinScore: gate.readinessMinScore ?? null,
    aiReviewGateMode: gate.aiReviewMode ?? undefined,
    readinessScore: readiness.total,
    confirmedContributor: effectiveConfirmedContributor,
  });

  return {
    predicted: true,
    basis: "public_config",
    pack,
    conclusion: evaluation.conclusion,
    title: sanitizePublicComment(evaluation.title),
    summary: sanitizePublicComment(evaluation.summary),
    readinessScore: readiness.total,
    confirmedContributor: effectiveConfirmedContributor,
    blockers: evaluation.blockers.map(publicSafeFinding),
    warnings: evaluation.warnings.map(publicSafeFinding),
    funnel: pack === "oss-anti-slop" ? { ...OSS_ANTI_SLOP_FUNNEL } : null,
    note: PREDICTED_GATE_NOTE,
  };
}
