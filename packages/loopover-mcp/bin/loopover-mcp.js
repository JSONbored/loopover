#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildFeasibilityVerdict, buildPrTextLint } from "@loopover/engine";
// #6149: the miner write-tools are PURE local-execution spec builders (loopover never performs the write);
// registering them locally is just importing the same engine builders the remote server uses.
import {
  buildApplyLabelsSpec,
  buildClosePrSpec,
  buildCreateBranchSpec,
  buildDeleteBranchSpec,
  buildFileIssueSpec,
  buildFollowUpIssueSpec,
  buildOpenPrSpec,
  buildPostEligibilityCommentSpec,
  buildTestGenSpec,
  // #6269: the same manifest-validation builder the remote server uses, so `loopover_validate_config`
  // can validate a `.loopover.yml` in-process instead of round-tripping to the API.
  buildFocusManifestValidation,
  // #6150: the same deterministic token-score computation the remote server's loopover_run_local_scorer
  // wraps, so it works fully offline here too.
  computeLocalScorerTokens,
} from "@loopover/engine";
import { buildSlopAssessment, SLOP_RUBRIC_MARKDOWN } from "@loopover/engine/signals/slop";
// #6749: the same pure builder the remote MCP tool + /v1/lint/test-evidence both call.
import { buildTestEvidenceReport } from "@loopover/engine/signals/test-evidence";
// #6754: the same pure evaluator the remote MCP tool + /v1/loop/evaluate-escalation both call.
import { evaluateEscalation } from "@loopover/engine";
// #6752: the same pure composer the remote MCP tool + /v1/loop/results-payload both call.
import { buildResultsPayload } from "@loopover/engine";
// #6753: the same pure composer the remote MCP tool + /v1/loop/progress-snapshot both call.
import { buildProgressSnapshot } from "@loopover/engine";
// #6755: the same pure bridge the remote MCP tool + /v1/loop/intake-idea both call.
import { validateIdeaSubmission, buildTaskGraph, buildClaimPlan } from "@loopover/engine";
import { z } from "zod";
import { buildBranchAnalysisPayload, collectLocalDiff, collectLocalBranchMetadata, probeLocalScorer, referenceScorePreviewExample, resolveScorePreviewCommand, resolveWorkspaceCwd, sanitizeLocalScorerStatus, setupGuidanceForLocalScorer, isTestFile } from "../lib/local-branch.js";
import { formatTable } from "../lib/format-table.js";
import { argsWantJson, describeCliError, reportCliFailure } from "../lib/cli-error.js";
import { redactKnownLocalPaths, redactLocalPath } from "../lib/redact-local-path.js";
// Aliased: this file's own recordStdioToolTelemetry is the chokepoint that calls it, and the two names sitting
// side by side unaliased would read as the same function (#6238).
import { recordMcpToolCall as recordLocalMcpToolCall } from "../lib/telemetry.js";

// Read name/version from this package's own package.json (always present in any install --
// global, npx, or local -- npm ships it regardless of the "files" allowlist) instead of hand-synced
// literals, so a release bump never has a second place to forget.
const ownPackageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const defaultApiUrl = "https://api.loopover.ai";
const legacyDefaultApiUrls = new Set([
  "https://gittensory-api.zeronode.workers.dev",
  "https://gittensory-api.aethereal.dev",
]);
const packageName = ownPackageJson.name;
const packageVersion = ownPackageJson.version;
const npmRegistryUrl = (process.env.LOOPOVER_NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/+$/, "");
const upgradeCommand = `npm install -g ${packageName}@latest`;
const npxFallbackCommand = `npx ${packageName}@latest <command>`;
const compatibilityPath = "/v1/mcp/compatibility";
const findingTaxonomyPath = "/v1/mcp/finding-taxonomy";
const enrichmentAnalyzersPath = "/v1/mcp/enrichment-analyzers";
const currentApiVersion = "0.1.0";
const decisionPackCacheSchemaVersion = 1;
const decisionPackCacheMaxEntries = 25;
const decisionPackCacheMaxBytes = 512 * 1024;
const cliTextFileMaxBytes = 1024 * 1024;
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const cliArgs = process.argv.slice(2);
const defaultProfileName = "default";
// Single source of truth for shell-completion: top-level command -> its subcommands (if any).
const CLI_COMMAND_SPEC = {
  login: [],
  logout: [],
  whoami: [],
  config: [],
  status: [],
  changelog: [],
  completion: [],
  version: [],
  tools: ["search"],
  doctor: [],
  telemetry: ["enable", "disable", "status"],
  "init-client": [],
  "decision-pack": [],
  "repo-decision": [],
  "monitor-open-prs": [],
  "analyze-branch": [],
  preflight: [],
  "review-pr": [],
  "lint-pr-text": [],
  "validate-config": [],
  "slop-risk": [],
  "issue-slop": [],
  profile: ["list", "create", "switch", "remove"],
  cache: ["status", "clear", "list"],
  agent: ["plan", "status", "explain", "packet"],
  maintain: ["status", "queue", "approve", "reject", "pause", "resume", "set-level", "precision", "onboarding-pack", "audit-feed"],
};
const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"];
const AGENT_PROFILE_IDS = ["miner-planner", "miner-auto-dev", "maintainer-triage", "repo-owner-intake"];
// #784 maintain set-level — the autonomy dial's action classes + levels.
//
// Both are hand-synced literals, not imports: this file resolves @loopover/engine through the PUBLISHED package
// (`^3.0.0`), whose export map exposes only `.` + a few `./scoring/*`/`./signals/*` subpaths — neither surfaces
// AUTONOMY_LEVELS, so importing the canonical list would mean widening the engine's public API (#6153). The
// drift this invites is real and has bitten once already, so test/unit/mcp-cli-maintain.test.ts pins LEVELS
// against the live enum and fails the moment the two disagree.
//
// LEVELS mirrors AUTONOMY_LEVELS (src/settings/autonomy.ts -> packages/loopover-engine/src/settings/autonomy.ts)
// exactly. #6153: it carried "suggest"/"propose" for the whole life of #4620, which dropped them server-side --
// PUT /settings validates against the live enum (src/api/routes.ts), so every value this list accepted but the
// server didn't turned an immediate, clear client-side error into a confusing 400 from the API.
//
// ACTION_CLASSES is deliberately NOT the engine's full AGENT_ACTION_CLASSES: it is the operator-settable subset
// the maintain surface exposes, and src/mcp/server.ts's MAINTAIN_AUTONOMY_ACTION_CLASSES mirrors these six on
// purpose. Do not "sync" it to the engine list.
const MAINTAIN_ACTION_CLASSES = ["review", "request_changes", "approve", "merge", "close", "label"];
const MAINTAIN_AUTONOMY_LEVELS = ["observe", "auto_with_approval", "auto"];

// #6150 — plan-DAG step tracking for loopover_build_plan/loopover_plan_status/loopover_record_step_result.
// Hand-duplicated from src/services/plan-dag.ts (packages/loopover-engine/src/services/plan-dag.ts is NOT
// where it lives -- this module was never extracted to @loopover/engine, so there is nothing to import from
// the published package's export map), same rationale as MAINTAIN_ACTION_CLASSES/AUTONOMY_LEVELS above: this
// file resolves @loopover/engine through the published package, whose export map does not surface it.
// PURE + stateless (no DB, no repo/network access) -- the harness performs each step's real work and calls
// loopover_record_step_result to report it back; this only advances the in-memory state machine the caller
// passes in and gets back on every call.
const DEFAULT_PLAN_MAX_ATTEMPTS = 1;

function buildPlanDag(steps) {
  return {
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      ...(step.actionClass !== undefined ? { actionClass: step.actionClass } : {}),
      dependsOn: [...new Set((step.dependsOn ?? []).filter((dep) => dep !== step.id))],
      status: "pending",
      attempts: 0,
      maxAttempts: Math.min(10, Math.max(1, Math.trunc(step.maxAttempts ?? DEFAULT_PLAN_MAX_ATTEMPTS))),
    })),
  };
}

function validatePlanDag(plan) {
  const errors = [];
  const ids = plan.steps.map((step) => step.id);
  const idSet = new Set(ids);
  if (idSet.size !== ids.length) errors.push("duplicate step ids");
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!idSet.has(dep)) errors.push(`step ${step.id} depends on unknown step ${dep}`);
    }
  }
  const color = new Map();
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  const hasCycle = (id) => {
    color.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const depColor = color.get(dep) ?? 0;
      if (depColor === 1) return true;
      if (depColor === 0 && byId.has(dep) && hasCycle(dep)) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const step of plan.steps) {
    if ((color.get(step.id) ?? 0) === 0 && hasCycle(step.id)) {
      errors.push("plan has a dependency cycle");
      break;
    }
  }
  return { valid: errors.length === 0, errors };
}

const isPlanStepDone = (status) => status === "completed" || status === "skipped";

function nextReadySteps(plan) {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  return plan.steps.filter((step) => step.status === "pending" && step.dependsOn.every((dep) => isPlanStepDone(statusById.get(dep) ?? "pending")));
}

function mapPlanStep(plan, stepId, update) {
  return { steps: plan.steps.map((step) => (step.id === stepId ? update(step) : step)) };
}

function applyStepResult(plan, stepId, result) {
  return mapPlanStep(plan, stepId, (step) => {
    if (isPlanStepDone(step.status) || step.status === "failed") return step;
    if (result.outcome === "completed") return { ...step, status: "completed", lastError: null };
    if (result.outcome === "skipped") return { ...step, status: "skipped", lastError: null };
    const attempts = step.attempts + 1;
    const exhausted = attempts >= step.maxAttempts;
    return { ...step, attempts, status: exhausted ? "failed" : "pending", lastError: result.error ?? "step failed" };
  });
}

function planProgress(plan) {
  const count = (status) => plan.steps.filter((step) => step.status === status).length;
  const completed = count("completed");
  const skipped = count("skipped");
  const failed = count("failed");
  const running = count("running");
  const pending = count("pending");
  const total = plan.steps.length;
  let status;
  if (total > 0 && completed + skipped === total) status = "completed";
  else if (failed > 0) status = "failed";
  else if (running > 0) status = "running";
  else if (pending > 0 && nextReadySteps(plan).length === 0) status = "blocked";
  else status = "pending";
  return { total, completed, failed, running, pending, skipped, status };
}

function planView(plan) {
  return {
    plan,
    progress: planProgress(plan),
    readySteps: nextReadySteps(plan).map((step) => ({ id: step.id, title: step.title })),
    validation: validatePlanDag(plan),
  };
}
const AGENT_PROFILES = {
  "miner-planner": {
    id: "miner-planner",
    title: "Miner planner",
    audience: "contributors choosing and preparing Gittensor OSS work",
    purpose: "Plan cleanup-first work, run branch preflight, explain blockers, and prepare public-safe PR packets.",
    recommendedPrompts: ["loopover_miner_select_issue", "loopover_miner_branch_preflight", "loopover_miner_cleanup_first", "loopover_miner_draft_pr_packet"],
    recommendedTools: ["loopover_agent_plan_next_work", "loopover_preflight_current_branch", "loopover_agent_prepare_pr_packet"],
    boundaries: [
      "Human-approved only: plan, explain, draft, and prepare packets; do not open PRs, post comments, label, close, merge, or publish public GitHub output.",
      "Use public-safe summaries for copyable text and keep authenticated decision-pack context out of public GitHub text.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile to chase compensation, predict public scores, or automate submissions without maintainer review.",
  },
  "miner-auto-dev": {
    id: "miner-auto-dev",
    title: "Miner auto-dev",
    audience: "miners running a local harness (Claude Code/Codex/Cursor) for reward-aware, gate-throttled OSS auto-development",
    purpose:
      "Drive a plan→implement→push loop: pick reward-optimal work, plan it as a step DAG, let YOUR harness implement it locally, and push via local write-tools — always behind the LoopOver gate and the anti-slop throttle.",
    recommendedPrompts: ["loopover_miner_select_issue", "loopover_miner_cleanup_first", "loopover_miner_draft_pr_packet"],
    recommendedTools: [
      "loopover_agent_plan_next_work",
      "loopover_run_local_scorer",
      "loopover_build_plan",
      "loopover_plan_status",
      "loopover_record_step_result",
      "loopover_preflight_current_branch",
      "loopover_preview_local_pr_score",
      "loopover_check_slop_risk",
      "loopover_predict_gate",
      "loopover_agent_prepare_pr_packet",
      "loopover_create_branch",
      "loopover_open_pr",
      "loopover_file_issue",
      "loopover_apply_labels",
      "loopover_post_eligibility_comment",
      "loopover_delete_branch",
    ],
    drivingLoop: [
      "Select: pull plan-next-work to pick the highest reward-optimal action. Respect your open-PR budget, credibility floor, and time-decay — skip work that would exceed your open-PR gate or chase low-credibility submissions.",
      "Plan: build a step DAG (loopover_build_plan) for the chosen work and advance it with loopover_record_step_result as each step completes; loopover_plan_status gives the next ready steps and lets you resume.",
      "Implement: for a code step, run loopover_create_branch, let YOUR harness write the change locally, then run your validation suite.",
      "Gate-check: run loopover_run_local_scorer + loopover_check_slop_risk + loopover_preflight_current_branch (and loopover_predict_gate) to confirm the change is substantive, slop-free, and gate-ready. If it trips slop or fails preflight, fix it locally or skip the step — never push it.",
      "Push: only once the gate is satisfied, call the local write-tools (open_pr / file_issue / apply_labels / post_eligibility_comment) and run the returned command with YOUR own credentials. LoopOver supplies the content and the gate; it never performs the write and never sees your source.",
    ],
    boundaries: [
      "Reward-aware throttle: respect the open-PR gate, your credibility floor, and time-decay — never push work that fails preflight, trips the anti-slop check, or exceeds your open-PR budget.",
      "Local execution: every GitHub write is run by YOUR harness with YOUR credentials via a write-tool's returned command. LoopOver supplies content + gates only; it never performs the write and never receives your source contents.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or upload local source contents.",
    ],
    whenNotToUse: "Do not use this profile to bypass the gate, mass-open PRs, farm low-credibility submissions, or push changes that fail preflight or trip the anti-slop check.",
  },
  "maintainer-triage": {
    id: "maintainer-triage",
    title: "Maintainer queue triage",
    audience: "maintainers preparing low-noise queue and PR review context",
    purpose: "Summarize queue risk, prepare review notes, and draft public guidance for human review.",
    recommendedPrompts: ["loopover_maintainer_queue_triage", "loopover_maintainer_review_prep", "loopover_maintainer_public_guidance"],
    recommendedTools: ["loopover_get_repo_context", "loopover_get_burden_forecast", "loopover_preflight_pr", "loopover_get_skipped_pr_audit"],
    boundaries: [
      "Human-approved only: prepare summaries and draft guidance; do not post comments, label, close, merge, or edit contributor work.",
      "Keep private review context, raw trust context, and authenticated-only evidence out of public snippets.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile as an autonomous maintainer bot or for public ranking, public scoring, or compensation claims.",
  },
  "repo-owner-intake": {
    id: "repo-owner-intake",
    title: "Repo-owner intake",
    audience: "repository owners preparing intake readiness and onboarding plans",
    purpose: "Review registration readiness, focus manifests, docs/onboarding gaps, and manual setup actions.",
    recommendedPrompts: ["loopover_repo_owner_intake_readiness", "loopover_repo_owner_focus_manifest_review", "loopover_repo_owner_onboarding_pack"],
    recommendedTools: ["loopover_get_repo_context", "loopover_get_issue_quality", "loopover_get_registration_readiness", "loopover_get_config_recommendation"],
    boundaries: [
      "Human-approved only: review, explain, and draft setup plans; do not push config, label issues, post comments, close issues, or publish public output.",
      "Separate public readiness guidance from private maintainer or authenticated owner context.",
      "Do not request wallets, hotkeys, coldkeys, private keys, GitHub tokens, or local source contents.",
    ],
    whenNotToUse: "Do not use this profile to bypass owner approval, auto-register repositories, or publish policy changes automatically.",
  },
};
const configPath =
  process.env.LOOPOVER_CONFIG_PATH ??
  (process.env.LOOPOVER_CONFIG_DIR
    ? join(process.env.LOOPOVER_CONFIG_DIR, "config.json")
    : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "loopover", "config.json"));
const cacheDir = process.env.LOOPOVER_CACHE_DIR ?? join(dirname(configPath), "cache");
const decisionPackCacheDir = join(cacheDir, "decision-packs");
const config = loadConfig();
const requestedProfileName = cliOptionValue(cliArgs, "profile") ?? process.env.LOOPOVER_PROFILE;
const activeProfileName = selectProfileName(config, requestedProfileName);
const activeProfile = config.profiles?.[activeProfileName] ?? {};
const configuredApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
const apiUrl = (process.env.LOOPOVER_API_URL ?? (configuredApiUrl && !legacyDefaultApiUrls.has(configuredApiUrl) ? configuredApiUrl : defaultApiUrl)).replace(/\/+$/, "");

const ownerRepoShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const skippedPrAuditShape = {
  repoFullName: z.string().trim().min(1).max(200).optional(),
  reason: z.string().trim().min(1).max(64).optional(),
  since: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().positive().optional(),
};

const ownerRepoPullShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
};

// #6736: the remote loopover_get_bounty_advisory tool's input shape (src/mcp/server.ts's bountyShape) --
// a single cached-bounty id, GET /v1/bounties/:id/advisory.
const bountyAdvisoryShape = {
  id: z.string().min(1),
};

// #6619: same PR coordinates plus the OPTIONAL author login. Omitted, it resolves from the local session /
// LOOPOVER_LOGIN / GITHUB_LOGIN, so an already-logged-in contributor never has to retype their own login.
const prAiReviewFindingsShape = {
  ...ownerRepoPullShape,
  login: z.string().min(1).optional(),
};

// #6149 write-tool input shapes -- mirror src/mcp/server.ts's remote shapes (same bounds) so the local
// server validates identically. The builders (buildOpenPrSpec, ...) are the same @loopover/engine functions.
const WRITE_TOOL_REPO_FULL_NAME_MAX = 200;
const WRITE_TOOL_BRANCH_REF_MAX = 200;
const WRITE_TOOL_TITLE_MAX = 400;
const WRITE_TOOL_BODY_MAX = 60000;
const WRITE_TOOL_BRANCH_MAX = 255;
// Mirrors @loopover/engine/signals/test-evidence's TEST_FRAMEWORKS (the detectTestConvention framework set),
// so a caller cannot request a test-gen spec for a framework the detector could never produce -- same guard the
// remote server's testGenShape uses.
const TEST_FRAMEWORKS = ["vitest", "jest", "pytest", "go-test", "rspec", "cargo-test"];
const writeToolRepoFullName = z.string().min(3).max(WRITE_TOOL_REPO_FULL_NAME_MAX);
const openPrShape = {
  repoFullName: writeToolRepoFullName,
  base: z.string().min(1).max(WRITE_TOOL_BRANCH_REF_MAX),
  head: z.string().min(1).max(WRITE_TOOL_BRANCH_REF_MAX),
  title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
  body: z.string().max(WRITE_TOOL_BODY_MAX),
  draft: z.boolean().optional(),
};
const fileIssueShape = {
  repoFullName: writeToolRepoFullName,
  title: z.string().min(1).max(WRITE_TOOL_TITLE_MAX),
  body: z.string().max(WRITE_TOOL_BODY_MAX),
  labels: z.array(z.string().min(1).max(100)).max(20).optional(),
};
const applyLabelsShape = {
  repoFullName: writeToolRepoFullName,
  number: z.number().int().positive(),
  labels: z.array(z.string().min(1).max(100)).min(1).max(20),
};
const closePrShape = {
  repoFullName: writeToolRepoFullName,
  number: z.number().int().positive(),
  comment: z.string().max(WRITE_TOOL_BODY_MAX).optional(),
};
const postEligibilityCommentShape = {
  repoFullName: writeToolRepoFullName,
  number: z.number().int().positive(),
  body: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
};
const createBranchShape = {
  branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX),
  base: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX).optional(),
};
const deleteBranchShape = {
  branch: z.string().min(1).max(WRITE_TOOL_BRANCH_MAX),
  remote: z.boolean().optional(),
};
const testGenShape = {
  repoFullName: writeToolRepoFullName,
  targetFiles: z.array(z.string().min(1).max(500)).min(1).max(50),
  framework: z.enum(TEST_FRAMEWORKS),
  testDir: z.string().min(1).max(255).optional(),
  criteria: z.array(z.string().min(1).max(300)).max(20).optional(),
};
const followUpIssueShape = {
  repoFullName: writeToolRepoFullName,
  path: z.string().min(1).max(500),
  line: z.number().int().positive().optional(),
  finding: z.string().min(1).max(WRITE_TOOL_BODY_MAX),
  label: z.string().min(1).max(100).optional(),
};

const loginShape = {
  login: z.string().min(1),
};

const loginRepoShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const validateLinkedIssueShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive(),
  plannedChange: z
    .object({
      title: z.string().min(1).optional(),
      changedFiles: z.array(z.string()).optional(),
      contributorLogin: z.string().min(1).optional(),
    })
    .optional(),
};

const checkBeforeStartShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  issueNumber: z.number().int().positive().optional(),
  title: z.string().min(1).optional(),
  plannedPaths: z.array(z.string()).optional(),
};

const feasibilityGateShape = {
  claimStatus: z.enum(["unclaimed", "claimed", "solved", "unknown"]),
  duplicateClusterRisk: z.enum(["none", "low", "medium", "high"]),
  issueStatus: z.enum(["ready", "needs_proof", "hold", "do_not_use", "duplicate", "invalid", "missing"]),
  found: z.boolean().optional(),
  // Optional: when both are supplied AND a local loopover-miner install's claim ledger is present (#5157), claimStatus is
  // read from that ledger instead of trusting this caller-supplied value. Omitting either falls back to
  // today's caller-supplied-string behavior unchanged.
  repoFullName: z.string().min(1).optional(),
  issueNumber: z.number().int().positive().optional(),
};

/**
 * Read-only lookup of the caller's own claim status from a local loopover-miner install's claim ledger
 * (#5157), so `loopover_feasibility_gate` isn't purely trusting a caller-supplied `claimStatus` string.
 * Returns `null` (fall back to the caller-supplied value unchanged) only when there is genuinely nothing to
 * look up: no repo/issue supplied, no local install detected (the ledger DB file doesn't exist -- checked
 * via `existsSync` BEFORE opening anything), or the sibling `@loopover/miner` package isn't
 * resolvable at all (a standalone loopover-mcp install with no miner alongside it). When the ledger DB
 * file DOES exist (a real local install IS present) but reading it fails -- corrupt, locked, permission
 * denied -- this returns `"unknown"` rather than silently falling back to a caller-supplied string that
 * ground-truth data (which we know exists but can't currently read) might contradict; `"unknown"` is an
 * existing, honest claimStatus value the calculator already understands, not a guess.
 *
 * Uses `openClaimLedgerReadOnly` (not `openClaimLedger`), which opens the DB file in SQLite's own `readonly`
 * mode -- a DRIVER-ENFORCED guarantee, not just a by-convention one. `openClaimLedger` always runs
 * `CREATE TABLE IF NOT EXISTS` plus a schema-version stamp on open, which IS a write even against a file
 * that merely exists but is empty/uninitialized; this tool never calls that, `recordClaim`,
 * `releaseClaim`, or `expireClaim` -- it never gains any ability to block, cancel, or override a claim or
 * attempt; real claim-conflict authority stays entirely with #4848's maintainer-only path.
 */
async function resolveLedgerClaimStatus(repoFullName, issueNumber) {
  if (!repoFullName || !issueNumber) return null;
  let claimLedgerModule;
  try {
    claimLedgerModule = await import("@loopover/miner/lib/claim-ledger.js");
  } catch {
    /* v8 ignore next -- loopover-miner genuinely unresolvable (not installed alongside loopover-mcp); not
       reproducible in this monorepo's workspace-hoisted test environment, where the sibling package always
       resolves */
    return null;
  }
  const { resolveClaimLedgerDbPath, openClaimLedgerReadOnly } = claimLedgerModule;
  const dbPath = resolveClaimLedgerDbPath();
  if (!existsSync(dbPath)) return null;
  try {
    const ledger = openClaimLedgerReadOnly(dbPath);
    try {
      const activeClaims = ledger.listActiveClaims(repoFullName);
      return activeClaims.some((claim) => claim.issueNumber === issueNumber) ? "claimed" : "unclaimed";
    } finally {
      ledger.close();
    }
  } catch {
    // The ledger DB file exists (a real local install IS present) but reading it failed -- corrupt, locked,
    // a permission error, or not actually a claim-ledger database. Never silently trust a caller-supplied
    // string that could contradict ground truth we know exists but can't currently read; "unknown" surfaces
    // that honestly instead of guessing.
    return "unknown";
  }
}

const findOpportunitiesShape = {
  targets: z
    .array(
      z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
      }),
    )
    .optional(),
  searchQuery: z.string().min(1).max(500).optional(),
  goalSpec: z
    .object({
      lane: z.string().min(1).optional(),
      minRankScore: z.number().min(0).max(100).optional(),
      languages: z.array(z.string()).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(50).optional(),
};

const issueRagShape = {
  owner: z.string(),
  repo: z.string(),
  title: z.string(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  topK: z.number().int().min(1).max(12).optional(),
};

const lintPrTextShape = {
  commitMessages: z.array(z.string()).max(50).optional(),
  prBody: z.string().optional(),
  linkedIssue: z.number().int().positive().optional(),
};

const validateConfigShape = {
  content: z.string().max(256 * 1024),
  source: z.enum(["repo_file", "api_record", "none"]).optional(),
};

// #6754: mirrors evaluateEscalationShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const evaluateEscalationShape = {
  runStatus: z.enum(["running", "converged", "abandoned", "error"]),
  healthStatus: z.enum(["healthy", "degraded", "critical"]).optional(),
  customerFlagged: z.boolean().optional(),
  killRequested: z.boolean().optional(),
};

// #6755: mirrors intakeIdeaShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and the REST
// route all accept an identical payload. Deliberately loose -- validateIdeaSubmission owns the real checks.
const intakeIdeaShape = {
  id: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  targetRepo: z.string().optional(),
  constraints: z.array(z.string()).max(50).optional(),
  acceptanceHints: z.array(z.string()).max(50).optional(),
  priority: z.string().optional(),
  decomposition: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string(), dependsOn: z.array(z.string()).max(50).optional() }))
    .max(50)
    .optional(),
};

// #6752: mirrors buildResultsPayloadShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const resultsPayloadShape = {
  repoFullName: z.string().min(1),
  prNumber: z.number().int().nullable().optional(),
  title: z.string(),
  changedFiles: z
    .array(z.object({ path: z.string(), additions: z.number().int().optional(), deletions: z.number().int().optional() }))
    .max(5000)
    .optional(),
  status: z.enum(["open", "merged", "closed"]).optional(),
};

// #6753: mirrors buildProgressSnapshotShape in src/mcp/server.ts exactly, so the local tool, the remote tool, and
// the REST route all accept an identical payload.
const buildProgressSnapshotShape = {
  iteration: z.number().int(),
  maxIterations: z.number().int().nullable().optional(),
  phase: z.enum(["queued", "claiming", "coding", "reviewing", "submitting", "done"]),
  status: z.enum(["running", "converged", "abandoned", "error"]),
  recentActivity: z
    .array(z.object({ step: z.string(), detail: z.string().optional(), at: z.string().optional() }))
    .max(1000)
    .optional(),
};

// #6749: mirrors checkTestEvidenceShape in src/mcp/server.ts VERBATIM (same bounds, same optionality).
const checkTestEvidenceShape = {
  changedPaths: z.array(z.string().min(1).max(400)).max(2000),
  testFiles: z.array(z.string().min(1).max(400)).max(2000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
};

// #6750: mirrors suggestBoundaryTestsShape in src/mcp/server.ts VERBATIM.
const suggestBoundaryTestsShape = {
  changedFiles: z.array(z.object({ path: z.string().min(1).max(400) }).strict()).max(500),
  boundaryTouches: z
    .array(z.object({ path: z.string().min(1).max(400), kind: z.enum(["array_index_bounds", "null_or_undefined_branch", "empty_collection_check"]) }).strict())
    .max(20)
    .optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
};

// #6751: mirrors simulateOpenPrPressureShape in src/mcp/server.ts VERBATIM. The bin cannot import from src/
// (package boundary), so this copy is the one place parity is by convention rather than construction — the
// route parses with the tool's own exported shape, and mcp-cli-open-pr-pressure-tool.test.ts pins that a
// payload this shape accepts is one the route accepts too.
const simulateOpenPrPressureCount = z.number().int().min(0).max(1000000);
const simulateOpenPrPressureShape = {
  repoFullName: z.string().min(3).max(200),
  generatedAt: z.string().min(1).max(100),
  queueHealth: z
    .object({
      repoFullName: z.string().min(3).max(200),
      generatedAt: z.string().min(1).max(100),
      burdenScore: z.number().finite(),
      level: z.enum(["low", "medium", "high", "critical"]),
      summary: z.string().max(1000),
      signals: z
        .object({
          openIssues: simulateOpenPrPressureCount,
          openPullRequests: simulateOpenPrPressureCount,
          unlinkedPullRequests: simulateOpenPrPressureCount,
          stalePullRequests: simulateOpenPrPressureCount,
          draftPullRequests: simulateOpenPrPressureCount,
          maintainerAuthoredPullRequests: simulateOpenPrPressureCount,
          collisionClusters: simulateOpenPrPressureCount,
          ageBuckets: z
            .object({ under7Days: simulateOpenPrPressureCount, days7To30: simulateOpenPrPressureCount, over30Days: simulateOpenPrPressureCount })
            .passthrough(),
          likelyReviewablePullRequests: simulateOpenPrPressureCount,
          cachedOpenPullRequests: simulateOpenPrPressureCount.optional(),
          likelyReviewablePullRequestsSource: z.enum(["cache", "sampled_cache", "authoritative"]).optional(),
        })
        .passthrough(),
      findings: z.array(z.unknown()).max(100),
    })
    .passthrough()
    .nullable(),
  roleContext: z.object({ maintainerLane: z.boolean() }).passthrough(),
  contributorOpenPrCount: simulateOpenPrPressureCount.optional(),
};

const checkSlopRiskShape = {
  changedFiles: z
    .array(z.object({ path: z.string().min(1).max(400), additions: z.number().int().min(0).optional(), deletions: z.number().int().min(0).optional() }))
    .max(2000)
    .optional(),
  description: z.string().max(20000).optional(),
  tests: z.array(z.string().max(400)).max(2000).optional(),
  testFiles: z.array(z.string().max(400)).max(2000).optional(),
};

const checkIssueSlopShape = {
  title: z.string().max(500).optional(),
  body: z.string().max(40000).optional(),
};

// #6150 — loopover_run_local_scorer's input, mirroring the remote server's changedFileSchema/validationEntrySchema.
const localScorerChangedFileShape = z
  .object({
    path: z.string().min(1).max(400),
    previousPath: z.string().min(1).max(400).optional(),
    additions: z.number().int().min(0).optional(),
    deletions: z.number().int().min(0).optional(),
    status: z.enum(["added", "modified", "deleted", "renamed", "copied", "unknown"]).optional(),
    binary: z.boolean().optional(),
  })
  .strict();
const localScorerValidationShape = z
  .object({
    command: z.string().min(1).max(400),
    status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
    summary: z.string().max(2000).optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().min(0).optional(),
  })
  .strict();
const runLocalScorerShape = {
  changedFiles: z.array(localScorerChangedFileShape).min(1).max(500),
  validation: z.array(localScorerValidationShape).max(50).optional(),
};

// #6150 — loopover_build_plan/loopover_plan_status/loopover_record_step_result's input, mirroring the remote
// server's rawPlanStepSchema/planStepSchema/planDagSchema (src/mcp/server.ts).
const rawPlanStepShape = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50).optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
  })
  .strict();
const planStepShape = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(300),
    actionClass: z.string().min(1).max(60).optional(),
    dependsOn: z.array(z.string().min(1).max(100)).max(50),
    status: z.enum(["pending", "running", "completed", "failed", "skipped"]),
    attempts: z.number().int().min(0),
    maxAttempts: z.number().int().min(1).max(10),
    lastError: z.string().max(2000).nullable().optional(),
  })
  .strict();
const planDagShape = z.object({ steps: z.array(planStepShape).max(100) }).strict();
const buildPlanShape = { steps: z.array(rawPlanStepShape).min(1).max(100) };
const planStatusShape = { plan: planDagShape };
const recordStepResultShape = {
  plan: planDagShape,
  stepId: z.string().min(1).max(100),
  outcome: z.enum(["completed", "failed", "skipped"]),
  error: z.string().max(2000).optional(),
};

// #6150 — loopover_predict_gate's input, mirroring the remote server's predictGateShape. Metadata-only (no
// git/workspace context needed): predicts the gate outcome for a PLANNED PR before any local code exists, the
// same use case loopover_preflight_pr already serves for lane/duplicate/linked-issue checks.
const predictGateShape = {
  login: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  title: z.string().min(1),
  body: z.string().max(40000).optional(),
  labels: z.array(z.string()).max(50).optional(),
  linkedIssues: z.array(z.number().int().positive()).max(50).optional(),
  changedPaths: z.array(z.string().min(1).max(400)).max(500).optional(),
};

const preflightShape = {
  repoFullName: z.string().min(3),
  contributorLogin: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  changedFiles: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().optional(),
};

const localDiffShape = {
  repoFullName: z.string().min(3),
  cwd: z.string().optional(),
  baseRef: z.string().default("HEAD"),
  contributorLogin: z.string().min(1).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  tests: z.array(z.string()).optional(),
  authorAssociation: z.string().optional(),
  commitMessage: z.string().optional(),
};

const branchEligibilityShape = {
  status: z.enum(["eligible", "ineligible", "unknown"]),
  source: z.enum(["github_metadata", "local_metadata", "registry", "user_supplied"]).optional(),
  reason: z.string().optional(),
  checkedAt: z.string().optional(),
  stale: z.boolean().optional(),
};

const localScoreShape = {
  ...localDiffShape,
  targetKey: z.string().optional(),
  sourceTokenScore: z.number().min(0).optional(),
  totalTokenScore: z.number().min(0).optional(),
  sourceLines: z.number().min(0).optional(),
  linkedIssueMode: z.enum(["none", "standard", "maintainer"]).default("none"),
  openPrCount: z.number().int().min(0).optional(),
  credibility: z.number().min(0).max(1).optional(),
  changesRequestedCount: z.number().int().min(0).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
  scorePreviewCommand: z.string().optional(),
};

const variantsShape = {
  variants: z.array(z.object(localScoreShape)).min(1).max(10),
};

const currentBranchShape = {
  login: z.string().min(1),
  cwd: z.string().optional(),
  repoFullName: z.string().min(3).optional(),
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  branchName: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linkedIssues: z.array(z.number().int().positive()).optional(),
  pendingMergedPrCount: z.number().int().min(0).optional(),
  pendingClosedPrCount: z.number().int().min(0).optional(),
  approvedPrCount: z.number().int().min(0).optional(),
  expectedOpenPrCountAfterMerge: z.number().int().min(0).optional(),
  projectedCredibility: z.number().min(0).max(1).optional(),
  scenarioNotes: z.array(z.string()).optional(),
  branchEligibility: z.object(branchEligibilityShape).strict().optional(),
  validation: z
    .array(
      z.object({
        command: z.string().min(1),
        status: z.enum(["passed", "failed", "not_run", "skipped", "focused", "unknown"]),
        summary: z.string().optional(),
        durationMs: z.number().int().min(0).optional(),
        exitCode: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
  scorePreviewCommand: z.string().optional(),
};

const currentBranchVariantsShape = {
  variants: z.array(z.object(currentBranchShape)).min(1).max(10),
};

const agentPlanShape = {
  login: z.string().min(1),
  objective: z.string().optional(),
  repoFullName: z.string().min(3).optional(),
};

const agentRunShape = {
  objective: z.string().min(1),
  actorLogin: z.string().min(1),
  targetRepoFullName: z.string().min(3).optional(),
  targetPullNumber: z.number().int().positive().optional(),
  targetIssueNumber: z.number().int().positive().optional(),
};

const agentRunIdShape = {
  runId: z.string().min(1),
};

// #6152 maintain-surface tools. Each shape mirrors its already-shipped remote counterpart in src/mcp/server.ts
// (listPendingActionsShape, decidePendingActionShape, setAgentPausedShape, setActionAutonomyShape,
// ownerRepoWindowShape) so the same call works against either server. The `decision` verb is accept|reject --
// the approval-queue route's own vocabulary (#779) -- rather than the maintain CLI's approve|reject, because a
// tool caller is talking to the route, not to the CLI's surface.
//
// One deliberate divergence: the remote's listPendingActionsShape takes an optional `status`, which it can honour
// because it queries the approval-queue store directly. This server reaches the queue only through
// GET /v1/repos/:owner/:repo/agent/pending-actions, which takes no query parameters and hardcodes status
// "pending" (src/api/routes.ts). Offering a `status` here would let a caller ask for "rejected", get the pending
// list, and be told it succeeded -- so it is left out of the schema and the description names the queue as the
// pending one. An agent picks its arguments from the published schema, so a filter that isn't there is one it
// won't ask for; a key sent anyway is dropped by the MCP layer before this handler and never reaches the URL.
const listPendingActionsShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
};

const decidePendingActionShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  id: z.string().min(1),
  decision: z.enum(["accept", "reject"]),
};

const setAgentPausedShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  paused: z.boolean(),
};

// Reuses the CLI's own constants, so `maintain set-level`'s validation and this tool's schema can never disagree
// about what the server accepts.
const setActionAutonomyShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  action: z.enum(MAINTAIN_ACTION_CLASSES),
  level: z.enum(MAINTAIN_AUTONOMY_LEVELS),
};

const gatePrecisionShape = {
  owner: z.string().min(1),
  repo: z.string().min(1),
  windowDays: z.number().int().positive().optional(),
};

// Single source of truth for stdio tool name + one-line description (#2233).
// Registration and `loopover-mcp tools` both read this list.
const STDIO_TOOL_DESCRIPTORS = [
  {
    name: "loopover_get_repo_context",
    category: "maintainer",
    description: "Return the LoopOver repo-context bundle for a repo — registration state, recommended contribution lane, queue health, duplicate-PR collisions, and config quality — from the private LoopOver API. Takes owner and repo.",
  },
  {
    name: "loopover_get_pr_reviewability",
    category: "review",
    description: "Return the reviewability report for an open PR: how ready it is to review/merge, the blocking or advisory signals against it, and its lane/duplicate/linked-issue context. Metadata-only, no GitHub writes.",
  },
  {
    name: "loopover_get_pr_ai_review_findings",
    category: "review",
    description:
      "Return a submitted pull request's real AI-review inline findings as structured JSON (category, path, severity, line, body) — the same categorization the PR comment uses. Post-submission only; self-scoped to your own PRs. Metadata-only, no GitHub writes.",
  },
  {
    name: "loopover_get_maintainer_noise",
    category: "maintainer",
    description: "Return the maintainer queue-noise triage report for a repo: a noise score/level, the specific noise sources to clear first, and recommended maintainer actions. Maintainer-authenticated; advisory only.",
  },
  {
    name: "loopover_preflight_pr",
    category: "discovery",
    description: "Preflight planned PR metadata against lane, duplicate, linked issue, test, and queue signals.",
  },
  {
    name: "loopover_validate_linked_issue",
    category: "discovery",
    description: "Report whether linking an issue will actually earn the standard linked-issue scoring multiplier for a planned PR — open, valid, single-owner, solvable by this PR — with the blocking reason if not. The raw multiplier value stays private.",
  },
  {
    name: "loopover_check_before_start",
    category: "discovery",
    description: "Before writing any code, check whether an issue is already claimed or solved, whether a duplicate cluster is forming, and whether it is a valid target. Returns a go/raise/avoid recommendation with public-safe reasons from cached metadata.",
  },
  {
    name: "loopover_find_opportunities",
    category: "discovery",
    description: "Cross-repo discovery: find high-fit contribution opportunities across registered Gittensor repos. Returns a ranked, public-safe list filtered by your MinerGoalSpec (lane, min rank score, languages). Metadata-only, no GitHub writes.",
  },
  {
    name: "loopover_retrieve_issue_context",
    category: "discovery",
    description: "Repo-scoped issue-centric RAG retrieval for the miner analyze phase. Returns related file paths and retrieval scores from issue title/body/labels — metadata only, never source text.",
  },
  {
    name: "loopover_lint_pr_text",
    category: "review",
    description: "Lint a commit message + PR body against the gittensor traceability/no-issue-rationale and Conventional Commit rubric before submitting. Returns a deterministic verdict (strong/adequate/weak) plus specific public-safe fixes. Computed in-process; no source upload and no API round-trip.",
  },
  {
    name: "loopover_validate_config",
    category: "utility",
    description: "Parse and validate a .loopover.yml manifest string using the same focus-manifest parser as the server. Returns normalized config fields, parse warnings, and an ok/warn/error status. Computed in-process; no source upload and no API round-trip. Metadata-only, no GitHub writes.",
  },
  {
    name: "loopover_check_slop_risk",
    category: "review",
    description: "Assess the deterministic slop risk of a planned change from local diff metadata (paths + line counts) + the PR description — an agent-native, source-free quality self-check. Returns slopRisk (0-100), band, findings, and the rubric. Computed in-process; no repo data and no API round-trip.",
  },
  {
    name: "loopover_simulate_open_pr_pressure",
    category: "discovery",
    description:
      "Rank what-if scenarios for easing a repo's open-PR pressure from already-computed queue-health metadata — deterministic, public-safe, and read-only. Needs no repo access and performs no GitHub writes.",
  },
  {
    name: "loopover_suggest_boundary_tests",
    category: "review",
    description:
      "Boundary-safe test-generation suggestion: evaluate locally precomputed boundary-touch metadata (path + pattern kind only; no patch/source text) with no test evidence in the diff, and return a LOCAL-execution action spec (criteria/hints only — never generated test code) for your OWN agent to scaffold tests with. Advisory-only; never blocks, never writes.",
  },
  {
    name: "loopover_check_test_evidence",
    category: "review",
    description:
      "Classify whether a planned change's changed files carry enough test evidence, from path metadata alone (no source uploaded) — an agent-native coverage-gap self-check before opening a PR. Returns a coverage band (strong/adequate/weak/absent) plus actionable guidance. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_evaluate_escalation",
    category: "agent",
    description:
      "Decide whether a rented loop needs a human, and what action to take, from an already-computed run outcome, health tier, and operator/customer signals — the deterministic support/escalation-path logic. Source-free; returns shouldEscalate + action (none/notify/human_review/stop) + severity + reasons. It decides; the caller wires the action. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_build_results_payload",
    category: "agent",
    description:
      "Package a completed loop iteration into the customer-facing result (#4801): a PR link, a plain-language summary, and a bounded diff preview, from already-computed iteration metadata. Deterministic and source-free — it formats the result, it does not fetch, open, or deliver anything. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_build_progress_snapshot",
    category: "agent",
    description:
      "Build a near-real-time progress snapshot for a running rented loop (#4800): phase, status, iteration/percent-complete, and a bounded recent-activity tail, from already-computed loop state. Deterministic and source-free; a customer surface pushes it on change rather than polling on a fixed interval. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_intake_idea",
    category: "agent",
    description:
      "Turn a freeform renter idea into a strict, claimable task-graph (spec #4779) and score it against the same feasibility gate the loop runs on. Deterministic and source-free: validates the submission, assembles constituent issues (an optional caller-supplied decomposition, else a single-issue baseline), and returns the graph plus its go/raise/avoid verdict. A malformed or empty submission returns an actionable error list, not a silent failure. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_plan_idea_claims",
    category: "agent",
    description:
      "Route a freeform idea through the intake bridge into a claim/code/submit-loop plan (#4799): validates the submission, builds the scored task-graph, and returns which constituent issues the loop can claim now vs. defer vs. skip — dependency-ordered so a prerequisite is always claimed before its dependents. Deterministic and source-free; it decides what to claim, it does not claim or run anything. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_check_issue_slop",
    category: "review",
    description: "Assess the deterministic slop risk of an issue from its title + body alone (no repo data) — flags clearly low-effort issues (empty body, an unfilled template) for triage. Returns slopRisk (0-100), band, findings, and the rubric. Advisory-only.",
  },
  // #6150 — the miner-auto-dev profile's plan-DAG + local-scorer + gate-prediction tools, previously listed in
  // recommendedTools below but never actually registered.
  {
    name: "loopover_run_local_scorer",
    category: "branch",
    description: "Compute deterministic source/test/non-code token scores from local changed-file metadata + validation results — no repo/contributor access, reveals nothing beyond a computation on the caller's own diff stats. Pass the result as the localScorer field of loopover_preview_local_pr_score or the analyze tools to score this branch in external_command mode. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_build_plan",
    category: "agent",
    description: "Build a normalized step DAG (dependencies, retry limits) from a raw list of steps and validate it for cycles/unknown dependencies. Returns the plan, its progress, the currently-ready steps, and validation. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_plan_status",
    category: "agent",
    description: "Return a plan's current progress, the next ready steps, and validation status. Takes the plan object returned by loopover_build_plan or a prior loopover_record_step_result call. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_record_step_result",
    category: "agent",
    description: "Record the outcome (completed/failed/skipped) of a plan step the harness just ran and return the updated plan. A failed step retries (back to pending) until its maxAttempts is exhausted. Computed in-process; no API round-trip.",
  },
  {
    name: "loopover_predict_gate",
    category: "review",
    description: "Predict the LoopOver gate outcome for a planned PR before any local code exists — the same advisory + gate evaluation the maintainer pipeline runs, using only the repo's public .loopover.yml policy. Takes login, owner, repo, title, and optional body/labels/linkedIssues/changedPaths. Metadata-only, no source upload.",
  },
  {
    name: "loopover_preflight_local_diff",
    category: "branch",
    description: "Inspect local git diff metadata and run LoopOver preflight without uploading source contents.",
  },
  {
    name: "loopover_get_registry_changes",
    category: "utility",
    description: "Return the latest cached report of changes to the Gittensor repo registry — repositories added, removed, or re-registered upstream. Read-only; takes no parameters.",
  },
  {
    name: "loopover_get_upstream_drift",
    category: "utility",
    description: "Return the latest cached Gittensor upstream ruleset drift status (stale/drift warnings) for MCP planning.",
  },
  {
    name: "loopover_get_bounty_advisory",
    category: "discovery",
    description:
      "Return the lifecycle, funding, and consensus-risk context for a cached Gittensor bounty by id, from the public LoopOver API.",
  },
  {
    name: "loopover_get_label_audit",
    category: "maintainer",
    description:
      "Return the repo's label-policy audit (configured-vs-live labels, missing configured labels, suspicious status/source-style labels, and trusted-label-pipeline readiness) from the private LoopOver API.",
  },
  {
    name: "loopover_get_maintainer_lane",
    category: "maintainer",
    description:
      "Return the repo's maintainer-lane triage report (the lane recommendation alongside the configured maintainer cut, queue health, config quality, and contributor-intake health) from the private LoopOver API. Advisory only.",
  },
  {
    name: "loopover_get_burden_forecast",
    category: "maintainer",
    description:
      "Return the repo's cached maintainer burden forecast (projected review load, queue-growth risk, and stale-PR signals) with a freshness marker, from the private LoopOver API.",
  },
  {
    name: "loopover_preview_local_pr_score",
    category: "branch",
    description: "Inspect local diff metadata and request a private LoopOver scoring preview. No source contents are uploaded.",
  },
  {
    name: "loopover_explain_score_breakdown",
    category: "review",
    description: "Explain a private score preview multiplier-by-multiplier with plain-English levers and the highest-impact improvement.",
  },
  {
    name: "loopover_get_eligibility_plan",
    category: "discovery",
    description: "Derive a structured eligibility plan from local score-preview metadata: whether the branch/PR is eligible now, public-safe blockers, and cleanup paths. Advisory dry-run only — no GitHub writes.",
  },
  {
    name: "loopover_get_decision_pack",
    category: "discovery",
    description: "Return the private decision pack for a contributor: the ranked repos and issues to work on next, with per-repo go/raise/avoid guidance. Takes login (the contributor's GitHub username).",
  },
  {
    name: "loopover_explain_repo_decision",
    category: "discovery",
    description: "Return the go/raise/avoid decision for one specific contributor-and-repo pair, drawn from that contributor's decision pack — narrower than loopover_get_decision_pack, which returns the whole pack. Takes login (GitHub username), owner, and repo.",
  },
  {
    name: "loopover_monitor_open_prs",
    category: "discovery",
    description:
      "Inspect a contributor's open PRs on registered repos, classify queue state, and return public-safe next-step packets from cached metadata.",
  },
  {
    name: "loopover_compare_pr_variants",
    category: "branch",
    description: "Compare private LoopOver scoring previews across local/metadata variants.",
  },
  {
    name: "loopover_local_status",
    category: "utility",
    description: "Return local LoopOver MCP status, inferred git repo metadata, and privacy defaults.",
  },
  {
    name: "loopover_preflight_current_branch",
    category: "branch",
    description: "Analyze the current git branch and return PR readiness. Sends metadata only.",
  },
  {
    name: "loopover_review_pr_before_push",
    category: "branch",
    description: "Run a single composed pre-PR review of the current branch: preflight (lane/duplicate/linked-issue/test/queue fit), slop-risk, and PR-text lint, merged into one report with an overall pass/warn/fail status. Thin composition of the existing checks — does not reimplement any of them. Sends metadata only, no source upload.",
  },
  {
    name: "loopover_preview_current_branch_score",
    category: "branch",
    description: "Analyze the current git branch and return private scoreability context. Sends metadata only.",
  },
  {
    name: "loopover_rank_local_next_actions",
    category: "branch",
    description: "Analyze the current git branch and rank local next actions by private reward/risk and review friction.",
  },
  {
    name: "loopover_explain_local_blockers",
    category: "branch",
    description: "Analyze the current git branch and explain private scoreability, lane, and review blockers.",
  },
  {
    name: "loopover_remediation_plan",
    category: "branch",
    description: "Analyze the current git branch and return an ordered public-safe remediation checklist with rerun conditions.",
  },
  {
    name: "loopover_prepare_pr_packet",
    category: "branch",
    description: "Analyze the current git branch and return a public-safe PR packet. Sends metadata only.",
  },
  {
    name: "loopover_compare_local_variants",
    category: "branch",
    description: "Compare current-branch metadata variants without uploading source contents.",
  },
  {
    name: "loopover_agent_plan_next_work",
    category: "agent",
    description: "Run the deterministic LoopOver planner for a contributor and return the single recommended next unit of work (repo, issue, and action). Planning only — does not queue or start a run. Takes login (GitHub username); optional objective and repoFullName narrow the result.",
  },
  {
    name: "loopover_agent_start_run",
    category: "agent",
    description: "Queue a new LoopOver automated-agent run for a contributor. Copilot mode only: it proposes and records work but takes no GitHub actions on its own. Takes objective (what to accomplish) and actorLogin (the contributor's GitHub username); returns the new run's id and status.",
  },
  {
    name: "loopover_agent_get_run",
    category: "agent",
    description: "Fetch a previously queued LoopOver agent run by its id, including current status and planned actions. Takes runId (the id returned by loopover_agent_start_run).",
  },
  {
    name: "loopover_agent_explain_next_action",
    category: "agent",
    description: "Explain the next deterministic action and blocker context for a GitHub login.",
  },
  {
    name: "loopover_agent_prepare_pr_packet",
    category: "branch",
    description: "Prepare a public-safe PR packet from current branch metadata. Sends metadata only.",
  },
  {
    name: "loopover_local_status_structured",
    category: "utility",
    description: "Return local LoopOver MCP status with a validated structured output schema.",
  },
  {
    name: "loopover_feasibility_gate",
    category: "discovery",
    description: "Pure local go/raise/avoid feasibility verdict from claim status, duplicate-cluster risk, and issue quality/lifecycle status — the same discriminants the analyze-phase feasibility gate branches on. When repoFullName/issueNumber are supplied and a local loopover-miner install's claim ledger is present, claimStatus is read from that ledger instead of the caller-supplied value; otherwise falls back to the caller-supplied claimStatus unchanged. Advisory-only — never blocks, cancels, or overrides a claim or attempt; real claim-conflict resolution authority stays with the maintainer-only path. No API round-trip.",
  },
  {
    name: "loopover_get_issue_quality",
    category: "maintainer",
    description: "Return the cached or freshly-computed issue-quality report for a repo, ranking which open issues are actionable, need proof, are stale/duplicate-prone, or already solved.",
  },
  {
    name: "loopover_get_registration_readiness",
    category: "maintainer",
    description: "Preview-only registration-readiness report for a repository: what's missing/present before/after registering with LoopOver (direct-PR and issue-discovery lane readiness, label policy, maintainer-cut readiness, queue health, docs, and the GitHub App install state). Advisory only, not a registration action.",
  },
  {
    name: "loopover_get_config_recommendation",
    category: "maintainer",
    description: "Return recommended .loopover.yml additions for a repository, derived from the repo's live, currently-active configured behavior (the raw dashboard/API-configured settings, not a yml-merged view — so the recommendation never compares itself against an override that already exists). Advisory only, not a write action.",
  },
  {
    name: "loopover_get_skipped_pr_audit",
    category: "maintainer",
    description: "Return the skipped-PR audit trail: pull requests LoopOver's automated reviewer intentionally stayed quiet on, each with a reason code and a remediation hint. Optionally filter by repoFullName, reason, or since. Maintainer-authenticated; read-only measurement, not a moderation or override action.",
  },
  // #6152 — the maintain CLI's REST surface, exposed as tools so an agent can drive it without shelling out.
  // Categories mirror the remote server's MCP_TOOL_CATEGORIES entries for the same names, so a caller sees one
  // consistent grouping across both surfaces.
  {
    name: "loopover_list_pending_actions",
    category: "agent",
    description: "List the agent actions currently staged and awaiting a decision in a repo's approval queue, so a maintainer can review what is pending. Returns the pending queue only — the same list as `loopover-mcp maintain queue`. Maintainer access required.",
  },
  {
    name: "loopover_decide_pending_action",
    category: "agent",
    description: "Accept (execute) or reject a staged approval-queue action by id. Accept runs it through the live executor gates; reject cancels it. Scoped to this repo, same as `loopover-mcp maintain approve|reject <id>`. Maintainer access required.",
  },
  {
    name: "loopover_set_agent_paused",
    category: "agent",
    description: "Pause or resume ALL agent actions on a repo (the kill-switch toggle), same as `loopover-mcp maintain pause|resume`. Maintainer access required.",
  },
  {
    name: "loopover_set_action_autonomy",
    category: "agent",
    description: "Set the autonomy level for one action class via a read-merge-write, so the other classes are left untouched. Same as `loopover-mcp maintain set-level <action> <level>`. Maintainer access required.",
  },
  {
    name: "loopover_get_gate_precision",
    category: "maintainer",
    description: "Return per-gate-type false-positive precision for a repo's recorded gate blocks — blocked / blocked-then-merged counts and false-positive rates with low-sample guards. Optionally bounded by windowDays. Maintainer-authenticated; measurement only.",
  },
  {
    name: "loopover_open_pr",
    category: "agent",
    description:
      "Build a LOCAL-execution spec to open a pull request from your branch (run it with your own gh creds; loopover never performs the write).",
  },
  {
    name: "loopover_file_issue",
    category: "agent",
    description: "Build a LOCAL-execution spec to file an issue (run it with your own gh creds; loopover never performs the write).",
  },
  {
    name: "loopover_apply_labels",
    category: "agent",
    description:
      "Build a LOCAL-execution spec to add labels to an issue or PR (run it with your own gh creds; loopover never performs the write).",
  },
  {
    name: "loopover_post_eligibility_comment",
    category: "agent",
    description:
      "Build a LOCAL-execution spec to post an eligibility/context comment on an issue or PR (run it with your own gh creds; loopover never performs the write).",
  },
  {
    name: "loopover_create_branch",
    category: "agent",
    description: "Build a LOCAL-execution spec to create a branch (run it locally; loopover never performs the write).",
  },
  {
    name: "loopover_delete_branch",
    category: "agent",
    description: "Build a LOCAL-execution spec to delete a branch (run it locally; loopover never performs the write).",
  },
  {
    name: "loopover_generate_tests",
    category: "agent",
    description:
      "Build a LOCAL-execution spec describing WHAT boundary-safe test cases should exist for the given target files, using the repo's detected framework/convention. LoopOver supplies the criteria; your OWN agent scaffolds and runs the actual test files locally -- no source code is uploaded and loopover never performs the write.",
  },
  {
    name: "loopover_file_follow_up_issue",
    category: "agent",
    description:
      "Build a LOCAL-execution spec to file a follow-up issue for a review finding a maintainer wants TRACKED rather than blocked on this PR. Composes a bounded, public-safe title/body from the finding (run it with your own gh creds; loopover never performs the write).",
  },
  {
    name: "loopover_close_pr",
    category: "agent",
    description:
      "Build a LOCAL-execution spec to close a pull request, optionally with a comment (run it with your own gh creds; loopover never performs the write).",
  },
];

// #6301 — coarse tool categories for grouping `loopover-mcp tools` output. Ordered
// contributor-facing surfaces first, operator ones last; the `label` is the human-readable header.
// Every STDIO_TOOL_DESCRIPTORS entry carries a `category` id drawn from this list (asserted in tests).
const STDIO_TOOL_CATEGORIES = [
  { id: "discovery", label: "Discovery & planning" },
  { id: "branch", label: "Local branch & PR prep" },
  { id: "review", label: "Review & gate prediction" },
  { id: "agent", label: "Agent automation" },
  { id: "maintainer", label: "Maintainer & repo owner" },
  { id: "utility", label: "Registry, config & status" },
];

function stdioToolDescription(name) {
  const tool = STDIO_TOOL_DESCRIPTORS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown stdio tool descriptor: ${name}`);
  return tool.description;
}

if (cliArgs[0] && cliArgs[0] !== "--stdio") {
  try {
    const exitCode = await runCli(cliArgs);
    process.exit(typeof exitCode === "number" ? exitCode : 0);
  } catch (error) {
    process.exit(reportCliFailure(argsWantJson(cliArgs), describeCliError(error), 1));
  }
}

const server = new McpServer({
  name: "loopover-local",
  version: packageVersion,
});

// #4777: register a stdio tool under its loopover_ name. Thin wrapper kept so all 37 call sites
// stay uniform with the rest of this file's registration style.
// Single chokepoint for the #6228 PostHog tool-call telemetry (#6238): every registerStdioTool-registered tool
// routes through here exactly once per invocation, whether it returns or throws. Pure observability -- a
// telemetry failure must never reach the tool caller, so this keeps a defensive try/catch on top of
// recordMcpToolCall's own never-throw guarantee (#6236), mirroring recordMcpToolTelemetry on the remote side
// (#6237).
//
// Reads the opt-in flag HERE, at module scope, on purpose: registerStdioTool's second parameter is the TOOL's
// config and shadows the module-level `config` this resolves from, so a read inside that function would silently
// see the wrong object and never fire.
function recordStdioToolTelemetry(tool, ok, durationMs) {
  try {
    recordLocalMcpToolCall({ telemetryEnabled: telemetryState().enabled }, { tool, callerType: "local", ok, durationMs });
  } catch {
    // Telemetry must never affect the tool response (#6238).
  }
}

function registerStdioTool(name, config, handler) {
  server.registerTool(name, config, async (...args) => {
    const startedAt = Date.now();
    try {
      const result = await handler(...args);
      // Mirror the remote's caller-visible outcome (`response.status < 400`): a handler that reports failure by
      // returning an error result is not a success, even though it never threw.
      recordStdioToolTelemetry(name, result?.isError !== true, Date.now() - startedAt);
      return result;
    } catch (error) {
      recordStdioToolTelemetry(name, false, Date.now() - startedAt);
      throw error;
    }
  });
}

registerStdioTool(
  "loopover_get_repo_context",
  {
    description: stdioToolDescription("loopover_get_repo_context"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver repo intelligence.", await apiGet(`${prefix}/intelligence`));
  },
);

registerStdioTool(
  "loopover_get_pr_reviewability",
  {
    description: stdioToolDescription("loopover_get_pr_reviewability"),
    inputSchema: ownerRepoPullShape,
  },
  async ({ owner, repo, number }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver PR reviewability.", await apiGet(`${prefix}/pulls/${number}/reviewability`));
  },
);

// #6619: CLI mirror of the remote server's loopover_get_pr_ai_review_findings. The route is the single source
// of truth (it delegates to the same loadPrAiReviewFindings the MCP server uses); this tool only resolves the
// author login and proxies. Self-scoped: the route's requireContributorAccess rejects another login's PR.
registerStdioTool(
  "loopover_get_pr_ai_review_findings",
  {
    description: stdioToolDescription("loopover_get_pr_ai_review_findings"),
    inputSchema: prAiReviewFindingsShape,
  },
  async ({ owner, repo, number, login }) => {
    const authorLogin = login ?? activeProfile.session?.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!authorLogin) throw new Error("No GitHub login: pass `login`, log in with `loopover-mcp login`, or set LOOPOVER_LOGIN.");
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult(
      "LoopOver PR AI-review findings.",
      await apiGet(`${prefix}/pulls/${number}/ai-review-findings?login=${encodeURIComponent(authorLogin)}`),
    );
  },
);

registerStdioTool(
  "loopover_get_maintainer_noise",
  {
    description: stdioToolDescription("loopover_get_maintainer_noise"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver maintainer noise report.", await apiGet(`${prefix}/maintainer-noise`));
  },
);

registerStdioTool(
  "loopover_get_issue_quality",
  {
    description: stdioToolDescription("loopover_get_issue_quality"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver issue-quality report.", await apiGet(`${prefix}/issue-quality`));
  },
);

registerStdioTool(
  "loopover_get_registration_readiness",
  {
    description: stdioToolDescription("loopover_get_registration_readiness"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver registration-readiness report.", await apiGet(`${prefix}/registration-readiness`));
  },
);

registerStdioTool(
  "loopover_get_config_recommendation",
  {
    description: stdioToolDescription("loopover_get_config_recommendation"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    return toolResult("LoopOver config recommendation.", await apiGet(`${prefix}/gittensor-config-recommendation`));
  },
);

registerStdioTool(
  "loopover_get_skipped_pr_audit",
  {
    description: stdioToolDescription("loopover_get_skipped_pr_audit"),
    inputSchema: skippedPrAuditShape,
  },
  async ({ repoFullName, reason, since, limit }) => {
    const query = new URLSearchParams();
    if (repoFullName) query.set("repoFullName", repoFullName);
    if (reason) query.set("reason", reason);
    if (since) query.set("since", since);
    if (limit != null) query.set("limit", String(limit));
    const qs = query.toString();
    return toolResult("LoopOver skipped-PR audit trail.", await apiGet(`/v1/app/skipped-pr-audit${qs ? `?${qs}` : ""}`));
  },
);

registerStdioTool(
  "loopover_preflight_pr",
  {
    description: stdioToolDescription("loopover_preflight_pr"),
    inputSchema: preflightShape,
  },
  async (input) => toolResult("LoopOver PR preflight.", await apiPost("/v1/preflight/pr", input)),
);

registerStdioTool(
  "loopover_validate_linked_issue",
  {
    description: stdioToolDescription("loopover_validate_linked_issue"),
    inputSchema: validateLinkedIssueShape,
  },
  async ({ owner, repo, issueNumber, plannedChange }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = { issueNumber, ...(plannedChange ? { plannedChange } : {}) };
    return toolResult("LoopOver linked-issue validation.", await apiPost(`${prefix}/validate-linked-issue`, body));
  },
);

registerStdioTool(
  "loopover_check_before_start",
  {
    description: stdioToolDescription("loopover_check_before_start"),
    inputSchema: checkBeforeStartShape,
  },
  async ({ owner, repo, issueNumber, title, plannedPaths }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const body = {
      ...(issueNumber != null ? { issueNumber } : {}),
      ...(title ? { title } : {}),
      ...(plannedPaths ? { plannedPaths } : {}),
    };
    return toolResult("LoopOver pre-start check.", await apiPost(`${prefix}/check-before-start`, body));
  },
);

registerStdioTool(
  "loopover_find_opportunities",
  {
    description: stdioToolDescription("loopover_find_opportunities"),
    inputSchema: findOpportunitiesShape,
  },
  async ({ targets, searchQuery, goalSpec, limit }) => {
    const body = {
      ...(targets && targets.length > 0 ? { targets } : {}),
      ...(searchQuery ? { searchQuery } : {}),
      ...(goalSpec ? { goalSpec } : {}),
      ...(limit != null ? { limit } : {}),
    };
    return toolResult("LoopOver cross-repo opportunities.", await apiPost("/v1/opportunities/find", body));
  },
);

registerStdioTool(
  "loopover_retrieve_issue_context",
  {
    description: stdioToolDescription("loopover_retrieve_issue_context"),
    inputSchema: issueRagShape,
  },
  async ({ owner, repo, title, body, labels, topK }) => {
    const payload = {
      owner,
      repo,
      title,
      ...(body ? { body } : {}),
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(topK != null ? { topK } : {}),
    };
    return toolResult("LoopOver issue-centric RAG context.", await apiPost("/v1/issue-rag/retrieve", payload));
  },
);

registerStdioTool(
  "loopover_lint_pr_text",
  {
    description: stdioToolDescription("loopover_lint_pr_text"),
    inputSchema: lintPrTextShape,
  },
  // Computed in-process from @loopover/engine (#6268) — matches the remote server's own buildPrTextLint
  // call (src/mcp/server.ts) with no API round-trip, so PR-text lint works fully offline.
  (input) => toolResult("LoopOver PR-text lint.", buildPrTextLint(input)),
);

registerStdioTool(
  "loopover_validate_config",
  {
    description: stdioToolDescription("loopover_validate_config"),
    inputSchema: validateConfigShape,
  },
  // #6269: computed in-process via the extracted engine builder -- no API round-trip, works fully offline.
  (input) => toolResult("LoopOver manifest validation.", buildFocusManifestValidation(input)),
);

registerStdioTool(
  "loopover_check_slop_risk",
  {
    description: stdioToolDescription("loopover_check_slop_risk"),
    inputSchema: checkSlopRiskShape,
  },
  // Computed in-process from @loopover/engine (#6267) — matches the remote server's own buildSlopAssessment
  // call (src/mcp/server.ts) and the /v1/lint/slop-risk route's `{ ...assessment, rubric }` shape with no API
  // round-trip, so slop-risk self-checks work fully offline.
  (input) => toolResult("LoopOver slop-risk self-check.", { ...buildSlopAssessment(input), rubric: SLOP_RUBRIC_MARKDOWN }),
);

// #6751: CLI mirror of the remote server's loopover_simulate_open_pr_pressure. Proxies rather than computing
// in-process (like the boundary-tests mirror, #6750): simulateOpenPrPressure lives app-side in
// src/services/open-pr-pressure-scenarios.ts, not in @loopover/engine, so POST /v1/lint/open-pr-pressure stays
// the single source of truth for the ranking.
registerStdioTool(
  "loopover_simulate_open_pr_pressure",
  {
    description: stdioToolDescription("loopover_simulate_open_pr_pressure"),
    inputSchema: simulateOpenPrPressureShape,
  },
  async (input) => toolResult("LoopOver open-PR pressure simulation.", await apiPost("/v1/lint/open-pr-pressure", input)),
);

// #6750: CLI mirror of the remote server's loopover_suggest_boundary_tests. Unlike its check_slop_risk sibling
// this one PROXIES rather than computing in-process: the builders live app-side (src/signals/
// boundary-test-generation.ts, which depends on the app's AdvisoryFinding type), not in @loopover/engine, so
// POST /v1/lint/boundary-tests stays the single source of truth for the filtering + finding/spec logic.
registerStdioTool(
  "loopover_suggest_boundary_tests",
  {
    description: stdioToolDescription("loopover_suggest_boundary_tests"),
    inputSchema: suggestBoundaryTestsShape,
  },
  async (input) => toolResult("LoopOver boundary-test suggestion.", await apiPost("/v1/lint/boundary-tests", input)),
);

registerStdioTool(
  "loopover_check_test_evidence",
  {
    description: stdioToolDescription("loopover_check_test_evidence"),
    inputSchema: checkTestEvidenceShape,
  },
  // Computed in-process from @loopover/engine (#6749) — the same buildTestEvidenceReport the remote server
  // (src/mcp/server.ts) and the /v1/lint/test-evidence route both call, so all three surfaces return a
  // byte-identical verdict and coverage self-checks work fully offline.
  (input) => toolResult("LoopOver test-evidence check.", buildTestEvidenceReport(input)),
);

registerStdioTool(
  "loopover_evaluate_escalation",
  {
    description: stdioToolDescription("loopover_evaluate_escalation"),
    inputSchema: evaluateEscalationShape,
  },
  // Computed in-process from @loopover/engine (#6754) — the same pure evaluateEscalation the remote server
  // (src/mcp/server.ts) and the /v1/loop/evaluate-escalation route both call, so all three surfaces return a
  // byte-identical decision for identical input, and escalation checks work fully offline.
  (input) => toolResult("LoopOver escalation decision.", evaluateEscalation(input)),
);

registerStdioTool(
  "loopover_build_results_payload",
  {
    description: stdioToolDescription("loopover_build_results_payload"),
    inputSchema: resultsPayloadShape,
  },
  // Computed in-process from @loopover/engine (#6752) — the same pure buildResultsPayload the remote server
  // (src/mcp/server.ts) and the /v1/loop/results-payload route both call, so all three surfaces return an
  // identical payload for identical input, and results composition works fully offline.
  (input) => toolResult("LoopOver loop results payload.", buildResultsPayload(input)),
);

registerStdioTool(
  "loopover_build_progress_snapshot",
  {
    description: stdioToolDescription("loopover_build_progress_snapshot"),
    inputSchema: buildProgressSnapshotShape,
  },
  // Computed in-process from @loopover/engine (#6753) — the same pure buildProgressSnapshot the remote server
  // (src/mcp/server.ts) and the /v1/loop/progress-snapshot route both call, so all three surfaces return an
  // identical snapshot for identical input, and progress composition works fully offline.
  (input) => toolResult("LoopOver loop progress snapshot.", buildProgressSnapshot(input)),
);

registerStdioTool(
  "loopover_intake_idea",
  {
    description: stdioToolDescription("loopover_intake_idea"),
    inputSchema: intakeIdeaShape,
  },
  // Computed in-process from @loopover/engine (#6755) — the same pure validateIdeaSubmission/buildTaskGraph the
  // remote server (src/mcp/server.ts) and the /v1/loop/intake-idea route both call, reproducing the tool's
  // handler exactly so all three surfaces return an identical payload for identical input, fully offline.
  (input) => {
    const validated = validateIdeaSubmission(input);
    if (!validated.ok) return toolResult(`Invalid idea submission: ${validated.errors.join(", ")}.`, { ok: false, errors: validated.errors });
    const taskGraph = buildTaskGraph(validated.idea, input.decomposition);
    return toolResult(`Task-graph verdict: ${taskGraph.rubric.verdict} across ${taskGraph.issues.length} issue(s).`, {
      ok: true,
      verdict: taskGraph.rubric.verdict,
      taskGraph,
    });
  },
);

registerStdioTool(
  "loopover_plan_idea_claims",
  {
    description: stdioToolDescription("loopover_plan_idea_claims"),
    inputSchema: intakeIdeaShape,
  },
  // Computed in-process from @loopover/engine (#6756) — the same pure validateIdeaSubmission/buildTaskGraph/
  // buildClaimPlan the remote server (src/mcp/server.ts) and the /v1/loop/plan-idea-claims route both call,
  // reproducing the tool's handler exactly so all three surfaces return an identical payload for identical
  // input, fully offline.
  (input) => {
    const validated = validateIdeaSubmission(input);
    if (!validated.ok) return toolResult(`Invalid idea submission: ${validated.errors.join(", ")}.`, { ok: false, errors: validated.errors });
    const graph = buildTaskGraph(validated.idea, input.decomposition);
    const claimPlan = buildClaimPlan(graph, validated.idea.targetRepo);
    return toolResult(
      `Claim plan: ${claimPlan.claimable.length} claimable, ${claimPlan.deferred.length} deferred, ${claimPlan.skipped.length} skipped.`,
      { ok: true, verdict: claimPlan.graphVerdict, claimPlan },
    );
  },
);

registerStdioTool(
  "loopover_check_issue_slop",
  {
    description: stdioToolDescription("loopover_check_issue_slop"),
    inputSchema: checkIssueSlopShape,
  },
  async (input) => toolResult("LoopOver issue-slop self-check.", await apiPost("/v1/lint/issue-slop", input)),
);

registerStdioTool(
  "loopover_run_local_scorer",
  {
    description: stdioToolDescription("loopover_run_local_scorer"),
    inputSchema: runLocalScorerShape,
  },
  // Computed in-process from @loopover/engine (#6150) — matches the remote server's own
  // computeLocalScorerTokens call (src/mcp/server.ts) with no API round-trip, so token scoring works fully
  // offline.
  (input) => toolResult("LoopOver local token scores.", computeLocalScorerTokens(input)),
);

registerStdioTool(
  "loopover_build_plan",
  {
    description: stdioToolDescription("loopover_build_plan"),
    inputSchema: buildPlanShape,
  },
  // Computed in-process (#6150) — matches the remote server's own buildPlanDag call (src/mcp/server.ts)
  // with no API round-trip; the plan-DAG logic itself is hand-duplicated above (see its own comment).
  (input) => toolResult("LoopOver plan built.", planView(buildPlanDag(input.steps))),
);

registerStdioTool(
  "loopover_plan_status",
  {
    description: stdioToolDescription("loopover_plan_status"),
    inputSchema: planStatusShape,
  },
  (input) => toolResult("LoopOver plan status.", planView(input.plan)),
);

registerStdioTool(
  "loopover_record_step_result",
  {
    description: stdioToolDescription("loopover_record_step_result"),
    inputSchema: recordStepResultShape,
  },
  (input) =>
    toolResult(
      "LoopOver plan step result recorded.",
      planView(applyStepResult(input.plan, input.stepId, { outcome: input.outcome, ...(input.error !== undefined ? { error: input.error } : {}) })),
    ),
);

registerStdioTool(
  "loopover_predict_gate",
  {
    description: stdioToolDescription("loopover_predict_gate"),
    inputSchema: predictGateShape,
  },
  // Metadata-only proxy to the same route the branch-analysis tools already use (#6150) — that route computes
  // predictedGate via buildPredictedGateVerdict (the identical logic the remote loopover_predict_gate tool
  // uses) and returns it as a top-level field; no local git/workspace context is needed for this shape.
  async (input) => {
    const body = {
      login: input.login,
      repoFullName: `${input.owner}/${input.repo}`,
      title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
      ...(input.linkedIssues !== undefined ? { linkedIssues: input.linkedIssues } : {}),
      ...(input.changedPaths !== undefined ? { changedFiles: input.changedPaths.map((path) => ({ path })) } : {}),
    };
    const result = await apiPost("/v1/local/branch-analysis", body);
    return toolResult(`LoopOver predicted gate for ${input.owner}/${input.repo}.`, result.predictedGate);
  },
);

registerStdioTool(
  "loopover_preflight_local_diff",
  {
    description: stdioToolDescription("loopover_preflight_local_diff"),
    inputSchema: localDiffShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const diff = collectLocalDiff(workspaceInput.cwd, input.baseRef, workspaceInput.workspaceRoots);
    const body = {
      repoFullName: input.repoFullName,
      contributorLogin: input.contributorLogin,
      title: input.title ?? diff.title,
      body: input.body,
      labels: input.labels,
      linkedIssues: input.linkedIssues,
      tests: input.tests,
      authorAssociation: input.authorAssociation,
      commitMessage: input.commitMessage ?? diff.commitMessage,
      changedFiles: diff.changedFiles,
      testFiles: diff.testFiles,
      changedLineCount: diff.changedLineCount,
    };
    return toolResult("LoopOver local diff preflight.", await apiPost("/v1/preflight/local-diff", body));
  },
);

registerStdioTool(
  "loopover_get_registry_changes",
  {
    description: stdioToolDescription("loopover_get_registry_changes"),
    inputSchema: {},
  },
  async () => toolResult("LoopOver registry changes.", await apiGet("/v1/registry/changes")),
);

// #6736: CLI mirror of the public loopover_get_bounty_advisory tool. Proxies the same unauthenticated
// GET /v1/bounties/:id/advisory the remote tool wraps -- no owner/repo, just the cached-bounty id.
registerStdioTool(
  "loopover_get_bounty_advisory",
  {
    description: stdioToolDescription("loopover_get_bounty_advisory"),
    inputSchema: bountyAdvisoryShape,
  },
  async ({ id }) => toolResult("LoopOver bounty advisory.", await apiGet(`/v1/bounties/${encodeURIComponent(id)}/advisory`)),
);

registerStdioTool(
  "loopover_get_upstream_drift",
  {
    description: stdioToolDescription("loopover_get_upstream_drift"),
    inputSchema: {},
  },
  async () => toolResult("LoopOver upstream drift status.", await apiGet("/v1/upstream/drift")),
);

registerStdioTool(
  "loopover_get_label_audit",
  {
    description: stdioToolDescription("loopover_get_label_audit"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver label audit.", {
      repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
      generatedAt: intelligence?.generatedAt,
      labelAudit: intelligence?.labelAudit ?? null,
    });
  },
);

// #6739: CLI mirror of the remote server's loopover_get_maintainer_lane. maintainerLane ships in the same
// buildRepoIntelligenceResponse payload the sibling loopover_get_label_audit already GETs, so this is a thin
// extraction over that identical route rather than a new fetch shape.
registerStdioTool(
  "loopover_get_maintainer_lane",
  {
    description: stdioToolDescription("loopover_get_maintainer_lane"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver maintainer lane.", {
      repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
      generatedAt: intelligence?.generatedAt,
      maintainerLane: intelligence?.maintainerLane ?? null,
    });
  },
);

registerStdioTool(
  "loopover_get_burden_forecast",
  {
    description: stdioToolDescription("loopover_get_burden_forecast"),
    inputSchema: ownerRepoShape,
  },
  async ({ owner, repo }) => {
    const prefix = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const intelligence = await apiGet(`${prefix}/intelligence`);
    return toolResult("LoopOver burden forecast.", {
      repoFullName: intelligence?.repoFullName ?? `${owner}/${repo}`,
      generatedAt: intelligence?.generatedAt,
      burdenForecast: intelligence?.burdenForecast ?? null,
      burdenForecastFreshness: intelligence?.burdenForecastFreshness ?? null,
    });
  },
);

registerStdioTool(
  "loopover_preview_local_pr_score",
  {
    description: stdioToolDescription("loopover_preview_local_pr_score"),
    inputSchema: localScoreShape,
  },
  async (input) => toolResult("LoopOver private local PR scoring preview.", await previewLocalScore(await withClientWorkspaceRoots(input))),
);

// Shared by loopover_explain_score_breakdown and loopover_get_eligibility_plan (#6621): both resolve the same
// local branch/diff metadata into the /v1/scoring request body — only the endpoint they POST it to differs, so
// the assembly lives here once rather than in two drifting copies.
function buildLocalScoreRequestBody(workspaceInput, contributorLogin) {
  const workspace = resolveWorkspaceCwd(workspaceInput);
  const diff = collectLocalDiff(workspace.cwd, workspaceInput.baseRef, workspaceInput.workspaceRoots);
  const branchPayload = buildBranchAnalysisPayload({
    ...workspaceInput,
    login: contributorLogin,
    cwd: workspace.cwd,
    repoFullName: workspaceInput.repoFullName,
    baseRef: workspaceInput.baseRef,
  });
  const upstreamPreview = branchPayload.localScorerStatus;
  const estimatedSourceLines = workspaceInput.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
  return {
    repoFullName: workspaceInput.repoFullName,
    targetType: "local_diff",
    targetKey: workspaceInput.targetKey ?? localDiffTargetKey(branchPayload, workspaceInput.baseRef),
    contributorLogin,
    labels: workspaceInput.labels,
    linkedIssueMode: workspaceInput.linkedIssueMode,
    sourceTokenScore: workspaceInput.sourceTokenScore ?? estimatedSourceLines,
    sourceLines: estimatedSourceLines,
    totalTokenScore: workspaceInput.totalTokenScore ?? diff.changedLineCount,
    testTokenScore: diff.testFiles.length,
    openPrCount: workspaceInput.openPrCount,
    credibility: workspaceInput.credibility,
    changesRequestedCount: workspaceInput.changesRequestedCount,
    pendingMergedPrCount: workspaceInput.pendingMergedPrCount,
    pendingClosedPrCount: workspaceInput.pendingClosedPrCount,
    approvedPrCount: workspaceInput.approvedPrCount,
    expectedOpenPrCountAfterMerge: workspaceInput.expectedOpenPrCountAfterMerge,
    projectedCredibility: workspaceInput.projectedCredibility,
    scenarioNotes: workspaceInput.scenarioNotes,
    branchEligibility: workspaceInput.branchEligibility,
    metadataOnly: !upstreamPreview.ok,
  };
}

registerStdioTool(
  "loopover_explain_score_breakdown",
  {
    description: stdioToolDescription("loopover_explain_score_breakdown"),
    inputSchema: localScoreShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const contributorLogin = workspaceInput.contributorLogin ?? activeProfile.session?.login;
    if (!contributorLogin) throw new Error("contributorLogin is required for score breakdown.");
    const body = buildLocalScoreRequestBody(workspaceInput, contributorLogin);
    return toolResult("LoopOver private score breakdown.", await apiPost("/v1/scoring/explain-breakdown", body));
  },
);

registerStdioTool(
  "loopover_get_eligibility_plan",
  {
    description: stdioToolDescription("loopover_get_eligibility_plan"),
    inputSchema: localScoreShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const contributorLogin = workspaceInput.contributorLogin ?? activeProfile.session?.login;
    if (!contributorLogin) throw new Error("contributorLogin is required for the eligibility plan.");
    const body = buildLocalScoreRequestBody(workspaceInput, contributorLogin);
    return toolResult("LoopOver private eligibility plan.", await apiPost("/v1/scoring/eligibility-plan", body));
  },
);

registerStdioTool(
  "loopover_get_decision_pack",
  {
    description: stdioToolDescription("loopover_get_decision_pack"),
    inputSchema: loginShape,
  },
  async ({ login }) => {
    const payload = await getDecisionPackWithCache(login);
    return toolResult(decisionPackToolSummary(login, payload), payload);
  },
);

registerStdioTool(
  "loopover_explain_repo_decision",
  {
    description: stdioToolDescription("loopover_explain_repo_decision"),
    inputSchema: loginRepoShape,
  },
  async ({ login, owner, repo }) => {
    const payload = await getRepoDecisionWithCache(login, owner, repo);
    return toolResult(repoDecisionToolSummary(login, `${owner}/${repo}`, payload), payload);
  },
);

registerStdioTool(
  "loopover_monitor_open_prs",
  {
    description: stdioToolDescription("loopover_monitor_open_prs"),
    inputSchema: loginShape,
  },
  async ({ login }) => {
    const payload = await getOpenPrMonitor(login);
    return toolResult(openPrMonitorToolSummary(login, payload), payload);
  },
);

registerStdioTool(
  "loopover_compare_pr_variants",
  {
    description: stdioToolDescription("loopover_compare_pr_variants"),
    inputSchema: variantsShape,
  },
  async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const previews = [];
    for (const variant of variants) previews.push(await previewLocalScore(withWorkspaceRoots({ ...variant, targetKey: variant.targetKey ?? `variant:${previews.length + 1}` }, roots)));
    previews.sort((left, right) => Number(right?.remotePreview?.result?.effectiveEstimatedScore ?? right?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left?.remotePreview?.result?.effectiveEstimatedScore ?? left?.remotePreview?.result?.scoreEstimate?.estimatedMergedScore ?? 0));
    return toolResult("LoopOver PR variant comparison.", { variants: previews });
  },
);

registerStdioTool(
  "loopover_local_status",
  {
    description: stdioToolDescription("loopover_local_status"),
    inputSchema: {
      cwd: z.string().optional(),
      baseRef: z.string().optional(),
      repoFullName: z.string().min(3).optional(),
    },
  },
  async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
      git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    } catch (error) {
      git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    return toolResult("LoopOver local MCP status.", {
      apiUrl,
      package: {
        name: packageName,
        version: packageVersion,
      },
      hasToken: Boolean(getApiToken()),
      profile: profilePublicState(activeProfileName),
      authLogin: activeProfile.session?.login ?? null,
      sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
      sourceUploadDefault: false,
      sourceUploadSupported: false,
      workspaceRoots: workspaceRootStatus(workspaceInput.workspaceRoots),
      git,
    });
  },
);

registerStdioTool(
  "loopover_preflight_current_branch",
  {
    description: stdioToolDescription("loopover_preflight_current_branch"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver current-branch preflight.", {
      local: result.local,
      preflight: result.analysis.preflight,
      prPacket: result.analysis.prPacket,
      workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence),
    });
  },
);

registerStdioTool(
  "loopover_review_pr_before_push",
  {
    description: stdioToolDescription("loopover_review_pr_before_push"),
    inputSchema: currentBranchShape,
  },
  async (input) => toolResult("LoopOver pre-PR review.", await reviewLocalPr(await withClientWorkspaceRoots(input))),
);

registerStdioTool(
  "loopover_preview_current_branch_score",
  {
    description: stdioToolDescription("loopover_preview_current_branch_score"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver current-branch private score preview.", {
      local: result.local,
      scorePreview: result.analysis.scorePreview,
      scenarioScorePreview: result.analysis.scenarioScorePreview,
      scoreBlockers: result.analysis.scoreBlockers,
      recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
  },
);

registerStdioTool(
  "loopover_rank_local_next_actions",
  {
    description: stdioToolDescription("loopover_rank_local_next_actions"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver local next-action ranking.", { local: result.local, nextActions: result.analysis.nextActions, rewardRisk: result.analysis.rewardRisk, recommendedRerunCondition: result.analysis.recommendedRerunCondition });
  },
);

registerStdioTool(
  "loopover_explain_local_blockers",
  {
    description: stdioToolDescription("loopover_explain_local_blockers"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver local blocker explanation.", {
      local: result.local,
      scoreBlockers: result.analysis.scoreBlockers,
      branchQualityBlockers: result.analysis.branchQualityBlockers,
      accountStateBlockers: result.analysis.accountStateBlockers,
      baseFreshness: result.analysis.baseFreshness,
      localFindings: result.analysis.localFindings,
      recommendedRerunCondition: result.analysis.recommendedRerunCondition,
    });
  },
);

registerStdioTool(
  "loopover_remediation_plan",
  {
    description: stdioToolDescription("loopover_remediation_plan"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const workspaceInput = await withClientWorkspaceRoots(input);
    const payload = buildBranchAnalysisPayload({ ...workspaceInput, cwd: resolveWorkspaceCwd(workspaceInput).cwd });
    const { localScorerStatus: _localScorerStatus, ...body } = payload;
    return toolResult("LoopOver remediation plan.", await apiPost("/v1/local/remediation-plan", body));
  },
);

registerStdioTool(
  "loopover_prepare_pr_packet",
  {
    description: stdioToolDescription("loopover_prepare_pr_packet"),
    inputSchema: currentBranchShape,
  },
  async (input) => {
    const result = await analyzeCurrentBranch(await withClientWorkspaceRoots(input));
    return toolResult("LoopOver public-safe PR packet.", { local: result.local, prPacket: result.analysis.prPacket });
  },
);

registerStdioTool(
  "loopover_compare_local_variants",
  {
    description: stdioToolDescription("loopover_compare_local_variants"),
    inputSchema: currentBranchVariantsShape,
  },
  async ({ variants }) => {
    const roots = await clientWorkspaceRoots();
    const analyses = [];
    for (const variant of variants) analyses.push(await analyzeCurrentBranch(withWorkspaceRoots(variant, roots)));
    analyses.sort(
      (left, right) =>
        Number(right.analysis.nextActions?.[0]?.priorityScore ?? 0) - Number(left.analysis.nextActions?.[0]?.priorityScore ?? 0) ||
        Number(right.analysis.scorePreview?.effectiveEstimatedScore ?? right.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0) - Number(left.analysis.scorePreview?.effectiveEstimatedScore ?? left.analysis.scorePreview?.scoreEstimate?.estimatedMergedScore ?? 0),
    );
    return toolResult("LoopOver local variant comparison.", {
      variants: analyses.map((entry) => ({
        local: entry.local,
        preflightStatus: entry.analysis.preflight.status,
        scoreBlockers: entry.analysis.scoreBlockers,
        topAction: entry.analysis.nextActions?.[0] ?? null,
        prPacket: entry.analysis.prPacket,
      })),
    });
  },
);

registerStdioTool(
  "loopover_agent_plan_next_work",
  {
    description: stdioToolDescription("loopover_agent_plan_next_work"),
    inputSchema: agentPlanShape,
  },
  async (input) => toolResult(`LoopOver base-agent plan for ${input.login}.`, await apiPost("/v1/agent/plan-next-work", input)),
);

registerStdioTool(
  "loopover_agent_start_run",
  {
    description: stdioToolDescription("loopover_agent_start_run"),
    inputSchema: agentRunShape,
  },
  async (input) =>
    toolResult(
      `Queued LoopOver base-agent run for ${input.actorLogin}.`,
      await apiPost("/v1/agent/runs", {
        objective: input.objective,
        actorLogin: input.actorLogin,
        surface: "mcp",
        target: stripUndefined({
          repoFullName: input.targetRepoFullName,
          pullNumber: input.targetPullNumber,
          issueNumber: input.targetIssueNumber,
        }),
      }),
    ),
);

registerStdioTool(
  "loopover_agent_get_run",
  {
    description: stdioToolDescription("loopover_agent_get_run"),
    inputSchema: agentRunIdShape,
  },
  async ({ runId }) => toolResult(`LoopOver base-agent run ${runId}.`, await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`)),
);

registerStdioTool(
  "loopover_agent_explain_next_action",
  {
    description: stdioToolDescription("loopover_agent_explain_next_action"),
    inputSchema: agentPlanShape,
  },
  async (input) => {
    const result = await apiPost("/v1/agent/explain-blockers", input);
    return toolResult(`LoopOver base-agent next-action explanation for ${input.login}.`, {
      ...result,
      topAction: result.actions?.[0] ?? null,
    });
  },
);

registerStdioTool(
  "loopover_agent_prepare_pr_packet",
  {
    description: stdioToolDescription("loopover_agent_prepare_pr_packet"),
    inputSchema: currentBranchShape,
  },
  async (input) => toolResult("LoopOver base-agent public-safe PR packet.", await agentPreparePrPacket(await withClientWorkspaceRoots(input))),
);

// ── Output schemas for structured tool responses (#291) ──────────────────────

const repoContextOutputSchema = {
  type: "object",
  properties: {
    repoFullName: { type: "string" },
    lane: { type: "string" },
    primaryLanguage: { type: ["string", "null"] },
    openIssueCount: { type: "number" },
    openPrCount: { type: "number" },
  },
  additionalProperties: true,
};

const preflightOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["pass", "warn", "fail", "unknown"] },
    signals: { type: "array", items: { type: "object" } },
    summary: { type: "string" },
  },
  additionalProperties: true,
};

const decisionPackOutputSchema = {
  type: "object",
  properties: {
    login: { type: "string" },
    decisions: { type: "array", items: { type: "object" } },
    cachedAt: { type: ["string", "null"] },
  },
  additionalProperties: true,
};

const localStatusOutputSchema = {
  type: "object",
  properties: {
    apiUrl: { type: "string" },
    package: { type: "object", properties: { name: { type: "string" }, version: { type: "string" } }, additionalProperties: true },
    hasToken: { type: "boolean" },
    profile: { type: "object", additionalProperties: true },
    authLogin: { type: ["string", "null"] },
    sessionExpiresAt: { type: ["string", "null"] },
    sourceUploadDefault: { type: "boolean" },
    sourceUploadSupported: { type: "boolean" },
    git: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
};

const agentPlanOutputSchema = {
  type: "object",
  properties: {
    login: { type: "string" },
    actions: { type: "array", items: { type: "object" } },
    topAction: { type: ["object", "null"] },
  },
  additionalProperties: true,
};

// Attach outputSchema to key tools via registerTool with zod output schemas.
// All other tools continue to return unschematized text+structured content.

registerStdioTool(
  "loopover_local_status_structured",
  {
    description: stdioToolDescription("loopover_local_status_structured"),
    inputSchema: {
      cwd: z.string().optional(),
      baseRef: z.string().optional(),
      repoFullName: z.string().min(3).optional(),
    },
    outputSchema: z.object({
      apiUrl: z.string(),
      package: z.object({ name: z.string(), version: z.string() }),
      hasToken: z.boolean(),
      profile: z.record(z.unknown()),
      authLogin: z.string().nullable(),
      sessionExpiresAt: z.string().nullable(),
      sourceUploadDefault: z.boolean(),
      sourceUploadSupported: z.boolean(),
      git: z.record(z.unknown()),
    }),
  },
  async (input) => {
    let git = null;
    const workspaceInput = await withClientWorkspaceRoots(input);
    try {
      git = collectLocalBranchMetadata({ cwd: workspaceInput.cwd, baseRef: input.baseRef, repoFullName: input.repoFullName, login: "local", workspaceRoots: workspaceInput.workspaceRoots });
    } catch (error) {
      git = { error: error instanceof Error ? error.message : "local_status_failed" };
    }
    const data = {
      apiUrl,
      package: { name: packageName, version: packageVersion },
      hasToken: Boolean(getApiToken()),
      profile: profilePublicState(activeProfileName),
      authLogin: activeProfile.session?.login ?? null,
      sessionExpiresAt: activeProfile.session?.expiresAt ?? null,
      sourceUploadDefault: false,
      sourceUploadSupported: false,
      git: git ?? {},
    };
    return { content: [{ type: "text", text: `LoopOver local MCP status.\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data };
  },
);

registerStdioTool(
  "loopover_feasibility_gate",
  {
    description: stdioToolDescription("loopover_feasibility_gate"),
    inputSchema: feasibilityGateShape,
  },
  async ({ claimStatus, duplicateClusterRisk, issueStatus, found, repoFullName, issueNumber }) => {
    const ledgerClaimStatus = await resolveLedgerClaimStatus(repoFullName, issueNumber);
    return toolResult(
      "LoopOver feasibility gate.",
      buildFeasibilityVerdict({ claimStatus: ledgerClaimStatus ?? claimStatus, duplicateClusterRisk, issueStatus, found }),
    );
  },
);

// ── #6152 maintain surface: the REST calls maintainCli already makes, exposed as tools ───────────────────────
//
// These five mirror remote tools that have existed since #6087 but were never registered locally, so an agent on
// the stdio server had to shell out to the `maintain` CLI to reach them. Each one calls the same endpoint its
// CLI subcommand calls, through the same apiGet/apiPost/apiFetch client (auth, timeouts, and error shaping come
// from there) -- no new HTTP paths, and no behaviour the CLI doesn't already have.

/** `/v1/repos/:owner/:repo` for a tool's owner+repo input, matching maintainCli's own repoBase. */
function toolRepoBase(owner, repo) {
  return `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

registerStdioTool(
  "loopover_list_pending_actions",
  {
    description: stdioToolDescription("loopover_list_pending_actions"),
    inputSchema: listPendingActionsShape,
  },
  async ({ owner, repo }) => {
    const payload = await apiGet(`${toolRepoBase(owner, repo)}/agent/pending-actions`);
    return toolResult(`Agent approval queue for ${owner}/${repo}: ${(payload.pendingActions ?? []).length} pending.`, payload);
  },
);

registerStdioTool(
  "loopover_decide_pending_action",
  {
    description: stdioToolDescription("loopover_decide_pending_action"),
    inputSchema: decidePendingActionShape,
  },
  async ({ owner, repo, id, decision }) => {
    const payload = await apiPost(`${toolRepoBase(owner, repo)}/agent/pending-actions/${encodeURIComponent(id)}/${decision}`, {});
    return toolResult(`${decision === "accept" ? "Accepted" : "Rejected"} ${id}: ${payload.status ?? "ok"}.`, payload);
  },
);

registerStdioTool(
  "loopover_set_agent_paused",
  {
    description: stdioToolDescription("loopover_set_agent_paused"),
    inputSchema: setAgentPausedShape,
  },
  async ({ owner, repo, paused }) => {
    const payload = await apiFetch(`${toolRepoBase(owner, repo)}/settings`, { method: "PUT", body: JSON.stringify({ agentPaused: paused }) });
    return toolResult(`Agent actions ${paused ? "paused" : "resumed"} for ${owner}/${repo}.`, payload);
  },
);

registerStdioTool(
  "loopover_set_action_autonomy",
  {
    description: stdioToolDescription("loopover_set_action_autonomy"),
    inputSchema: setActionAutonomyShape,
  },
  async ({ owner, repo, action, level }) => {
    // Read-merge-write, exactly as `maintain set-level` does it: PUT /settings replaces the whole autonomy map,
    // so sending only this class would silently clear every other one.
    const base = toolRepoBase(owner, repo);
    const current = await apiGet(`${base}/settings`);
    const autonomy = { ...(current.autonomy ?? {}), [action]: level };
    const payload = await apiFetch(`${base}/settings`, { method: "PUT", body: JSON.stringify({ autonomy }) });
    return toolResult(`Set ${action} autonomy to ${level} for ${owner}/${repo}.`, payload);
  },
);

registerStdioTool(
  "loopover_get_gate_precision",
  {
    description: stdioToolDescription("loopover_get_gate_precision"),
    inputSchema: gatePrecisionShape,
  },
  async ({ owner, repo, windowDays }) => {
    // The schema already rejects a non-positive windowDays, so an omitted window is the only way to full history
    // -- matching the route's own behaviour when ?windowDays is absent.
    const query = windowDays ? `?windowDays=${encodeURIComponent(windowDays)}` : "";
    const payload = await apiGet(`${toolRepoBase(owner, repo)}/gate-precision${query}`);
    return toolResult(`Gate precision for ${owner}/${repo}.`, payload);
  },
  );
// ── Write-tools (#6149): pure LOCAL-execution spec builders. loopover NEVER performs the write -- each tool
// returns a spec the caller runs with its OWN gh creds. Brings the local stdio server to parity with the
// miner-auto-dev profile's recommendedTools, using the same @loopover/engine builders as the remote server.
function localWriteSpecResult(spec) {
  return toolResult(`${spec.action}: ${spec.description} ${spec.boundary}`, spec);
}

registerStdioTool(
  "loopover_open_pr",
  {
    description: stdioToolDescription("loopover_open_pr"),
    inputSchema: openPrShape,
  },
  (input) => localWriteSpecResult(buildOpenPrSpec(input)),
);

registerStdioTool(
  "loopover_file_issue",
  {
    description: stdioToolDescription("loopover_file_issue"),
    inputSchema: fileIssueShape,
  },
  (input) => localWriteSpecResult(buildFileIssueSpec(input)),
);

registerStdioTool(
  "loopover_apply_labels",
  {
    description: stdioToolDescription("loopover_apply_labels"),
    inputSchema: applyLabelsShape,
  },
  (input) => localWriteSpecResult(buildApplyLabelsSpec(input)),
);

registerStdioTool(
  "loopover_post_eligibility_comment",
  {
    description: stdioToolDescription("loopover_post_eligibility_comment"),
    inputSchema: postEligibilityCommentShape,
  },
  (input) => localWriteSpecResult(buildPostEligibilityCommentSpec(input)),
);

registerStdioTool(
  "loopover_create_branch",
  {
    description: stdioToolDescription("loopover_create_branch"),
    inputSchema: createBranchShape,
  },
  (input) => localWriteSpecResult(buildCreateBranchSpec(input)),
);

registerStdioTool(
  "loopover_delete_branch",
  {
    description: stdioToolDescription("loopover_delete_branch"),
    inputSchema: deleteBranchShape,
  },
  (input) => localWriteSpecResult(buildDeleteBranchSpec(input)),
);

registerStdioTool(
  "loopover_generate_tests",
  {
    description: stdioToolDescription("loopover_generate_tests"),
    inputSchema: testGenShape,
  },
  (input) => localWriteSpecResult(buildTestGenSpec(input)),
);

registerStdioTool(
  "loopover_file_follow_up_issue",
  {
    description: stdioToolDescription("loopover_file_follow_up_issue"),
    inputSchema: followUpIssueShape,
  },
  (input) => localWriteSpecResult(buildFollowUpIssueSpec(input)),
);

registerStdioTool(
  "loopover_close_pr",
  {
    description: stdioToolDescription("loopover_close_pr"),
    inputSchema: closePrShape,
  },
  (input) => localWriteSpecResult(buildClosePrSpec(input)),
);

// ── Resources: decision-pack, doctor, compatibility, changelog (#292) ─────────

server.registerResource(
  "loopover_changelog",
  "loopover://changelog",
  {
    title: "LoopOver MCP Changelog",
    description: "Current CHANGELOG.md for the installed loopover-mcp package.",
    mimeType: "text/markdown",
  },
  async () => {
    let text;
    try {
      text = readFileSync(changelogPath, "utf8");
    } catch {
      text = "Changelog not available.";
    }
    return { contents: [{ uri: "loopover://changelog", mimeType: "text/markdown", text }] };
  },
);

server.registerResource(
  "loopover_compatibility",
  "loopover://compatibility",
  {
    title: "LoopOver API Compatibility",
    description: "Current API compatibility state: version, supported methods, and any deprecation notices.",
    mimeType: "application/json",
  },
  async () => {
    let data;
    try {
      data = await apiGet(compatibilityPath);
    } catch {
      data = { status: "unavailable", currentApiVersion, packageVersion };
    }
    return { contents: [{ uri: "loopover://compatibility", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  },
);

// #6620: mirror the two remote static-document MCP resources over the local stdio server, proxying the new
// unauthenticated REST routes the same way loopover_compatibility proxies /v1/mcp/compatibility. Reuse the exact
// URIs the remote server registers.
server.registerResource(
  "loopover_finding_taxonomy",
  "loopover://finding-taxonomy",
  {
    title: "LoopOver Finding Taxonomy",
    description: "Static taxonomy of AI-review finding categories and the severity ladder.",
    mimeType: "application/json",
  },
  async () => {
    let data;
    try {
      data = await apiGet(findingTaxonomyPath);
    } catch {
      data = { status: "unavailable" };
    }
    return { contents: [{ uri: "loopover://finding-taxonomy", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerResource(
  "loopover_enrichment_analyzers",
  "loopover://enrichment-analyzers",
  {
    title: "LoopOver Enrichment Analyzers",
    description: "Static taxonomy of REES enrichment analyzers: names, categories, and cost classes.",
    mimeType: "application/json",
  },
  async () => {
    let data;
    try {
      data = await apiGet(enrichmentAnalyzersPath);
    } catch {
      data = { status: "unavailable" };
    }
    return { contents: [{ uri: "loopover://enrichment-analyzers", mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  },
);

server.registerResource(
  "loopover_decision_pack",
  new ResourceTemplate("loopover://decision-packs/{login}", { list: undefined }),
  {
    title: "LoopOver Decision Pack",
    description: "Cached private contributor decision pack for a GitHub login. Requires authentication.",
    mimeType: "application/json",
  },
  async (uri, { login }) => {
    const payload = await getDecisionPackWithCache(String(login));
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
  },
);

// ── Miner planning prompts (#293) ─────────────────────────────────────────────

server.registerPrompt(
  "loopover_miner_select_issue",
  {
    title: "Select Next Issue to Work On",
    description: "Guide a contributor through selecting the best open issue to work on next, using LoopOver lane and duplicate signals. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to help the contributor select the best open issue to work on next.",
            "Use the loopover_get_repo_context and loopover_agent_plan_next_work tools to fetch lane and queue signals.",
            "",
            "Guidelines:",
            "- Prefer issues that match the repo lane (feature, bug, docs, test, refactor, chore).",
            "- Avoid issues with existing open PRs unless the contributor owns one of them.",
            "- Flag duplicate or stale work before the contributor invests time.",
            "- Summarize the top 3 candidate issues with a short rationale for each.",
            "- Do not open, comment on, label, close, or modify any GitHub issue or PR.",
            "- Do not predict reward amounts, payout estimates, or public scoreability rankings.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_miner_draft_pr_packet",
  {
    title: "Draft PR Packet for Current Branch",
    description: "Guide a contributor through preparing a public-safe PR packet for the current branch. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to help the contributor prepare a public-safe PR packet for their current branch.",
            "Use loopover_preflight_current_branch or loopover_prepare_pr_packet to gather branch signals.",
            "",
            "Guidelines:",
            "- Draft a title, description, and label suggestions based on the diff metadata.",
            "- Flag any preflight warnings (duplicate work, missing linked issue, test coverage gaps).",
            "- Keep the draft public-safe: no private scoreability data, no raw trust scores.",
            "- Present the draft for the contributor to review and edit before opening a PR.",
            "- Do not open, comment on, label, close, or merge any GitHub PR.",
            "- Do not predict reward amounts or publish scoring predictions.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_miner_branch_preflight",
  {
    title: "Branch Preflight Check",
    description: "Run a preflight check on the current branch and summarize blockers for the contributor. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver miner planning assistant for ${login} working on ${repoFullName}.`,
            "",
            "Your job is to run a branch preflight check and explain any blockers clearly.",
            "Use loopover_explain_local_blockers and loopover_preflight_current_branch to fetch signals.",
            "",
            "Guidelines:",
            "- List each blocker with a plain-language explanation and suggested remediation.",
            "- Distinguish between hard blockers (will prevent merge) and soft warnings (worth fixing).",
            "- Do not open, comment on, label, close, or merge any GitHub PR.",
            "- Do not expose private scoreability details or raw trust scores in public-facing text.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_miner_cleanup_first",
  {
    title: "Cleanup-First Planning",
    description: "Help a contributor identify stale or low-value open PRs to close before opening new work. Advisory only.",
    argsSchema: {
      login: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ login }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver miner planning assistant for ${login}.`,
            "",
            "Your job is to help the contributor identify stale or low-value open PRs to close or supersede before opening new work.",
            "Use loopover_get_decision_pack to fetch the contributor decision pack.",
            "",
            "Guidelines:",
            "- List open PRs that are stale, duplicate, or conflicting with newer work.",
            "- Suggest which to close, which to rebase, and which to keep open.",
            "- Summarize the expected queue pressure impact of each decision.",
            "- Do not close, comment on, label, or merge any GitHub PR autonomously.",
            "- Do not predict reward amounts, payout estimates, or public scoring outcomes.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

// ── Maintainer and repo-owner workflow prompts (#294) ─────────────────────────

server.registerPrompt(
  "loopover_maintainer_queue_triage",
  {
    title: "Maintainer Queue Triage",
    description: "Guide a maintainer through triaging the open PR queue using LoopOver signals. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver maintainer assistant for ${repoFullName}.`,
            "",
            "Your job is to help the maintainer triage the open PR queue.",
            "Use loopover_get_repo_context to fetch current lane and queue signals.",
            "",
            "Guidelines:",
            "- Group PRs by: ready to review, needs changes, stale, duplicate.",
            "- Flag PRs with missing linked issues, failing checks, or low-quality diffs.",
            "- Suggest a review order based on lane fit and contributor history.",
            "- Prepare review notes and questions for the maintainer to post manually.",
            "- Do not post comments, approve, request changes, label, close, or merge any PR autonomously.",
            "- Do not expose private scoreability details, raw trust scores, or private reviewer context.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_maintainer_review_prep",
  {
    title: "Maintainer Review Preparation",
    description: "Prepare a structured review packet for a specific PR. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      pullNumber: z.string().min(1).describe("PR number to prepare a review for."),
    },
  },
  ({ repoFullName, pullNumber }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver maintainer assistant for ${repoFullName}.`,
            "",
            `Your job is to prepare a structured review packet for PR #${pullNumber}.`,
            "Use loopover_preflight_pr or loopover_explain_repo_decision to fetch relevant signals.",
            "",
            "Guidelines:",
            "- Summarize the PR scope, changed files, and linked issue (if any).",
            "- List preflight signals: lane fit, duplicate risk, test coverage, queue pressure.",
            "- Draft review questions or change requests for the maintainer to post manually.",
            "- Keep all output public-safe: no private scoreability data or raw trust scores.",
            "- Do not post review comments, approve, request changes, label, close, or merge the PR.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_maintainer_public_guidance",
  {
    title: "Maintainer Public Guidance Draft",
    description: "Draft low-noise, public-safe guidance for a contributor based on their PR. Advisory only — no GitHub writes.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
      contributorLogin: z.string().min(1).describe("GitHub login of the contributor."),
    },
  },
  ({ repoFullName, contributorLogin }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver maintainer assistant for ${repoFullName}.`,
            "",
            `Your job is to draft low-noise, public-safe guidance for contributor ${contributorLogin}.`,
            "Use loopover_get_repo_context for lane context.",
            "",
            "Guidelines:",
            "- Draft a short, encouraging, actionable comment the maintainer can post manually.",
            "- Focus on what the contributor should change, not on scoring or reward prediction.",
            "- Keep the tone neutral and constructive — no compensation language.",
            "- Do not mention trust scores, hotkeys, coldkeys, wallet addresses, reward estimates, or private reviewability.",
            "- Do not post the comment autonomously — present it for the maintainer to review and post.",
            "- Do not close, label, merge, or modify the PR autonomously.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_repo_owner_intake_readiness",
  {
    title: "Repo Owner Intake Readiness",
    description: "Guide a repo owner through assessing contributor intake readiness using LoopOver signals. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner assess contributor intake readiness.",
            "Use loopover_get_repo_context to fetch lane and queue signals.",
            "",
            "Guidelines:",
            "- Summarize current lane health: open issue count, PR queue pressure, merge rate.",
            "- Flag gaps in the CONTRIBUTING.md, issue templates, or lane focus manifest.",
            "- Recommend intake improvements the repo owner can make manually.",
            "- Do not autonomously edit repo files, post comments, or open/close issues or PRs.",
            "- Do not expose private scoreability data or raw trust scores publicly.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_repo_owner_focus_manifest_review",
  {
    title: "Repo Owner Focus Manifest Review",
    description: "Help a repo owner review and improve their focus manifest using LoopOver policy signals. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner review and improve their LoopOver focus manifest.",
            "Use loopover_get_repo_context to fetch current policy and lane signals.",
            "",
            "Guidelines:",
            "- Identify gaps or inconsistencies in the focus manifest.",
            "- Suggest improvements to label policy, contribution lanes, and readiness criteria.",
            "- Draft an updated manifest section for the repo owner to review and apply manually.",
            "- Do not autonomously push changes to the repo or open PRs.",
            "- Do not expose private scoreability data or raw trust scores.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.registerPrompt(
  "loopover_repo_owner_onboarding_pack",
  {
    title: "Repo Owner Onboarding Pack Planning",
    description: "Help a repo owner plan and draft an onboarding pack for new contributors. Advisory only.",
    argsSchema: {
      repoFullName: z.string().min(3).describe("Target repository in owner/repo format."),
    },
  },
  ({ repoFullName }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            `You are a LoopOver repo-owner assistant for ${repoFullName}.`,
            "",
            "Your job is to help the repo owner plan and draft an onboarding pack for new contributors.",
            "Use loopover_get_repo_context to fetch lane and policy signals.",
            "",
            "Guidelines:",
            "- Draft an onboarding overview: repo purpose, contribution lanes, good-first-issue guidance.",
            "- Suggest CONTRIBUTING.md sections, issue templates, and label conventions to add or improve.",
            "- Keep all content public-safe: no private scoreability, raw trust, or reward prediction.",
            "- Present the draft for the repo owner to review and apply manually.",
            "- Do not autonomously push changes, open PRs, or post comments.",
            "- Do not request wallet, hotkey, coldkey, private keys, or tokens.",
          ].join("\n"),
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());

async function withClientWorkspaceRoots(input) {
  return withWorkspaceRoots(input, await clientWorkspaceRoots());
}

function withWorkspaceRoots(input, roots) {
  return roots.length > 0 ? { ...input, workspaceRoots: roots } : input;
}

async function clientWorkspaceRoots() {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const result = await server.server.listRoots(undefined, { timeout: 1000 });
    return Array.isArray(result.roots) ? result.roots : [];
  } catch {
    return [];
  }
}

function workspaceRootStatus(roots) {
  const count = Array.isArray(roots) ? roots.length : 0;
  return {
    available: count > 0,
    count,
    pathsIncluded: false,
  };
}

function printMaintainHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp maintain <subcommand> --repo owner/repo",
      "",
      "Maintainer controls for the agent auto-maintain layer (requires maintainer access; run `loopover-mcp login`).",
      "",
      "Subcommands:",
      "  status                       List the agent approval queue (auto_with_approval actions awaiting a decision).",
      "  queue                        List pending actions (id, kind, target) for approve/reject. Alias: pending.",
      "  approve <id>                 Approve a staged action -> execute it.",
      "  reject <id>                  Reject a staged action -> cancel it.",
      "  pause                        Pause ALL agent actions on the repo (kill-switch).",
      "  resume                       Resume agent actions on the repo.",
      "  set-level <action> <level>   Set the autonomy level for one action class.",
      `                               actions: ${MAINTAIN_ACTION_CLASSES.join(", ")}`,
      `                               levels:  ${MAINTAIN_AUTONOMY_LEVELS.join(", ")}`,
      "  precision [--window-days N]  Show gate false-positive telemetry (blocked-then-merged per gate type).",
      "  onboarding-pack [--refresh]  Preview the repo's contributor onboarding pack.",
      "  audit-feed [--since ISO]     Show the agent audit feed (who did what, when).",
      "             [--limit N]       Cap the events returned (1-200).",
      "             [--pull N]        Scope the feed to one pull request.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

// #784 maintainer CLI controls — thin proxies over the agent approval-queue API (#779) and the maintainer
// settings kill-switch (#130). The API enforces maintainer authorization; the CLI never decides locally.
async function maintainCli(args) {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "help") return printMaintainHelp();
  const positional = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const options = parseOptions(args.slice(1));
  const repoFullName = options.repo;
  if (!repoFullName || !repoFullName.includes("/")) throw new Error("Pass --repo owner/repo.");
  const [owner, repo] = repoFullName.split("/", 2);
  const repoBase = `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const queueBase = `${repoBase}/agent/pending-actions`;
  const emit = (payload, line) => {
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`${line}\n`);
  };
  if (subcommand === "status") {
    const payload = await apiGet(queueBase);
    const actions = payload.pendingActions ?? [];
    // #6261: every field here is the API's. `emit` sends this string to the terminal only on the plain-text path
    // (--json re-serializes `payload` instead), so sanitizing the composed line costs the JSON contract nothing.
    emit(
      payload,
      [
        `Agent approval queue for ${repoFullName}: ${actions.length} pending.`,
        ...actions.map(
          (action) =>
            `- ${sanitizePlainTextTerminalOutput(action.id)}  ${sanitizePlainTextTerminalOutput(action.actionClass)} on #${sanitizePlainTextTerminalOutput(action.pullNumber)}  ${sanitizePlainTextTerminalOutput(action.reason ?? "")}`,
        ),
      ].join("\n"),
    );
    return;
  }
  // #2236 — explicit queue listing so maintainers can discover ids for approve/reject (alias: pending).
  if (subcommand === "queue" || subcommand === "pending") {
    const payload = await apiGet(queueBase);
    const actions = payload.pendingActions ?? [];
    emit(
      payload,
      [
        `Pending agent actions for ${repoFullName}: ${actions.length}.`,
        ...actions.map((action) => {
          // #6261: sanitize each field as it is read, so the fallback chains can't smuggle an escape in through
          // whichever branch happens to win (`kind` alone has three sources).
          const kind = sanitizePlainTextTerminalOutput(action.actionClass ?? action.kind ?? "unknown");
          const target = action.pullNumber != null ? `#${sanitizePlainTextTerminalOutput(action.pullNumber)}` : sanitizePlainTextTerminalOutput(action.target ?? "—");
          const summary = sanitizePlainTextTerminalOutput(action.reason ?? action.summary ?? "");
          return `- ${sanitizePlainTextTerminalOutput(action.id)}  ${kind}  ${target}${summary ? `  ${summary}` : ""}`;
        }),
      ].join("\n"),
    );
    return;
  }
  if (subcommand === "approve" || subcommand === "reject") {
    if (!positional) throw new Error(`Pass the pending-action id: loopover-mcp maintain ${subcommand} <id> --repo owner/repo.`);
    // The approval-queue route's decision verb is accept|reject (#779); the CLI exposes approve|reject.
    const decision = subcommand === "approve" ? "accept" : "reject";
    const payload = await apiPost(`${queueBase}/${encodeURIComponent(positional)}/${decision}`, {});
    emit(payload, `${subcommand === "approve" ? "Accepted" : "Rejected"} ${positional}: ${payload.status ?? "ok"}${payload.executionOutcome ? ` (${payload.executionOutcome})` : ""}.`);
    return;
  }
  if (subcommand === "pause" || subcommand === "resume") {
    const payload = await apiFetch(`${repoBase}/settings`, { method: "PUT", body: JSON.stringify({ agentPaused: subcommand === "pause" }) });
    emit(payload, `Agent actions ${subcommand === "pause" ? "paused" : "resumed"} for ${repoFullName}.`);
    return;
  }
  if (subcommand === "set-level") {
    const action = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
    const level = args[2] && !args[2].startsWith("--") ? args[2] : undefined;
    if (!action || !level) throw new Error("Usage: loopover-mcp maintain set-level <action> <level> --repo owner/repo.");
    if (!MAINTAIN_ACTION_CLASSES.includes(action)) throw new Error(`Unknown action: ${action}. Use ${MAINTAIN_ACTION_CLASSES.join(", ")}.`);
    if (!MAINTAIN_AUTONOMY_LEVELS.includes(level)) throw new Error(`Unknown level: ${level}. Use ${MAINTAIN_AUTONOMY_LEVELS.join(", ")}.`);
    // Read-merge-write so one class is updated without clearing the others.
    const current = await apiGet(`${repoBase}/settings`);
    const autonomy = { ...(current.autonomy ?? {}), [action]: level };
    const payload = await apiFetch(`${repoBase}/settings`, { method: "PUT", body: JSON.stringify({ autonomy }) });
    emit(payload, `Set ${action} autonomy to ${level} for ${repoFullName}.`);
    return;
  }
  if (subcommand === "precision") {
    // #554 gate false-positive telemetry: read-only measurement of blocked-then-merged PRs per gate type.
    // The API enforces maintainer authorization; the CLI never decides locally. Optional --window-days bounds
    // the block ledger the same way the route's ?windowDays query does (a non-positive value falls through to
    // full history server-side).
    const windowDays = Number(options.windowDays);
    const query = windowDays > 0 ? `?windowDays=${encodeURIComponent(windowDays)}` : "";
    const payload = await apiGet(`${repoBase}/gate-precision${query}`);
    const overall = payload.overall ?? {};
    const window = payload.windowDays ? `last ${payload.windowDays}d` : "all history";
    const rate = (value) => (value === null || value === undefined ? "n/a (below sample)" : `${Math.round(value * 100)}%`);
    const lines = [
      `Gate precision for ${repoFullName} (${window}): ${overall.blocked ?? 0} blocked, ${overall.blockedThenMerged ?? 0} blocked-then-merged, false-positive rate ${rate(overall.falsePositiveRate)}.`,
      ...(payload.perGateType ?? []).map(
        (type) => `- ${type.gateType}: ${type.blocked} blocked, ${type.blockedThenMerged} merged anyway${type.falsePositiveRate === null ? "" : ` (${Math.round(type.falsePositiveRate * 100)}% FP)`}`,
      ),
      ...(payload.signals ?? []),
    ];
    emit(payload, lines.join("\n"));
    return;
  }
  if (subcommand === "onboarding-pack") {
    // #6738: session-authenticated mirror of GET /onboarding-pack/preview (and the remote
    // loopover_get_repo_onboarding_pack tool). Bare `--refresh` becomes options.refresh === true via
    // parseOptions; omit the query otherwise so the default matches the precision-style GET pattern
    // (server treats only the exact string "true" as a refresh).
    const query = options.refresh === true ? "?refresh=true" : "";
    const payload = await apiGet(`${repoBase}/onboarding-pack/preview${query}`);
    emit(
      payload,
      [
        `LoopOver onboarding pack preview for ${repoFullName} (preview-only, not published).`,
        sanitizePlainTextTerminalOutput(JSON.stringify(payload.preview ?? payload, null, 2)),
      ].join("\n"),
    );
    return;
  }
  if (subcommand === "audit-feed") {
    // #6733: read-only mirror of GET {repoBase}/agent/audit-feed (the same surface the remote
    // loopover_get_agent_audit_feed tool exposes). The API enforces maintainer authorization and validates
    // every query param -- `since` must be ISO-8601, `limit` 1..200, `pull` a positive integer -- so the CLI
    // forwards them verbatim rather than re-deciding locally, and a bad value surfaces as the API's own 400
    // detail. Omitted flags are omitted from the query entirely, so the route applies its own defaults.
    const query = new URLSearchParams();
    if (options.since !== undefined) query.set("since", String(options.since));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.pull !== undefined) query.set("pull", String(options.pull));
    const payload = await apiGet(`${repoBase}/agent/audit-feed${query.size > 0 ? `?${query}` : ""}`);
    const events = payload.events ?? [];
    // `pullNumber` is echoed by the route only on the ?pull= branch, so the scope line reports what was asked for.
    const scope = payload.pullNumber ? `${repoFullName}#${payload.pullNumber}` : repoFullName;
    emit(
      payload,
      [
        `Agent audit feed for ${scope}: ${events.length} event${events.length === 1 ? "" : "s"}.`,
        // `detail` is the one free-form field here; sanitized on the plain-text path like onboarding-pack's
        // dump above (--json re-serializes `payload` untouched, so the JSON contract is unaffected).
        ...events.map((event) =>
          sanitizePlainTextTerminalOutput([event.createdAt, event.eventType, event.actor, event.outcome, event.detail].filter(Boolean).join("  ")),
        ),
      ].join("\n"),
    );
    return;
  }
  throw new Error(
    `Unknown maintain subcommand: ${subcommand}. Use status | queue | approve <id> | reject <id> | pause | resume | set-level <action> <level> | precision | onboarding-pack | audit-feed.`,
  );
}

async function runCli(args) {
  const command = args[0];
  if (command === "--help" || command === "help") return printHelp();
  if (command === "--version" || command === "-v" || command === "version") return printVersion(parseOptions(args.slice(1)));
  if (command === "completion") return completionCommand(args.slice(1));
  if (command === "tools") return toolsCommand(args.slice(1));
  if (command === "agent") return runAgentCli(args.slice(1));
  if (command === "cache") return runCacheCli(args.slice(1));
  if (command === "maintain") return maintainCli(args.slice(1));
  if (command === "telemetry") return telemetryCommand(args.slice(1));
  const options = parseOptions(args.slice(1));
  if (command === "login") return login(options);
  if (command === "logout") return logout(options);
  if (command === "profile" || command === "profiles") return profileCommand(args.slice(1));
  if (command === "whoami") return whoami(options);
  if (command === "config") return configCommand(options);
  if (command === "status") return status(options);
  if (command === "changelog") return changelog(options);
  if (command === "doctor") return doctor(options);
  if (command === "init-client") return initClient(options);
  if (command === "lint-pr-text") return lintPrTextCli(args.slice(1));
  if (command === "validate-config") return validateConfigCli(args.slice(1));
  if (command === "slop-risk") return slopRiskCli(args.slice(1));
  if (command === "issue-slop") return issueSlopCli(args.slice(1));
  if (command === "decision-pack") return decisionPackCli(options);
  if (command === "repo-decision") return repoDecisionCli(options);
  if (command === "monitor-open-prs") return monitorOpenPrsCli(options);
  if (command === "review-pr") return reviewPrCli(options);
  if (command !== "analyze-branch" && command !== "preflight") {
    const suggestion = suggestCommand(command);
    throw new Error(`Unknown command: ${command}.${suggestion ? ` Did you mean \`${suggestion}\`?` : ""} Run \`loopover-mcp --help\` to list commands.`);
  }
  // Match every other subcommand: honor --help before requiring --login / hitting git+network (#6256).
  if (options.help === true) return printHelp();
  const contributorLogin = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!contributorLogin) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
  const result = await analyzeCurrentBranch({
    login: contributorLogin,
    cwd: options.cwd,
    repoFullName: options.repo,
    baseRef: options.base,
    title: options.title,
    body: options.body,
    labels: options.label,
    linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
    pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
    pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
    approvedPrCount: optionalInteger(options.approvedPrs),
    expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
    projectedCredibility: optionalNumber(options.projectedCredibility),
    scenarioNotes: options.scenarioNote,
    branchEligibility: branchEligibilityFromOptions(options),
    validation: validationFromOptions(options),
    scorePreviewCommand: options.scorePreviewCommand,
  });
  const payload =
    command === "preflight"
      ? { local: result.local, preflight: result.analysis.preflight, prPacket: result.analysis.prPacket, workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence) }
      : result;
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (options.format === "table") {
    writeBranchAnalysisTable(result, command);
    return;
  }
  writeBranchAnalysisCli(result, command);
}

// Render the report-shaped branch analysis (next actions, plus score blockers for analyze-branch) as
// aligned monospace tables when `--format table` is passed. Default and `--json` output are untouched.
function writeBranchAnalysisTable(result, command) {
  const analysis = result.analysis;
  const actionRows = (analysis.nextActions ?? []).map((action) => ({
    action: action.actionKind ?? "—",
    priority: action.priorityScore === undefined || action.priorityScore === null ? "—" : String(action.priorityScore),
    why: (action.whyThisHelps ?? []).join("; ") || "—",
  }));
  process.stdout.write(
    `${formatTable(
      { headers: [{ key: "action", label: "Action" }, { key: "priority", label: "Priority", align: "right" }, { key: "why", label: "Why this helps" }], rows: actionRows },
    )}\n`,
  );
  if (command === "analyze-branch" && analysis.scoreBlockers?.length) {
    process.stdout.write("\n");
    process.stdout.write(`${formatTable({ headers: [{ key: "blocker", label: "Score blocker" }], rows: analysis.scoreBlockers.map((blocker) => ({ blocker })) })}\n`);
  }
}

function printReviewPrHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp review-pr --login <github-login> [--repo owner/repo] [--base origin/main] [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]",
      "",
      "Compose the existing preflight + slop-risk + PR-text-lint checks into ONE pre-PR review report,",
      "so a contributor's own local agent can see everything the loopover gate would flag before ever opening a PR.",
      "Mirrors the loopover_review_pr_before_push MCP tool. Thin composition only — does not reimplement any check. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function reviewPrCli(options) {
  if (options.help === true) return printReviewPrHelp();
  const contributorLogin = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!contributorLogin) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
  let prBody = options.body;
  if (options.bodyFile) prBody = readCliTextFile(options.bodyFile, "Body");
  const commitMessages = Array.isArray(options.commit) ? options.commit : options.commit ? [options.commit] : undefined;
  const linkedIssue = parsePositiveIntegerOption(options.linkedIssue, "--linked-issue");
  const payload = await reviewLocalPr({
    login: contributorLogin,
    cwd: options.cwd,
    repoFullName: options.repo,
    baseRef: options.base,
    title: options.title,
    body: prBody,
    labels: options.label,
    commitMessages,
    linkedIssues: linkedIssue !== undefined ? [linkedIssue] : options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Pre-PR review: ${payload.overallStatus}\n`);
  for (const section of payload.sections) process.stdout.write(`- ${section.name}: ${section.status}\n`);
  process.stdout.write(`Preflight: ${payload.preflight.status}\n`);
  if (payload.slopRisk) process.stdout.write(`Slop risk: ${payload.slopRisk.slopRisk} (${payload.slopRisk.band})\n`);
  else if (payload.slopRiskError) process.stdout.write(`Slop risk: unavailable (${payload.slopRiskError})\n`);
  if (payload.prTextLint) process.stdout.write(`PR text lint: ${payload.prTextLint.verdict} (score ${payload.prTextLint.score})\n`);
  else if (payload.prTextLintError) process.stdout.write(`PR text lint: unavailable (${payload.prTextLintError})\n`);
}

// Opens, type-checks, and reads the file through ONE file descriptor rather than a separate
// stat-then-read pair: a check-then-read on a path string leaves a race window where a symlink or
// special file (FIFO, device) can be swapped in between the two calls, letting the earlier
// isFile()/size validation apply to a different, unvalidated file than the one actually read.
// O_NOFOLLOW makes a symlinked path fail to open outright instead of silently following it.
function readCliTextFile(path, label) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`${label} file not found: ${path}`);
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) throw new Error(`${label} file must be a regular file: ${path}`);
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`${label} file must be a regular file: ${path}`);
    if (stats.size > cliTextFileMaxBytes) throw new Error(`${label} file is too large: ${path} (max ${cliTextFileMaxBytes} bytes)`);
    // Bound the READ itself rather than trusting stats.size alone: a regular file can grow between fstatSync
    // and the read below (the fd is the same, but nothing stops another process from appending to the file
    // in between), so read at most cliTextFileMaxBytes + 1 bytes directly from the descriptor and fail if that
    // cap is exceeded, instead of handing the now-possibly-stale size to an unbounded readFileSync.
    const buffer = Buffer.alloc(cliTextFileMaxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const n = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (n === 0) break;
      bytesRead += n;
    }
    if (bytesRead > cliTextFileMaxBytes) throw new Error(`${label} file is too large: ${path} (max ${cliTextFileMaxBytes} bytes)`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function printLintPrTextHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp lint-pr-text [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]",
      "",
      "Lint a commit message and PR body against the LoopOver traceability and Conventional Commit rubric.",
      "Mirrors the loopover_lint_pr_text MCP tool and POST /v1/lint/pr-text. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function lintPrTextCli(args) {
  if (!args.length || args[0] === "--help" || args[0] === "help") return printLintPrTextHelp();
  const options = parseOptions(args);
  const commitMessages = Array.isArray(options.commit) ? options.commit : options.commit ? [options.commit] : undefined;
  let prBody = options.body;
  if (options.bodyFile) {
    prBody = readCliTextFile(options.bodyFile, "Body");
  }
  const linkedIssue = parsePositiveIntegerOption(options.linkedIssue, "--linked-issue");
  const payload = await apiPost("/v1/lint/pr-text", {
    ...(commitMessages?.length ? { commitMessages } : {}),
    ...(prBody !== undefined ? { prBody } : {}),
    ...(linkedIssue !== undefined ? { linkedIssue } : {}),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`PR text lint: ${payload.verdict} (score ${payload.score})\n`);
  process.stdout.write(`${payload.summary}\n`);
  for (const fix of payload.fixes ?? []) process.stdout.write(`- ${fix}\n`);
}

// Strip ANSI escapes + control characters from text this CLI prints as plain text. Rule (#6261): every value that
// reaches a terminal from a source the user does not control -- an API response, or free text the API echoed back
// from a third-party issue/PR -- goes through this first. Otherwise a hostile string can repaint the screen,
// rewrite earlier lines, or fake a success next to a real failure, since the terminal cannot tell our text from
// the payload's.
//
// Two things deliberately do NOT go through it:
//   - `--json` output. JSON.stringify escapes U+001B (and the rest of U+0000-U+001F) as a \u001b literal, so an escape
//     sequence cannot survive into the printed document -- and sanitizing there would corrupt the machine-readable
//     contract callers parse.
//   - Our own literals, and values the user themself passed in (--login, --repo). Those are already the user's,
//     and the CLI prints no colour of its own -- there is no intentional ANSI in this file to preserve.
function sanitizePlainTextTerminalOutput(value) {
  return String(value)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*(?:\x1b\\)|[@-_])/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function printValidateConfigHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp validate-config --file <path> [--source repo_file|api_record|none] [--json]",
      "",
      "Validate a .loopover.yml manifest before pushing.",
      "Mirrors the loopover_validate_config MCP tool and POST /v1/validate/focus-manifest. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function validateConfigCli(args) {
  if (!args.length || args[0] === "--help" || args[0] === "help") return printValidateConfigHelp();
  const options = parseOptions(args);
  if (!options.file) throw new Error("Pass --file <path> to the manifest to validate.");
  const content = readCliTextFile(options.file, "Manifest");
  const source = options.source;
  if (source !== undefined && !["repo_file", "api_record", "none"].includes(String(source))) {
    throw new Error("--source must be one of: repo_file, api_record, none");
  }
  const payload = await apiPost("/v1/validate/focus-manifest", {
    content,
    ...(source !== undefined ? { source } : {}),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`Manifest validation: ${payload.status}\n`);
  process.stdout.write(`present=${payload.present}\n`);
  for (const warning of payload.warnings ?? []) process.stdout.write(`- ${sanitizePlainTextTerminalOutput(warning)}\n`);
}

function printSlopRiskHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp slop-risk [--description <text>] [--description-file <path>] [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--json]",
      "",
      "Assess deterministic slop risk from local diff metadata and a PR description.",
      "Mirrors the loopover_check_slop_risk MCP tool and POST /v1/lint/slop-risk. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

function stringArrayOption(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function parseChangedFileSpec(raw) {
  const [path, additions, deletions] = String(raw).split(":");
  if (!path) throw new Error(`Invalid --changed-file value: ${raw}`);
  const entry = { path };
  if (additions !== undefined && additions !== "") {
    const parsedAdditions = Number(additions);
    if (!Number.isInteger(parsedAdditions) || parsedAdditions < 0) throw new Error(`Invalid additions in --changed-file: ${raw}`);
    entry.additions = parsedAdditions;
  }
  if (deletions !== undefined && deletions !== "") {
    const parsedDeletions = Number(deletions);
    if (!Number.isInteger(parsedDeletions) || parsedDeletions < 0) throw new Error(`Invalid deletions in --changed-file: ${raw}`);
    entry.deletions = parsedDeletions;
  }
  return entry;
}

async function slopRiskCli(args) {
  if (!args.length || args[0] === "--help" || args[0] === "help") return printSlopRiskHelp();
  const options = parseOptions(args);
  let description = options.description ?? options.body;
  const descriptionFile = options.descriptionFile ?? options.bodyFile;
  if (descriptionFile) {
    description = readCliTextFile(descriptionFile, "Description");
  }
  const changedFiles = stringArrayOption(options.changedFile).map(parseChangedFileSpec);
  const tests = stringArrayOption(options.test);
  const testFiles = stringArrayOption(options.testFile);
  const payload = await apiPost("/v1/lint/slop-risk", {
    ...(changedFiles.length ? { changedFiles } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(tests.length ? { tests } : {}),
    ...(testFiles.length ? { testFiles } : {}),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // #6261: the whole payload is the API's, so the score line is sanitized alongside the findings -- leaving `band`
  // raw would keep this exact command exploitable by the exact response the findings are being protected from.
  process.stdout.write(`Slop risk: ${sanitizePlainTextTerminalOutput(payload.slopRisk)} (${sanitizePlainTextTerminalOutput(payload.band)})\n`);
  for (const finding of payload.findings ?? [])
    process.stdout.write(`- ${sanitizePlainTextTerminalOutput(finding.title)}: ${sanitizePlainTextTerminalOutput(finding.detail)}\n`);
}

function printIssueSlopHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp issue-slop [--title <text>] [--body <text>] [--body-file <path>] [--json]",
      "",
      "Assess deterministic issue slop risk from an issue title and body alone.",
      "Mirrors the loopover_check_issue_slop MCP tool and POST /v1/lint/issue-slop. Advisory only; no source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function issueSlopCli(args) {
  if (!args.length || args[0] === "--help" || args[0] === "help") return printIssueSlopHelp();
  const options = parseOptions(args);
  let body = normalizeOptionalStringOption(options.body);
  if (options.bodyFile) {
    body = readCliTextFile(options.bodyFile, "Body");
  }
  const title = normalizeOptionalStringOption(options.title);
  const payload = await apiPost("/v1/lint/issue-slop", {
    ...(title !== undefined ? { title } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // #6261: same as slop-risk, and the sharper case of the two -- the body being assessed is routinely a THIRD
  // party's issue text, so a hostile issue is the expected input here, not a hypothetical one.
  process.stdout.write(`Issue slop risk: ${sanitizePlainTextTerminalOutput(payload.slopRisk)} (${sanitizePlainTextTerminalOutput(payload.band)})\n`);
  for (const finding of payload.findings ?? [])
    process.stdout.write(`- ${sanitizePlainTextTerminalOutput(finding.title)}: ${sanitizePlainTextTerminalOutput(finding.detail)}\n`);
}

function printDecisionPackHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp decision-pack --login <github-login> [--json]",
      "",
      "Fetch the cached (or freshly built) contributor decision pack for a GitHub login.",
      "Mirrors the loopover_get_decision_pack MCP tool and GET /v1/contributors/{login}/decision-pack. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function decisionPackCli(options) {
  if (options.help === true) return printDecisionPackHelp();
  const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!login) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
  const payload = await getDecisionPackWithCache(login);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // #6261: decisionPackToolSummary is left alone -- verified, not assumed. It interpolates `login` (the user's own
  // --login/env value) and `payload.freshness`, and freshness only ever reaches the string inside an equality guard
  // against the literals "stale"/"rebuilding", so the API cannot route text of its own choosing through it.
  process.stdout.write(`${decisionPackToolSummary(login, payload)}\n`);
  if (payload.summary) process.stdout.write(`${sanitizePlainTextTerminalOutput(payload.summary)}\n`);
  if (payload.cache?.rerunGuidance) process.stdout.write(`Rerun when: ${sanitizePlainTextTerminalOutput(payload.cache.rerunGuidance)}\n`);
}

function printMonitorOpenPrsHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp monitor-open-prs --login <github-login> [--json]",
      "",
      "Review your open PRs across registered repos: queue classification and next steps per PR.",
      "Mirrors the loopover_monitor_open_prs MCP tool and GET /v1/contributors/{login}/open-pr-monitor. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function monitorOpenPrsCli(options) {
  if (options.help === true) return printMonitorOpenPrsHelp();
  const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!login) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
  const payload = await getOpenPrMonitor(login);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // #6261: every value below is the API's to choose -- the summary/guidance it composes, and PR titles it echoes
  // back from third-party repos -- so all of it is sanitized before it reaches the terminal. `login` is the user's
  // own --login/env value and needs no sanitizing, but it only reaches stdout via the literal fallback branch.
  process.stdout.write(`${sanitizePlainTextTerminalOutput(openPrMonitorToolSummary(login, payload))}\n`);
  for (const line of payload?.guidance ?? []) process.stdout.write(`${sanitizePlainTextTerminalOutput(line)}\n`);
  for (const pr of payload?.pullRequests ?? []) {
    const heading = `${pr.repoFullName}#${pr.number} [${pr.classification}] ${pr.title}`;
    process.stdout.write(`${sanitizePlainTextTerminalOutput(heading)}\n`);
    for (const step of pr.nextSteps ?? []) process.stdout.write(`  - ${sanitizePlainTextTerminalOutput(step)}\n`);
  }
}

function printRepoDecisionHelp() {
  process.stdout.write(
    [
      "Usage: loopover-mcp repo-decision --login <github-login> --repo owner/repo [--json]",
      "",
      "Fetch the cached (or freshly built) repo decision for a GitHub login and repo.",
      "Mirrors the loopover_explain_repo_decision MCP tool. No source upload.",
      "",
      "Pass --json for machine-readable output.",
    ].join("\n") + "\n",
  );
}

async function repoDecisionCli(options) {
  if (options.help === true) return printRepoDecisionHelp();
  const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
  if (!login) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
  const repoFullName = options.repo;
  if (!repoFullName || !repoFullName.includes("/")) throw new Error("Pass --repo owner/repo.");
  const [owner, repo] = repoFullName.split("/", 2);
  const payload = await getRepoDecisionWithCache(login, owner, repo);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  // #6261: repoDecisionToolSummary is left alone for the same reason -- it interpolates only `login` and
  // `repoFullName`, both of which the user typed on their own command line. No payload text reaches it.
  process.stdout.write(`${repoDecisionToolSummary(login, repoFullName, payload)}\n`);
  const actions = payload.decision?.nextActions ?? payload.decision?.publicNextActions ?? [];
  for (const action of actions.slice(0, 3)) process.stdout.write(`- ${sanitizePlainTextTerminalOutput(action)}\n`);
  if (payload.cache?.rerunGuidance) process.stdout.write(`Rerun when: ${sanitizePlainTextTerminalOutput(payload.cache.rerunGuidance)}\n`);
}

function runCacheCli(args) {
  const subcommand = args[0] ?? "help";
  if (subcommand === "--help" || subcommand === "help") return printCacheHelp();
  const options = parseOptions(args.slice(1));
  if (subcommand === "clear") {
    const payload = clearDecisionPackCache();
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Cleared ${payload.removed} decision-pack cache entr${payload.removed === 1 ? "y" : "ies"}.\n`);
    return;
  }
  if (subcommand === "status") {
    const payload = inspectDecisionPackCache();
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Decision-pack cache: ${payload.entries} entr${payload.entries === 1 ? "y" : "ies"}.\n`);
    return;
  }
  if (subcommand === "list" || subcommand === "ls") {
    const payload = listDecisionPackCache();
    if (emitList(options, payload.entries, payload)) return;
    if (payload.count === 0) process.stdout.write("Decision-pack cache is empty.\n");
    else for (const entry of payload.entries) process.stdout.write(`- ${entry.login ?? "unknown"} (cached ${entry.cachedAt ?? "unknown"}, ${entry.bytes} bytes)\n`);
    return;
  }
  throw new Error(`Unknown cache command: ${subcommand}`);
}

async function runAgentCli(args) {
  const subcommand = args[0] ?? "help";
  if (subcommand === "--help" || subcommand === "help") return printAgentHelp();
  const options = parseOptions(args.slice(1));
  if (subcommand === "plan") {
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const payload = await apiPost("/v1/agent/plan-next-work", stripUndefined({ login, repoFullName: options.repo, objective: options.objective, surface: "mcp" }));
    return outputAgentPayload(payload, options, `LoopOver agent plan: ${payload.summary ?? payload.run?.status ?? "ready"}`);
  }
  if (subcommand === "status") {
    const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
    if (!runId) throw new Error("Usage: loopover-mcp agent status <run-id>");
    const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    return outputAgentPayload(payload, options, `LoopOver agent run ${runId}: ${payload.run?.status ?? "unknown"}`);
  }
  if (subcommand === "explain") {
    const runId = args[1] && !args[1].startsWith("--") ? args[1] : options.runId;
    if (!runId) throw new Error("Usage: loopover-mcp agent explain <run-id>");
    const payload = await apiGet(`/v1/agent/runs/${encodeURIComponent(runId)}`);
    const topAction = payload.actions?.[0] ?? null;
    return outputAgentPayload({ ...payload, topAction }, options, topAction ? `Top action: ${topAction.recommendation}` : "No top action is available yet.");
  }
  if (subcommand === "packet") {
    const login = options.login ?? process.env.LOOPOVER_LOGIN ?? process.env.GITHUB_LOGIN;
    if (!login) throw new Error("Pass --login <github-login> or set LOOPOVER_LOGIN.");
    const payload = await agentPreparePrPacket({
      login,
      cwd: options.cwd,
      repoFullName: options.repo,
      baseRef: options.base,
      title: options.title,
      body: options.body,
      labels: options.label,
      linkedIssues: options.issue?.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0),
      pendingMergedPrCount: optionalInteger(options.pendingMergedPrs),
      pendingClosedPrCount: optionalInteger(options.pendingClosedPrs),
      approvedPrCount: optionalInteger(options.approvedPrs),
      expectedOpenPrCountAfterMerge: optionalInteger(options.expectedOpenPrs),
      projectedCredibility: optionalNumber(options.projectedCredibility),
      scenarioNotes: options.scenarioNote,
      branchEligibility: branchEligibilityFromOptions(options),
      validation: validationFromOptions(options),
      scorePreviewCommand: options.scorePreviewCommand,
    });
    return outputAgentPayload(payload, options, "LoopOver public-safe PR packet prepared.");
  }
  throw new Error(`Unknown agent command: ${subcommand}`);
}

function outputAgentPayload(payload, options, summary) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const packetMarkdown = payload?.prPacket?.markdown ?? payload?.actions?.find((action) => action?.actionType === "prepare_pr_packet")?.payload?.prPacket?.markdown;
  if (typeof packetMarkdown === "string" && packetMarkdown.trim()) {
    const safeMarkdown = requirePublicSafePacketMarkdown(packetMarkdown);
    return process.stdout.write(safeMarkdown.endsWith("\n") ? safeMarkdown : `${safeMarkdown}\n`);
  }
  process.stdout.write(`${summary}\n`);
  if (payload.summary && payload.summary !== summary) process.stdout.write(`${payload.summary}\n`);
  if (payload.recommendedRerunCondition) process.stdout.write(`Rerun when: ${payload.recommendedRerunCondition}\n`);
  const actions = payload.actions ?? payload.nextActions ?? [];
  for (const action of actions.slice(0, 3)) {
    const label = action.actionType ?? action.actionKind ?? action.recommendation ?? "action";
    const detail = action.recommendation ?? action.actionKind ?? action.summary ?? label;
    process.stdout.write(`- ${label}: ${detail}\n`);
    if (action.explanationCard) {
      process.stdout.write(`  why now: ${action.explanationCard.whyNow}\n`);
      process.stdout.write(`  impact: ${action.explanationCard.expectedImpact}\n`);
      process.stdout.write(`  rerun: ${action.explanationCard.rerunWhen}\n`);
    } else if (action.rerunWhen) {
      process.stdout.write(`  rerun: ${action.rerunWhen}\n`);
    }
  }
}

function writeBranchAnalysisCli(result, command) {
  const analysis = result.analysis;
  const intelligence = command === "preflight" ? publicSafeWorkspaceIntelligence(analysis.workspaceIntelligence) : analysis.workspaceIntelligence;
  process.stdout.write(`${analysis.summary}\n`);
  process.stdout.write(`Top action: ${analysis.nextActions?.[0]?.actionKind ?? "none"}\n`);
  if (analysis.nextActions?.[0]?.whyThisHelps?.length) {
    process.stdout.write("Why this helps:\n");
    for (const line of analysis.nextActions[0].whyThisHelps.slice(0, 3)) process.stdout.write(`- ${line}\n`);
  }
  if (intelligence) writeWorkspaceIntelligenceCli(intelligence);
  if (command === "analyze-branch" && analysis.scoreBlockers?.length) {
    process.stdout.write("Score blockers:\n");
    for (const blocker of analysis.scoreBlockers.slice(0, 5)) process.stdout.write(`- ${blocker}\n`);
  }
  process.stdout.write(`Preflight: ${analysis.preflight.status}\n`);
  process.stdout.write(`Source upload: disabled\n`);
  if (result.local?.localScorerStatus?.ok === false) {
    process.stdout.write(`Local scorer: ${result.local.localScorerStatus.code ?? "metadata_only"}\n`);
    for (const line of result.local.setupGuidance ?? setupGuidanceForLocalScorer(result.local.localScorerStatus)) {
      process.stdout.write(`- ${line}\n`);
    }
  }
}

function writeWorkspaceIntelligenceCli(intelligence) {
  process.stdout.write(`Workspace intelligence v${intelligence.version}:\n`);
  const files = intelligence.changedFiles;
  process.stdout.write(`- Changed files: ${files.total} (${files.binary} binary, ${files.deleted} deleted, ${files.renamed} renamed)\n`);
  process.stdout.write(`- Test evidence: ${intelligence.testEvidence.level}\n`);
  if (intelligence.branch.pendingCommitCount > 0) {
    process.stdout.write(`- Pending commits ahead of base: ${intelligence.branch.pendingCommitCount}\n`);
  }
  if (intelligence.baseFreshness.status !== "fresh") {
    process.stdout.write(`- Base freshness: ${intelligence.baseFreshness.status}\n`);
    for (const warning of intelligence.baseFreshness.warnings.slice(0, 2)) process.stdout.write(`  ${warning}\n`);
  }
  if (intelligence.blockers.branchQuality.length) {
    process.stdout.write("- Branch-quality blockers:\n");
    for (const blocker of intelligence.blockers.branchQuality.slice(0, 4)) process.stdout.write(`  - ${blocker}\n`);
  }
  if (intelligence.blockers.accountState.length) {
    process.stdout.write("- Account/queue blockers:\n");
    for (const blocker of intelligence.blockers.accountState.slice(0, 4)) process.stdout.write(`  - ${blocker}\n`);
  }
  if (intelligence.ciStatusHints.length) {
    process.stdout.write("- CI hints:\n");
    for (const hint of intelligence.ciStatusHints.slice(0, 3)) process.stdout.write(`  - ${hint}\n`);
  }
  process.stdout.write(`- Rerun when: ${intelligence.rerunWhen}\n`);
}

function publicSafeWorkspaceIntelligence(intelligence) {
  if (!intelligence) return intelligence;
  return {
    ...intelligence,
    blockers: {
      ...intelligence.blockers,
      accountState: [],
    },
    rerunWhen: publicSafeRerunWhen(intelligence),
  };
}

function publicSafeRerunWhen(intelligence) {
  if (intelligence.baseFreshness?.status === "stale" || intelligence.baseFreshness?.status === "possibly_stale") {
    return "Run `git fetch origin` and rerun; current diff size may be inflated by stale base state.";
  }
  if (intelligence.blockers?.branchQuality?.length) {
    return "Rerun after fixing branch-quality blockers or adding explicit validation/linked-context evidence.";
  }
  return "Rerun after any branch, base, or PR state changes before opening/submitting.";
}

function requirePublicSafePacketMarkdown(markdown) {
  const unsafeLine = markdown.split(/\r?\n/).find((line) => isUnsafePublicPacketText(line));
  if (unsafeLine) throw new Error("Refusing to print unsafe public packet markdown from the server.");
  return markdown;
}

function isUnsafePublicPacketText(value) {
  return /\b(reward\w*|score\w*|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|raw[-_\s]?trust|trust[-_\s]?score|private[-_\s]?reviewability|reviewability)\b|\/Users\/|\/home\/|\/tmp\/|[A-Z]:[\\/]Users[\\/]/i.test(value);
}

function printVersion(options) {
  const payload = { name: packageName, version: packageVersion, apiVersion: currentApiVersion, node: process.version };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${packageName}/${packageVersion} (api ${currentApiVersion}, node ${process.version})\n`);
}

function toolsCommand(args) {
  const subcommand = args[0];
  if (subcommand === "search") return toolsSearchCommand(args.slice(1));
  const options = parseOptions(args);
  const tools = STDIO_TOOL_DESCRIPTORS.map(({ name, category, description }) => ({ name, category, description }));
  // Group tools by category in the canonical order; any category with no tools is omitted, and a tool
  // whose category is unknown falls into a trailing "Other" bucket so nothing is silently dropped.
  const knownIds = new Set(STDIO_TOOL_CATEGORIES.map((entry) => entry.id));
  const groups = [
    ...STDIO_TOOL_CATEGORIES.map((entry) => ({ ...entry, tools: tools.filter((tool) => tool.category === entry.id) })),
    { id: "other", label: "Other", tools: tools.filter((tool) => !knownIds.has(tool.category)) },
  ].filter((group) => group.tools.length > 0);
  if (options.json) {
    const payload = {
      count: tools.length,
      categories: groups.map((group) => ({ id: group.id, label: group.label, count: group.tools.length })),
      tools,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 0);
  groups.forEach((group, index) => {
    if (index > 0) process.stdout.write("\n");
    process.stdout.write(`${group.label} (${group.tools.length})\n`);
    for (const tool of group.tools) {
      process.stdout.write(`  ${tool.name.padEnd(nameWidth)}  ${tool.description}\n`);
    }
  });
}

// `tools search <query>` — fuzzy discovery across the ~150-tool combined surface (#6300). Matches the
// query against each registered tool's name AND description (not name-only), so "stake" surfaces
// get_subnet_stake_quote even though "stake" is only in its description. Reuses this CLI's existing
// levenshteinDistance for typo tolerance rather than pulling in a fuzzy-match dependency.
function toolsSearchCommand(args) {
  const options = parseOptions(args);
  const query = args.find((arg) => !arg.startsWith("--"));
  if (!query) throw new Error("Usage: loopover-mcp tools search <query> [--json]");
  const tools = searchTools(query);
  const payload = { query, count: tools.length, tools };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  if (tools.length === 0) {
    process.stdout.write(`No tools match "${query}".\n`);
    return;
  }
  printToolRows(tools);
}

function printToolRows(tools) {
  const nameWidth = tools.reduce((width, tool) => Math.max(width, tool.name.length), 0);
  for (const tool of tools) {
    process.stdout.write(`${tool.name.padEnd(nameWidth)}  ${tool.description}\n`);
  }
}

// Rank registered tools by how well they match the query, best first. A substring hit on the name beats
// a substring hit on the description, which beats a typo-tolerant (Levenshtein) hit on any name/description
// token; tools that match none of these are dropped. Ties break alphabetically for a stable listing.
function searchTools(query) {
  const needle = query.toLowerCase();
  const scored = [];
  for (const { name, description } of STDIO_TOOL_DESCRIPTORS) {
    const score = scoreToolMatch(needle, name.toLowerCase(), description.toLowerCase());
    if (score !== null) scored.push({ name, description, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return scored.map(({ name, description }) => ({ name, description }));
}

function scoreToolMatch(needle, name, description) {
  if (name.includes(needle)) return 0;
  if (description.includes(needle)) return 1;
  // Typo tolerance: compare the query to each name/description token, allowing a small edit distance that
  // scales with the query length (a longer query tolerates more typos, a very short one stays exact-ish).
  const budget = Math.max(1, Math.floor(needle.length / 4));
  let best = Infinity;
  for (const token of `${name} ${description}`.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    const distance = levenshteinDistance(needle, token);
    if (distance < best) best = distance;
  }
  return best <= budget ? 2 + best : null;
}

function completionCommand(args) {
  const shell = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const options = parseOptions(args.filter((arg) => arg.startsWith("--")));
  if (!shell) throw new Error(`Usage: loopover-mcp completion <${COMPLETION_SHELLS.join("|")}> [--json]`);
  if (!COMPLETION_SHELLS.includes(shell)) throw new Error(`Unsupported shell: ${shell}. Supported shells: ${COMPLETION_SHELLS.join(", ")}.`);
  const script = buildCompletionScript(shell);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ shell, script }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${script}\n`);
}

function buildCompletionScript(shell) {
  const topLevel = [...Object.keys(CLI_COMMAND_SPEC), "help"];
  const withSubcommands = Object.entries(CLI_COMMAND_SPEC).filter(([, subcommands]) => subcommands.length > 0);
  if (shell === "bash") return buildBashCompletion(topLevel, withSubcommands);
  if (shell === "zsh") return buildZshCompletion(topLevel, withSubcommands);
  if (shell === "fish") return buildFishCompletion(topLevel, withSubcommands);
  return buildPowershellCompletion(topLevel, withSubcommands);
}

// Suggest the closest known command for a typo, so an unknown command can offer a "did you mean".
// Only suggests within a small edit-distance budget that scales with input length, so unrelated
// input gets no (misleading) suggestion.
function suggestCommand(input) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of Object.keys(CLI_COMMAND_SPEC)) {
    const distance = levenshteinDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  const budget = Math.max(2, Math.floor(input.length / 3));
  return best !== null && bestDistance > 0 && bestDistance <= budget ? best : null;
}

function levenshteinDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function buildBashCompletion(topLevel, withSubcommands) {
  const subcommandCases = withSubcommands
    .map(([command, subcommands]) => `      ${command}) COMPREPLY=( $(compgen -W "${subcommands.join(" ")}" -- "$cur") ); return 0;;`)
    .join("\n");
  return `# loopover-mcp bash completion. Add to ~/.bashrc:
#   source <(loopover-mcp completion bash)
_loopover_mcp() {
  local cur prev cword
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cword=\$COMP_CWORD
  local commands="${topLevel.join(" ")}"
  if [ "\$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "\$commands --help --version" -- "$cur") )
    return 0
  fi
  case "\${COMP_WORDS[1]}" in
${subcommandCases}
      *) COMPREPLY=( $(compgen -W "--json --format --login --repo --profile --agent-profile --base --cwd" -- "$cur") ); return 0;;
  esac
}
complete -F _loopover_mcp loopover-mcp`;
}

function buildZshCompletion(topLevel, withSubcommands) {
  const subcommandCases = withSubcommands
    .map(([command, subcommands]) => `      ${command}) _values 'subcommand' ${subcommands.join(" ")} ;;`)
    .join("\n");
  return `#compdef loopover-mcp
# loopover-mcp zsh completion. Add to your fpath, or:
#   source <(loopover-mcp completion zsh)
_loopover_mcp() {
  local -a commands
  commands=(${topLevel.join(" ")})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case $words[2] in
${subcommandCases}
  esac
}
_loopover_mcp "$@"`;
}

function buildFishCompletion(topLevel, withSubcommands) {
  const topLevelLines = topLevel
    .map((command) => `complete -c loopover-mcp -n __fish_use_subcommand -a ${command} -d 'loopover-mcp command'`)
    .join("\n");
  const subcommandLines = withSubcommands
    .map(([command, subcommands]) => `complete -c loopover-mcp -n '__fish_seen_subcommand_from ${command}' -a '${subcommands.join(" ")}'`)
    .join("\n");
  return `# loopover-mcp fish completion. Save to:
#   ~/.config/fish/completions/loopover-mcp.fish
${topLevelLines}
${subcommandLines}`;
}

function buildPowershellCompletion(topLevel, withSubcommands) {
  const commandList = topLevel.map((command) => `'${command}'`).join(", ");
  const subcommandEntries = withSubcommands
    .map(([command, subcommands]) => `    '${command}' = @(${subcommands.map((subcommand) => `'${subcommand}'`).join(", ")})`)
    .join("\n");
  return `# loopover-mcp PowerShell completion. Add to your $PROFILE:
#   loopover-mcp completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName loopover-mcp -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${commandList})
  $subcommands = @{
${subcommandEntries}
  }
  $elements = $commandAst.CommandElements
  if ($elements.Count -le 2) {
    $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
    return
  }
  $sub = $subcommands[[string]$elements[1].Value]
  if ($sub) {
    $sub | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
      [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
    }
  }
}`;
}

function printHelp() {
  process.stdout.write(`Usage:
  loopover-mcp --stdio
  loopover-mcp version [--json]
  loopover-mcp tools [--json]
  loopover-mcp tools search <query> [--json]
  loopover-mcp completion bash|zsh|fish|powershell [--json]
  loopover-mcp login [--profile name] [--github-token <token>] [--json]
  loopover-mcp logout [--profile name] [--all] [--json]
  loopover-mcp whoami [--profile name] [--json]
  loopover-mcp config [--profile name] [--json]
  loopover-mcp status [--profile name] [--json]
  loopover-mcp telemetry enable|disable|status [--json]
  loopover-mcp profile list|create|switch|remove [name] [--json]
  loopover-mcp changelog [--json]
  loopover-mcp doctor [--profile name] [--cwd path] [--exit-code] [--json]
  loopover-mcp cache status|list|clear [--json]
  loopover-mcp init-client --print codex|claude|cursor|mcp|vscode [--agent-profile miner-planner|maintainer-triage|repo-owner-intake] [--json]
  loopover-mcp decision-pack --login <github-login> [--json]
  loopover-mcp repo-decision --login <github-login> --repo owner/repo [--json]
  loopover-mcp monitor-open-prs --login <github-login> [--json]
  loopover-mcp analyze-branch --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--scenario-note "..."] [--validation "passed|npm test|summary"] [--format table] [--json]
  loopover-mcp preflight --login <github-login> [--repo owner/repo] [--base origin/main] [--branch-eligibility eligible|ineligible|unknown] [--pending-merged-prs 3] [--expected-open-prs 0] [--projected-credibility 0.8] [--validation "passed|npm test|summary"] [--format table] [--json]
  loopover-mcp review-pr --login <github-login> [--repo owner/repo] [--base origin/main] [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]
  loopover-mcp lint-pr-text [--commit <message>]... [--body <text>] [--body-file <path>] [--linked-issue <number>] [--json]
  loopover-mcp validate-config --file <path> [--source repo_file|api_record|none] [--json]
  loopover-mcp slop-risk [--description <text>] [--description-file <path>] [--changed-file <path[:additions:deletions]>]... [--test <command>]... [--test-file <path>]... [--json]
  loopover-mcp issue-slop [--title <text>] [--body <text>] [--body-file <path>] [--json]
  loopover-mcp agent plan --login <github-login> [--repo owner/repo] [--json]
  loopover-mcp agent status <run-id> [--json]
  loopover-mcp agent explain <run-id> [--json]
  loopover-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--json]

  Environment:
  LOOPOVER_API_URL
  LOOPOVER_PROFILE
  LOOPOVER_CONFIG_PATH or LOOPOVER_CONFIG_DIR
  LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, LOOPOVER_TOKEN, or a session from loopover-mcp login
  LOOPOVER_LOGIN or GITHUB_LOGIN (default --login for analyze-branch, preflight, review-pr, decision-pack, repo-decision, monitor-open-prs, and agent plan/packet)
  GITHUB_TOKEN for non-interactive login bootstrap
  GITTENSOR_SCORE_PREVIEW_CMD
  GITTENSOR_ROOT
  GITTENSOR_SCORE_PREVIEW_TIMEOUT_MS
  LOOPOVER_UPLOAD_SOURCE=false
`);
}

function printCacheHelp() {
  process.stdout.write(`Usage:
  loopover-mcp cache status [--json]
  loopover-mcp cache list [--json | --format ndjson]
  loopover-mcp cache clear [--json]

Decision-pack cache entries are local-only stale fallbacks for temporary API/network outages.
Source upload remains disabled.
`);
}

function printAgentHelp() {
  process.stdout.write(`Usage:
  loopover-mcp agent plan --login <github-login> [--repo owner/repo] [--objective "..."] [--json]
  loopover-mcp agent status <run-id> [--json]
  loopover-mcp agent explain <run-id> [--json]
  loopover-mcp agent packet --login <github-login> [--repo owner/repo] [--base origin/main] [--validation "passed|command|summary"] [--json]

The agent is copilot-only: it ranks, explains, and drafts public-safe packets. It does not edit code, open PRs, or post comments from the local MCP wrapper.
Source upload remains disabled.
  `);
}

function printProfileHelp() {
  process.stdout.write(`Usage:
  loopover-mcp profile list [--json | --format ndjson]
  loopover-mcp profile create <name> [--json]
  loopover-mcp profile switch <name> [--json]
  loopover-mcp profile remove <name> [--json]

Use --profile <name> or LOOPOVER_PROFILE to run login, logout, whoami, status, doctor, and MCP API calls with a named local session.
`);
}

function parseOptions(args) {
  const options = {};
  const repeatable = new Set(["label", "issue", "commit", "changedFile", "test", "testFile", "validation", "validationCommand", "validationStatus", "validationSummary", "validationDuration", "scenarioNote"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!arg?.startsWith("--")) {
      // A bare `help` positional means the same thing as `--help` (#6257): the option-consuming commands
      // (decision-pack/repo-decision/review-pr) only check `options.help === true`, so without this a
      // dashless `loopover-mcp decision-pack help` fell through to a confusing "Pass --login…" error instead
      // of printing usage — while the raw-args commands (lint-pr-text etc.) already special-cased it. A `help`
      // consumed as a `--key value` value is skipped via `index += 1` below, so only a STANDALONE `help` here.
      if (arg === "help") options.help = true;
      continue;
    }
    // Support the inline `--key=value` form (e.g. `--format=table`) alongside the space-separated
    // `--key value` form; splitting here keeps every existing space-separated option unchanged (#2231).
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      const inlineKey = camel(arg.slice(2, equals));
      const inlineValue = arg.slice(equals + 1);
      if (repeatable.has(inlineKey)) options[inlineKey] = [...(options[inlineKey] ?? []), inlineValue];
      else options[inlineKey] = inlineValue;
      continue;
    }
    const key = camel(arg.slice(2));
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    if (repeatable.has(key)) options[key] = [...(options[key] ?? []), value];
    else options[key] = value;
  }
  return options;
}

// Shared machine-readable output for list-shaped commands. `--format ndjson` streams one JSON object per
// array element per line (for piping into jq/log processors); `--json` (or `--format json`) keeps the
// existing pretty object. Returns true when it emitted a machine-readable format, so the caller skips the
// human view. Each record ends in "\n" and Node flushes stdout on exit, so piped output is not truncated.
function emitList(options, items, pretty) {
  if (options.format === "ndjson") {
    for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
    return true;
  }
  if (options.json || options.format === "json") {
    process.stdout.write(`${JSON.stringify(pretty, null, 2)}\n`);
    return true;
  }
  return false;
}

async function login(options) {
  const profileName = selectedProfileName(options);
  const githubToken = options.githubToken ?? process.env.GITHUB_TOKEN;
  const session = githubToken ? await apiFetch("/v1/auth/github/session", { method: "POST", body: JSON.stringify({ githubToken }) }, { auth: false }) : await loginWithDeviceFlow();
  const nextConfig = upsertProfile(config, profileName, {
    apiUrl,
    session: {
      token: session.token,
      login: session.login,
      expiresAt: session.expiresAt,
      scopes: session.scopes ?? [],
    },
  });
  saveConfig(nextConfig);
  const payload = { status: "authenticated", profile: profileName, login: session.login, apiUrl, expiresAt: session.expiresAt };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`Authenticated profile ${profileName} as ${session.login}. Session expires ${session.expiresAt}.\n`);
}

async function loginWithDeviceFlow() {
  const start = await apiFetch("/v1/auth/github/device/start", { method: "POST", body: "{}" }, { auth: false });
  process.stderr.write(`Open ${start.verificationUri} and enter code ${start.userCode}.\n`);
  const deadline = Date.now() + Number(start.expiresIn ?? 900) * 1000;
  let intervalMs = Math.max(5, Number(start.interval ?? 5)) * 1000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    let result;
    try {
      result = await apiFetch("/v1/auth/github/device/poll", { method: "POST", body: JSON.stringify({ deviceCode: start.deviceCode }) }, { auth: false });
    } catch (error) {
      // A transient 429 from our own rate limiter (#6792) is not a GitHub-reported device-flow status --
      // back off using the server's Retry-After and keep polling within the deadline, the same posture
      // already applied to GitHub's own "slow_down" status below, instead of aborting the whole attempt.
      if (error?.status === 429) {
        const retryAfterSeconds = Number(/retry-after=(\d+)s/.exec(error.message)?.[1]);
        intervalMs = Math.max(intervalMs, (Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 5) * 1000);
        continue;
      }
      throw error;
    }
    if (result.token) return result;
    if (result.status === "slow_down") intervalMs += 5000;
    if (result.status && result.status !== "authorization_pending" && result.status !== "slow_down") throw new Error(`GitHub OAuth failed: ${result.status}`);
  }
  throw new Error("GitHub OAuth device flow expired.");
}

async function logout(options) {
  const profileName = selectedProfileName(options);
  const all = options.all === true;
  const envToken = getEnvApiToken();
  const tokens = all
    ? [envToken, ...profileSessions(config).map((entry) => entry.session.token)].filter(Boolean)
    : [envToken ?? configuredProfileToken(profileName)].filter(Boolean);
  const remote = [];
  for (const token of [...new Set(tokens)]) {
    try {
      remote.push(await apiFetch("/v1/auth/logout", { method: "POST", body: "{}" }, { token }));
    } catch (error) {
      remote.push({ error: sanitizeDiagnosticText(error instanceof Error ? error.message : "logout_failed") });
    }
  }
  const nextConfig = all ? clearAllProfileSessions(config) : clearProfileSession(config, profileName);
  if (hasPersistedConfigState(nextConfig)) saveConfig(nextConfig);
  else if (existsSync(configPath)) rmSync(configPath, { force: true });
  const decisionPackCache = clearDecisionPackCache();
  const payload = { status: "logged_out", profile: all ? "all" : profileName, apiUrl, remote: remote.length > 0 ? remote : null, decisionPackCache };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(all ? "Logged out all profiles.\n" : `Logged out profile ${profileName}.\n`);
}

// Local MCP usage telemetry is opt-in and defaults OFF (#6239, per #6228's privacy decision): a
// self-hoster must explicitly enable it before anything is measured. The opt-in is a single top-level
// `telemetryEnabled` flag persisted in the same config file `login` uses, so the choice survives across
// CLI invocations; `status`, `doctor`, and `config` all report the current state.
function telemetryCommand(args) {
  const subcommand = args[0] ?? "status";
  const options = parseOptions(args.slice(1));
  if (subcommand === "--help" || subcommand === "help") return printTelemetryHelp();
  if (subcommand === "enable" || subcommand === "disable") {
    const enabled = subcommand === "enable";
    const nextConfig = setTelemetryEnabled(config, enabled);
    // Mirror login/logout persistence: keep the file when any durable state remains, otherwise remove it
    // so disabling telemetry on an otherwise-empty config leaves no stray file behind.
    if (hasPersistedConfigState(nextConfig)) saveConfig(nextConfig);
    else if (existsSync(configPath)) rmSync(configPath, { force: true });
    const payload = { status: enabled ? "telemetry_enabled" : "telemetry_disabled", telemetry: telemetryState(nextConfig) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(enabled ? "Local MCP usage telemetry enabled.\n" : "Local MCP usage telemetry disabled.\n");
    return;
  }
  if (subcommand === "status") {
    const telemetry = telemetryState(config);
    if (options.json) process.stdout.write(`${JSON.stringify({ telemetry }, null, 2)}\n`);
    else process.stdout.write(`Telemetry: ${telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
    return;
  }
  throw new Error(`Unknown telemetry command: ${subcommand}. Use enable | disable | status.`);
}

function printTelemetryHelp() {
  process.stdout.write(`Usage:
  loopover-mcp telemetry status [--json]
  loopover-mcp telemetry enable [--json]
  loopover-mcp telemetry disable [--json]

Local MCP usage telemetry is opt-in and defaults OFF. Enabling it persists a top-level telemetryEnabled
flag in the same config file \`loopover-mcp login\` uses, so the choice survives across CLI invocations.
\`status\`, \`doctor\`, and \`config\` report the current opt-in state.
`);
}

function profileCommand(args) {
  const subcommand = args[0] ?? "list";
  const options = parseOptions(args.slice(1));
  if (subcommand === "--help" || subcommand === "help") return printProfileHelp();
  if (subcommand === "list" || subcommand === "ls") {
    const profiles = profileList(config);
    const payload = { activeProfile: activeProfileName, profiles };
    if (emitList(options, profiles, payload)) return;
    process.stdout.write(`Active profile: ${activeProfileName}\n`);
    for (const profile of profiles) {
      process.stdout.write(`- ${profile.name}${profile.active ? " (active)" : ""}: ${profile.login ?? "not authenticated"}\n`);
    }
    return;
  }

  const rawName = args[1] && !args[1].startsWith("--") ? args[1] : options.name ?? options.profile;
  if (!rawName) throw new Error(`Usage: loopover-mcp profile ${subcommand} <name>`);
  const profileName = normalizeProfileName(rawName);

  if (subcommand === "create") {
    const nextConfig = ensureProfile(config, profileName, { activate: true });
    saveConfig(nextConfig);
    const payload = { status: "created", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Created and selected profile ${profileName}.\n`);
    return;
  }

  if (subcommand === "switch" || subcommand === "use") {
    if (!config.profiles?.[profileName]) throw new Error(`Profile ${profileName} does not exist. Run \`loopover-mcp profile create ${profileName}\` or \`loopover-mcp login --profile ${profileName}\`.`);
    const nextConfig = setActiveProfile(config, profileName);
    saveConfig(nextConfig);
    const payload = { status: "switched", activeProfile: profileName, profile: profilePublicState(profileName, nextConfig) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Selected profile ${profileName}.\n`);
    return;
  }

  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const nextConfig = removeProfile(config, profileName);
    if (hasPersistedConfigState(nextConfig)) saveConfig(nextConfig);
    else if (existsSync(configPath)) rmSync(configPath, { force: true });
    const payload = { status: "removed", removedProfile: profileName, activeProfile: nextConfig.activeProfile ?? defaultProfileName };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stdout.write(`Removed profile ${profileName}.\n`);
    return;
  }

  throw new Error(`Unknown profile command: ${subcommand}`);
}

async function whoami(options) {
  const payload = { ...(await apiGet("/v1/auth/session")), profile: activeProfileName };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(activeProfileName === defaultProfileName ? `${payload.login}\n` : `${payload.login} (profile ${activeProfileName})\n`);
}

async function status(options) {
  let auth = { status: getApiToken() ? "token_configured" : "unauthenticated" };
  let health = null;
  if (getApiToken()) {
    try {
      auth = await apiGet("/v1/auth/session");
    } catch (error) {
      auth = { status: "token_configured", session: "unverified", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "status_failed") };
    }
  }
  try {
    health = await apiFetch("/health", { method: "GET" }, { auth: false, timeoutMs: 5000 });
  } catch (error) {
    health = { status: "unreachable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "health_check_failed") };
  }
  const compatibility = await inspectApiCompatibility(health);
  const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
  const apiCompatibility = compatibility.evaluation;
  const decisionPackCache = inspectDecisionPackCache();
  const payload = {
    apiUrl,
    package: pkg,
    apiCompatibility,
    compatibility: compatibility.report,
    api: health,
    auth,
    profile: profilePublicState(activeProfileName),
    config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
    decisionPackCache,
    sourceUploadDefault: false,
    sourceUploadSupported: false,
    telemetry: telemetryState(),
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`${packageName}: ${packageVersion}${pkg.latestVersion ? ` (latest ${pkg.latestVersion})` : ""}\n`);
    process.stdout.write(`API: ${apiUrl}\n`);
    process.stdout.write(`Profile: ${activeProfileName}\n`);
    process.stdout.write(`API health: ${health?.status ?? "unknown"}\n`);
    process.stdout.write(`Auth: ${auth.status}${auth.login ? ` (${auth.login})` : ""}\n`);
    process.stdout.write(`Decision-pack cache: ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"}\n`);
    process.stdout.write("Source upload: disabled\n");
    process.stdout.write(`Telemetry: ${payload.telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
    if (pkg.state === "stale") {
      process.stdout.write(`Update available: ${packageVersion} -> ${pkg.latestVersion}. Upgrade with:\n  ${pkg.upgradeCommand}\n`);
      process.stdout.write(`Or run without installing:\n  ${pkg.npxFallback}\n`);
    } else if (pkg.state === "unavailable") {
      process.stdout.write("Version check: npm registry was unavailable; skipping update check.\n");
    }
    if (apiCompatibility.status === "incompatible") {
      process.stdout.write(`API requires at least ${packageName}@${apiCompatibility.minVersion}. Upgrade with:\n  ${apiCompatibility.upgradeCommand}\n`);
    } else if (apiCompatibility.status === "compatible") {
      process.stdout.write(`API compatibility: compatible (minimum ${packageName}@${apiCompatibility.minVersion}).\n`);
    } else if (apiCompatibility.status === "unavailable") {
      process.stdout.write(`API compatibility: unavailable (${apiCompatibility.reason ?? "unknown"}).\n`);
    } else if (apiCompatibility.status === "unknown") {
      // Mirror doctor()'s unknown arm (#6263): an unparseable minimum version must still surface in human output.
      process.stdout.write(`API reported an unsupported minimum client version (${apiCompatibility.minVersion}).\n`);
    }
  }
}

async function changelog(options) {
  const text = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n\nNo packaged changelog was found.\n";
  const payload = {
    package: {
      name: packageName,
      version: packageVersion,
    },
    changelog: text,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function doctor(options) {
  const checks = [];
  const add = (name, statusValue, detail, remediation) =>
    checks.push(
      stripUndefined({
        name,
        status: statusValue,
        detail: sanitizeDiagnosticText(detail, [options.cwd]),
        remediation: sanitizeDiagnosticText(remediation, [options.cwd]),
      }),
    );
  let authLogin = options.login ?? activeProfile.session?.login;
  let repoFullName = typeof options.repo === "string" ? options.repo : undefined;

  let health = null;
  try {
    health = await apiFetch("/health", { method: "GET" }, { auth: false });
    add("api_health", health.status === "ok" ? "pass" : "warn", `API responded from ${apiUrl}.`);
  } catch (error) {
    health = { status: "unreachable" };
    add("api_health", "fail", error instanceof Error ? error.message : "health_check_failed", "Check LOOPOVER_API_URL or network access.");
  }

  const compatibility = await inspectApiCompatibility(health);
  const pkg = await inspectInstallVersion(compatibilityLatestRecommendedVersion(compatibility.report) ?? compatibilityLatestRecommendedVersion(health));
  if (pkg.state === "stale") {
    add("version", "warn", `Installed ${packageVersion} is behind npm latest ${pkg.latestVersion}.`, `${pkg.upgradeCommand} (no-install fallback: ${pkg.npxFallback})`);
  } else if (pkg.state === "unavailable") {
    add("version", "warn", "Could not reach the npm registry to check for updates.", `Retry when online, or run the no-install fallback: ${npxFallbackCommand}`);
  } else if (pkg.state === "unknown") {
    add("version", "warn", `Could not compare local ${packageVersion} against npm latest ${pkg.latestVersion ?? "unknown"}.`);
  } else if (pkg.state === "ahead") {
    add("version", "pass", `Installed ${packageVersion} is ahead of npm latest ${pkg.latestVersion}.`);
  } else if (pkg.state === "skipped") {
    add("version", "pass", "npm version check was skipped (LOOPOVER_SKIP_NPM_VERSION_CHECK).");
  } else {
    add("version", "pass", `Installed ${packageVersion} matches npm latest ${pkg.latestVersion}.`);
  }

  const apiCompatibility = compatibility.evaluation;
  if (apiCompatibility.status === "incompatible") {
    add("api_compatibility", "fail", `API requires at least ${packageName}@${apiCompatibility.minVersion}; local is ${packageVersion}.`, apiCompatibility.upgradeCommand);
  } else if (apiCompatibility.status === "compatible") {
    add("api_compatibility", "pass", `Local ${packageVersion} meets the API minimum ${apiCompatibility.minVersion}.`);
  } else if (apiCompatibility.reason === "api_unreachable") {
    add("api_compatibility", "warn", "API compatibility check was unavailable because API health was unreachable.");
  } else if (apiCompatibility.reason === "compatibility_endpoint_unavailable") {
    add("api_compatibility", "warn", "API compatibility endpoint was unavailable; compatibility could not be confirmed.");
  } else if (apiCompatibility.status === "unknown") {
    add("api_compatibility", "warn", `API reported an unsupported minimum client version (${apiCompatibility.minVersion}).`);
  } else {
    add("api_compatibility", "pass", "API did not report a minimum client version; compatibility check skipped.");
  }

  const token = getApiToken();
  if (!token) {
    add("auth", "fail", `No LoopOver API/session token is configured for profile ${activeProfileName}.`, `Run \`loopover-mcp login --profile ${activeProfileName}\`.`);
  } else {
    try {
      const session = await apiGet("/v1/auth/session");
      authLogin = session.login ?? authLogin;
      add("auth", "pass", `Profile ${activeProfileName} authenticated as ${session.login}; session expires ${session.expiresAt}.`);
    } catch (error) {
      add("auth", "warn", `A token is configured for profile ${activeProfileName} but no user session was verified: ${error instanceof Error ? error.message : "session_check_failed"}.`, "If this is a static beta token, this can be expected. Otherwise run `loopover-mcp login`.");
    }
  }

  if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false")) {
    add("source_upload", "fail", "LOOPOVER_UPLOAD_SOURCE is enabled.", "Unset LOOPOVER_UPLOAD_SOURCE. Source upload is unsupported in v1.");
  } else {
    add("source_upload", "pass", "Source upload is disabled and unsupported in v1.");
  }

  // Either telemetry stance is a valid, deliberate choice, so this is always a pass — it just makes the
  // current opt-in visible (and points at the toggle) rather than gating the checklist.
  const telemetry = telemetryState();
  add(
    "telemetry",
    "pass",
    telemetry.enabled ? "Local MCP usage telemetry is enabled (opt-in)." : "Local MCP usage telemetry is disabled (default).",
    telemetry.enabled ? "Run `loopover-mcp telemetry disable` to opt back out." : "Run `loopover-mcp telemetry enable` to opt in.",
  );

  const decisionPackCache = inspectDecisionPackCache();
  add(
    "decision_pack_cache",
    "pass",
    `Local stale fallback cache has ${decisionPackCache.entries} entr${decisionPackCache.entries === 1 ? "y" : "ies"} and is bounded at ${decisionPackCache.maxEntries}.`,
    "Run `loopover-mcp cache clear` to remove local stale fallback data.",
  );

  try {
    const metadata = collectLocalBranchMetadata({
      cwd: options.cwd ?? process.cwd(),
      baseRef: options.base,
      repoFullName: options.repo,
      login: options.login ?? activeProfile.session?.login ?? "local",
    });
    repoFullName = metadata.repoFullName ?? repoFullName;
    add("git_metadata", "pass", `${metadata.repoFullName} on ${metadata.branchName}; ${metadata.changedFiles.length} changed file(s).`);
  } catch (error) {
    add("git_metadata", "warn", error instanceof Error ? error.message : "git_metadata_failed", "Run from a git repo or pass --repo owner/repo.");
  }

  const commandPath = findExecutable("loopover-mcp");
  if (commandPath) add("client_path", "pass", "loopover-mcp is visible on PATH.");
  else add("client_path", "warn", "loopover-mcp was not found on PATH.", "Use an absolute command path in your MCP client config.");

  const scorerCommand = resolveScorePreviewCommand();
  if (!scorerCommand) {
    add(
      "local_scorer",
      "warn",
      "GITTENSOR_SCORE_PREVIEW_CMD is not configured; branch analysis will fall back to metadata-only scoring.",
      `Example: export GITTENSOR_SCORE_PREVIEW_CMD="${referenceScorePreviewExample("metadata")}"`,
    );
  } else {
    const probe = probeLocalScorer(scorerCommand);
    if (probe.ok) {
      add("local_scorer", "pass", `Configured scorer responded in ${probe.durationMs ?? 0}ms.`);
    } else {
      const remediation = setupGuidanceForLocalScorer(probe).slice(1).join(" ");
      add("local_scorer", "warn", `Configured scorer failed (${probe.code ?? "scorer_failed"}): ${probe.reason}`, remediation || "Run loopover-mcp doctor --json for structured diagnostics.");
    }
  }

  if (process.env.GITTENSOR_ROOT) {
    add("gittensor_root", "pass", "GITTENSOR_ROOT is configured.");
  } else if (scorerCommand?.includes("gittensor-score-preview.py")) {
    add("gittensor_root", "warn", "Python gittensor scorer is configured but GITTENSOR_ROOT is unset.", "Set GITTENSOR_ROOT to a local entrius/gittensor checkout.");
  }

  const statusValue = doctorStatus(checks);
  const checklist = buildDoctorChecklist(checks, {
    status: statusValue,
    profileName: activeProfileName,
    login: authLogin,
    repoFullName,
  });
  const nextCommand = checklist.find((group) => group.id === "next_command")?.nextCommand;
  const payload = {
    status: statusValue,
    apiUrl,
    profile: profilePublicState(activeProfileName),
    config: { configured: existsSync(configPath), activeProfile: activeProfileName, profileCount: profileList(config).length },
    decisionPackCache,
    sourceUploadSupported: false,
    telemetry,
    checklist,
    nextCommand,
    checks,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else {
    process.stdout.write(`LoopOver doctor: ${payload.status}\n`);
    process.stdout.write(`Profile: ${activeProfileName}\n`);
    for (const group of checklist) {
      process.stdout.write(`\n${group.title}: ${group.status}\n`);
      if (group.id === "next_command") {
        process.stdout.write(`- ${group.detail}\n`);
        if (group.nextCommand?.command) process.stdout.write(`  ${group.nextCommand.command}\n`);
        continue;
      }
      // #6261: a check's `detail` is the one field here that carries text this CLI didn't write -- an API error
      // message, an npm-registry error, a compatibility report's `error`. Some of those already pass through
      // sanitizeDiagnosticText, but that redacts tokens and local paths; it is indifferent to escape sequences. So
      // the terminal pass belongs here at the print boundary, where it covers every check source at once.
      for (const check of group.checks ?? []) {
        process.stdout.write(
          `- ${sanitizePlainTextTerminalOutput(check.status)}: ${sanitizePlainTextTerminalOutput(check.name)} - ${sanitizePlainTextTerminalOutput(check.detail)}\n`,
        );
        if (check.remediation) process.stdout.write(`  ${sanitizePlainTextTerminalOutput(check.remediation)}\n`);
      }
    }
  }
  // Opt-in: let `doctor` gate CI/pre-commit by exiting non-zero when a check fails. The default
  // stays exit 0 so existing scripts that ignore the exit code keep working.
  return options.exitCode && payload.status === "needs_attention" ? 1 : 0;
}

function doctorStatus(checks) {
  if (checks.some((check) => check.status === "fail")) return "needs_attention";
  if (checks.some((check) => check.status === "warn")) return "warnings";
  return "ok";
}

function buildDoctorChecklist(checks, context) {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const groups = doctorChecklistGroups().map((group) => {
    const groupChecks = group.checks.map((name) => byName.get(name)).filter(Boolean);
    return stripUndefined({
      id: group.id,
      title: group.title,
      status: checklistStatus(groupChecks),
      checks: groupChecks,
    });
  });
  const nextCommand = doctorNextCommand(byName, context);
  return [
    ...groups,
    stripUndefined({
      id: "next_command",
      title: "Next command",
      status: context.status === "needs_attention" ? "fail" : context.status === "warnings" ? "warn" : "pass",
      detail: nextCommand.reason,
      nextCommand,
    }),
  ];
}

function doctorChecklistGroups() {
  return [
    { id: "auth", title: "Auth", checks: ["auth"] },
    { id: "api_compatibility", title: "API compatibility", checks: ["api_health", "version", "api_compatibility"] },
    { id: "local_repo_readiness", title: "Local repo readiness", checks: ["git_metadata", "client_path"] },
    { id: "scorer_availability", title: "Scorer availability", checks: ["local_scorer", "gittensor_root"] },
    { id: "output_safety", title: "Output safety", checks: ["source_upload", "decision_pack_cache", "telemetry"] },
  ];
}

function checklistStatus(checks) {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warn")) return "warn";
  return "pass";
}

function doctorNextCommand(byName, context) {
  const sourceUpload = byName.get("source_upload");
  if (sourceUpload?.status === "fail") {
    return {
      command: "unset LOOPOVER_UPLOAD_SOURCE",
      reason: "Disable source upload first; the local MCP wrapper only sends metadata.",
    };
  }
  const apiCompatibility = byName.get("api_compatibility");
  if (apiCompatibility?.status === "fail") {
    return {
      command: apiCompatibility.remediation ?? upgradeCommand,
      reason: "Upgrade the MCP package before relying on API-backed commands.",
    };
  }
  const auth = byName.get("auth");
  if (auth?.status === "fail") {
    return {
      command: `loopover-mcp login --profile ${shellArg(context.profileName ?? "default")}`,
      reason: "Authenticate the active profile so doctor, plan, preflight, and packet commands can call the API.",
    };
  }
  const apiHealth = byName.get("api_health");
  if (apiHealth?.status === "fail") {
    return {
      command: "loopover-mcp status --json",
      reason: "Check API reachability before running planner or preflight commands.",
    };
  }
  const version = byName.get("version");
  if (version?.status === "warn" && version.remediation?.includes("npm install")) {
    return {
      command: upgradeCommand,
      reason: "Update the MCP package so local behavior matches the current API.",
    };
  }
  const gitMetadata = byName.get("git_metadata");
  if (gitMetadata?.status === "warn") {
    return {
      command: "loopover-mcp doctor --repo owner/repo --json",
      reason: "Run doctor from a git checkout or pass the repository explicitly.",
    };
  }
  const localScorer = byName.get("local_scorer");
  if (localScorer?.status === "warn" && localScorer.remediation) {
    const scorerSetupCommand = localScorer.remediation.startsWith("Example: ") ? localScorer.remediation.replace(/^Example:\s*/, "") : "loopover-mcp doctor --json";
    return {
      command: scorerSetupCommand,
      reason: "Configure the optional local scorer for richer private branch analysis.",
    };
  }
  return {
    command: `loopover-mcp review-pr --login ${shellArg(context.login ?? "<github-login>")} --repo ${shellArg(context.repoFullName ?? "owner/repo")} --json`,
    reason: "Run the composed pre-PR review (preflight + slop-risk + PR-text lint) next; source upload remains disabled.",
  };
}

function shellArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function initClient(options) {
  const client = String(options.print ?? options.client ?? "").toLowerCase();
  if (!client) throw new Error("Pass --print codex, --print claude, --print cursor, --print mcp, or --print vscode.");
  const command = options.command ?? "loopover-mcp";
  const snippet = clientSnippet(client, command);
  const agentProfile = resolveAgentProfile(options.agentProfile);
  const payload = {
    client,
    command,
    args: ["--stdio"],
    snippet,
    agentProfile,
    notes: [
      "Run `loopover-mcp login` before starting the MCP client.",
      "Use an absolute command path if the client does not inherit your shell PATH.",
      "This command prints config only; it does not edit client files.",
      ...(agentProfile
        ? [
            agentProfile.drivingLoop
              ? `Use the ${agentProfile.title} profile instructions as the agent system/developer prompt. Every GitHub write runs LOCALLY via your harness with your own credentials, only after the LoopOver gate + anti-slop check pass — LoopOver never performs the write.`
              : `Use the ${agentProfile.title} profile instructions as the agent system/developer prompt; keep all GitHub writes human-approved.`,
          ]
        : []),
    ],
  };
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(agentProfile ? `${snippet}\n\n${formatAgentProfile(agentProfile)}\n` : `${snippet}\n`);
}

function resolveAgentProfile(profileId) {
  if (!profileId) return null;
  const id = String(profileId).trim().toLowerCase();
  if (!Object.hasOwn(AGENT_PROFILES, id)) throw new Error(`Unsupported agent profile: ${profileId}. Use ${AGENT_PROFILE_IDS.join(", ")}.`);
  return AGENT_PROFILES[id];
}

function formatAgentProfile(profile) {
  return [
    `# LoopOver agent profile: ${profile.title}`,
    `Audience: ${profile.audience}`,
    `Purpose: ${profile.purpose}`,
    "",
    "Recommended MCP prompts:",
    ...profile.recommendedPrompts.map((name) => `- ${name}`),
    "",
    "Recommended MCP tools:",
    ...profile.recommendedTools.map((name) => `- ${name}`),
    ...(profile.drivingLoop ? ["", "Driving loop (plan → implement → push, gate-throttled):", ...profile.drivingLoop.map((step, index) => `${index + 1}. ${step}`)] : []),
    "",
    "Safety boundaries:",
    ...profile.boundaries.map((boundary) => `- ${boundary}`),
    "",
    `When not to use: ${profile.whenNotToUse}`,
  ].join("\n");
}

function getApiToken() {
  return getEnvApiToken() ?? configuredProfileToken(activeProfileName);
}

function getEnvApiToken() {
  // Precedence matches the documented order (README, printHelp, the missing-auth error, and the
  // sanitizer list): the MCP-specific token wins over the generic LOOPOVER_TOKEN, which previously
  // took priority here and contradicted every other reference to this order.
  return process.env.LOOPOVER_API_TOKEN ?? process.env.LOOPOVER_MCP_TOKEN ?? process.env.LOOPOVER_TOKEN;
}

function selectedProfileName(options = {}) {
  return normalizeProfileName(options.profile ?? activeProfileName);
}

function configuredProfileToken(profileName, currentConfig = config) {
  return currentConfig.profiles?.[profileName]?.session?.token;
}

function profileSessions(currentConfig = config) {
  return Object.entries(currentConfig.profiles ?? {})
    .flatMap(([name, profile]) => (profile?.session?.token ? [{ name, session: profile.session }] : []));
}

function profilePublicState(profileName, currentConfig = config) {
  const profile = currentConfig.profiles?.[profileName];
  const hasEnvToken = Boolean(getEnvApiToken());
  return {
    name: profileName,
    active: profileName === (currentConfig.activeProfile ?? defaultProfileName),
    configured: Boolean(profile),
    authenticated: Boolean(profile?.session?.token),
    login: profile?.session?.login ?? null,
    expiresAt: profile?.session?.expiresAt ?? null,
    tokenSource: hasEnvToken ? "environment" : profile?.session?.token ? "profile" : "none",
    apiUrl: profile?.apiUrl ?? currentConfig.apiUrl ?? null,
  };
}

function profileList(currentConfig = config) {
  const names = new Set([defaultProfileName, currentConfig.activeProfile ?? defaultProfileName, ...Object.keys(currentConfig.profiles ?? {})]);
  return [...names].sort((left, right) => (left === currentConfig.activeProfile ? -1 : right === currentConfig.activeProfile ? 1 : left.localeCompare(right))).map((name) => profilePublicState(name, currentConfig));
}

function selectProfileName(currentConfig, requestedName) {
  const requested = requestedName ? normalizeProfileName(requestedName) : undefined;
  if (requested) return requested;
  const configured = currentConfig?.activeProfile ? normalizeProfileName(currentConfig.activeProfile) : defaultProfileName;
  if (currentConfig?.profiles?.[configured]) return configured;
  return currentConfig?.profiles?.[defaultProfileName] || configured === defaultProfileName ? defaultProfileName : configured;
}

function resolvedApiUrlSource() {
  if (process.env.LOOPOVER_API_URL) return "environment";
  const profileApiUrl = typeof activeProfile.apiUrl === "string" ? activeProfile.apiUrl.replace(/\/+$/, "") : undefined;
  if (profileApiUrl && !legacyDefaultApiUrls.has(profileApiUrl)) return "profile";
  const globalApiUrl = typeof config.apiUrl === "string" ? config.apiUrl.replace(/\/+$/, "") : undefined;
  if (globalApiUrl && !legacyDefaultApiUrls.has(globalApiUrl)) return "config";
  return "default";
}

function resolvedConfigPathSource() {
  if (process.env.LOOPOVER_CONFIG_PATH) return "LOOPOVER_CONFIG_PATH";
  if (process.env.LOOPOVER_CONFIG_DIR) return "LOOPOVER_CONFIG_DIR";
  if (process.env.XDG_CONFIG_HOME) return "XDG_CONFIG_HOME";
  return "default";
}

function resolvedTokenSource() {
  if (getEnvApiToken()) return "environment";
  if (configuredProfileToken(activeProfileName)) return "profile";
  return "none";
}

function sourceUploadState() {
  const enabled = /^(1|true|yes)$/i.test(process.env.LOOPOVER_UPLOAD_SOURCE ?? "false");
  return {
    default: false,
    enabled,
    source: enabled ? "LOOPOVER_UPLOAD_SOURCE" : "default",
    supported: false,
  };
}

// Resolve the current local telemetry opt-in from persisted config. The flag is top-level (not
// per-profile) and defaults to disabled when absent, so an unconfigured install reports opt-out.
function telemetryState(currentConfig = config) {
  return {
    enabled: currentConfig.telemetryEnabled === true,
    default: false,
  };
}

// Report the resolved effective configuration and where each value came from, without leaking
// local absolute paths or token values. Distinct from `status` (health/version), `doctor`
// (diagnostic checks), and `whoami` (session identity): this answers "what config is in effect
// and which source supplied it?".
function configCommand(options) {
  const payload = {
    apiUrl,
    apiUrlSource: resolvedApiUrlSource(),
    activeProfile: activeProfileName,
    profileCount: profileList(config).length,
    configured: existsSync(configPath),
    configPathSource: resolvedConfigPathSource(),
    cacheDirSource: process.env.LOOPOVER_CACHE_DIR ? "LOOPOVER_CACHE_DIR" : "default",
    tokenConfigured: Boolean(getApiToken()),
    tokenSource: resolvedTokenSource(),
    sourceUpload: sourceUploadState(),
    telemetry: telemetryState(),
    profile: profilePublicState(activeProfileName),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`API URL: ${payload.apiUrl} (${payload.apiUrlSource})\n`);
  process.stdout.write(`Active profile: ${payload.activeProfile} (${payload.profileCount} configured)\n`);
  process.stdout.write(`Config file: ${payload.configured ? "present" : "absent"} (location: ${payload.configPathSource})\n`);
  process.stdout.write(`Cache dir: ${payload.cacheDirSource}\n`);
  process.stdout.write(`Token: ${payload.tokenConfigured ? `configured (${payload.tokenSource})` : "not configured"}\n`);
  process.stdout.write(
    payload.sourceUpload.enabled
      ? `Source upload: enabled via ${payload.sourceUpload.source} (unsupported; unset LOOPOVER_UPLOAD_SOURCE)\n`
      : "Source upload: disabled (unsupported)\n",
  );
  process.stdout.write(`Telemetry: ${payload.telemetry.enabled ? "enabled (opt-in)" : "disabled (default)"}\n`);
}

function normalizeProfileName(value) {
  const name = String(value ?? defaultProfileName).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new Error("Profile names must be 1-64 characters and use letters, numbers, dots, dashes, or underscores.");
  return name;
}

function cliOptionValue(args, optionName) {
  const dashed = `--${optionName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === dashed) {
      const next = args[index + 1];
      return next && !next.startsWith("--") ? next : undefined;
    }
    if (value?.startsWith(`${dashed}=`)) return value.slice(dashed.length + 1);
  }
  return undefined;
}

function upsertProfile(currentConfig, profileName, patch) {
  const now = new Date().toISOString();
  const existing = currentConfig.profiles?.[profileName] ?? {};
  const profiles = {
    ...(currentConfig.profiles ?? {}),
    [profileName]: stripUndefined({
      ...existing,
      apiUrl: patch.apiUrl ?? existing.apiUrl,
      session: patch.session ?? existing.session,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    }),
  };
  return normalizeConfig({ ...currentConfig, apiUrl: patch.apiUrl ?? currentConfig.apiUrl, activeProfile: profileName, profiles });
}

function ensureProfile(currentConfig, profileName, options = {}) {
  const existing = currentConfig.profiles?.[profileName];
  const nextConfig = existing ? currentConfig : upsertProfile(currentConfig, profileName, {});
  return options.activate ? setActiveProfile(nextConfig, profileName) : nextConfig;
}

function setActiveProfile(currentConfig, profileName) {
  return normalizeConfig({ ...currentConfig, activeProfile: profileName });
}

function clearProfileSession(currentConfig, profileName) {
  const existing = currentConfig.profiles?.[profileName];
  if (!existing) return currentConfig;
  const profiles = {
    ...(currentConfig.profiles ?? {}),
    [profileName]: stripUndefined({ ...existing, session: undefined, updatedAt: new Date().toISOString() }),
  };
  return normalizeConfig({ ...currentConfig, profiles });
}

function clearAllProfileSessions(currentConfig) {
  const profiles = Object.fromEntries(
    Object.entries(currentConfig.profiles ?? {}).map(([name, profile]) => [name, stripUndefined({ ...profile, session: undefined, updatedAt: new Date().toISOString() })]),
  );
  return normalizeConfig({ ...currentConfig, profiles });
}

function removeProfile(currentConfig, profileName) {
  const profiles = { ...(currentConfig.profiles ?? {}) };
  delete profiles[profileName];
  const remaining = Object.keys(profiles);
  const activeProfile = currentConfig.activeProfile === profileName ? (profiles[defaultProfileName] ? defaultProfileName : remaining[0] ?? defaultProfileName) : currentConfig.activeProfile;
  const session = profileName === defaultProfileName ? undefined : currentConfig.session;
  return normalizeConfig({ ...currentConfig, activeProfile, profiles, session });
}

function setTelemetryEnabled(currentConfig, enabled) {
  // normalizeConfig coerces this to a strict boolean and strips it when not exactly `true`, so disabling
  // removes the key entirely (default = absent) rather than persisting `telemetryEnabled: false`.
  return normalizeConfig({ ...currentConfig, telemetryEnabled: enabled === true ? true : undefined });
}

function hasPersistedConfigState(currentConfig) {
  return Boolean(currentConfig.apiUrl || currentConfig.telemetryEnabled === true || Object.keys(currentConfig.profiles ?? {}).length > 0);
}

function validationFromOptions(options) {
  const direct = (options.validation ?? []).map(parseValidationEntry);
  const commands = options.validationCommand ?? [];
  const statuses = options.validationStatus ?? [];
  const summaries = options.validationSummary ?? [];
  const durations = options.validationDuration ?? [];
  const expanded = commands.map((command, index) =>
    validationEntry({
      command,
      statusText: statuses[index],
      summaryText: summaries[index],
      durationText: durations[index],
    }),
  );
  return [...direct, ...expanded].filter((entry) => typeof entry.command === "string" && entry.command.length > 0);
}

function parseValidationEntry(entry) {
  const parts = String(entry ?? "").split("|").map((part) => part.trim());
  const explicitStatus = normalizeValidationStatus(parts[0]);
  const command = explicitStatus ? parts[1] : parts[0];
  const rest = explicitStatus ? parts.slice(2) : parts.slice(1);
  const inferredStatusText = !explicitStatus && isValidationStatusLike(rest[0]) ? rest[0] : undefined;
  const detailParts = inferredStatusText ? rest.slice(1) : rest;
  const durationMs = parseDurationMs(detailParts[0]);
  const summaryParts = durationMs !== undefined ? detailParts.slice(1) : detailParts;
  return validationEntry({
    command,
    statusText: explicitStatus ?? inferredStatusText,
    summaryText: summaryParts.join("|"),
    durationMs,
  });
}

function validationEntry({ command, statusText, summaryText, durationText, durationMs }) {
  const statusSource = nonEmptyString(statusText);
  const summarySource = statusSource ? undefined : nonEmptyString(summaryText);
  const exitCode =
    inferValidationExitCode(statusSource, { allowBareCode: true, allowGenericStatus: true }) ??
    inferValidationExitCode(summarySource, { allowBareCode: false, allowGenericStatus: false });
  const status =
    normalizeValidationStatus(statusSource) ??
    normalizeSummaryValidationStatus(summarySource) ??
    (exitCode !== undefined ? (exitCode === 0 ? "passed" : "failed") : "not_run");
  return stripUndefined({
    command: sanitizeValidationText(command, 160),
    status,
    summary: sanitizeValidationText(summaryText),
    durationMs: durationMs ?? parseDurationMs(durationText),
    exitCode,
  });
}

function optionalInteger(value) {
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parsePositiveIntegerOption(value, flagName) {
  if (value === undefined) return undefined;
  const parsed = optionalInteger(value);
  if (parsed === undefined || parsed <= 0) throw new Error(`Pass ${flagName} as a positive integer.`);
  return parsed;
}

function normalizeOptionalStringOption(value) {
  if (value === undefined) return undefined;
  if (value === true) return "";
  if (typeof value === "string") return value;
  throw new Error("Expected a string flag value.");
}

function optionalNumber(value) {
  if (value === undefined || value === true) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isValidationStatus(value) {
  return Boolean(normalizeValidationStatus(value));
}

function normalizeValidationStatus(value) {
  const text = String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["passed", "pass", "success", "ok", "exit_0", "0"].includes(text)) return "passed";
  if (["failed", "fail", "failure", "error", "nonzero", "non_zero"].includes(text) || /^exit_[1-9]\d*$/.test(text) || /^[1-9]\d*$/.test(text)) return "failed";
  if (["not_run", "notrun", "not_ran", "pending"].includes(text)) return "not_run";
  if (["skipped", "skip"].includes(text)) return "skipped";
  if (["focused", "focus"].includes(text)) return "focused";
  if (["unknown", "unclear"].includes(text)) return "unknown";
  return undefined;
}

function isValidationStatusLike(value) {
  return Boolean(
    normalizeValidationStatus(value) ??
      inferValidationExitCode(value, { allowBareCode: true, allowGenericStatus: true }),
  );
}

function inferValidationExitCode(value, options = {}) {
  const text = String(value ?? "").trim().toLowerCase();
  const allowBareCode = options.allowBareCode === true;
  const allowGenericStatus = options.allowGenericStatus === true;
  if (allowBareCode && /^\d{1,3}$/.test(text)) return Number(text);
  const processExitPattern = /\b(?:exit(?:ed)?(?:\s+(?:code|status))?|exitcode|process\s+(?:exit(?:ed)?|status|code)|command\s+(?:exit(?:ed)?|status|code)|shell\s+(?:exit(?:ed)?|status|code))[\s:_-]*(\d{1,3})\b/;
  const genericStatusPattern = /^(?:status|code)[\s:_-]*(\d{1,3})\b/;
  const match = text.match(processExitPattern) ?? (allowGenericStatus ? text.match(genericStatusPattern) : null);
  if (match) return Number(match[1]);
  if (!allowBareCode && /^\d{1,3}$/.test(text)) return undefined;
  const status = normalizeValidationStatus(text);
  if (status === "passed" || status === "focused") return 0;
  if (status === "failed") return 1;
  return undefined;
}

function normalizeSummaryValidationStatus(value) {
  const text = nonEmptyString(value);
  if (!text || /^\d{1,3}$/.test(text)) return undefined;
  return normalizeValidationStatus(text);
}

function nonEmptyString(value) {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function parseDurationMs(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)?$/);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  const unit = match[2] ?? "ms";
  const multiplier = unit.startsWith("m") && unit !== "ms" ? 60000 : unit.startsWith("s") ? 1000 : 1;
  return Math.round(amount * multiplier);
}

function sanitizeValidationText(value, maxLength = 240) {
  const text = String(value ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return undefined;
  const redacted = redactPrivateValidationMetrics(redactLocalPath(text));
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength - 3)}...`;
}

function redactPrivateValidationMetrics(text) {
  return text.replace(
    /\b(?:wallet|hotkey|coldkey|mnemonic|raw[-_\s]?trust|private[-_\s]?reviewability|trust[-_\s]?score)\b(?:\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"'`,;)]+))?/gi,
    "[redacted]",
  );
}

function clientSnippet(client, command) {
  if (client === "codex") return `[mcp_servers.loopover]\ncommand = ${JSON.stringify(command)}\nargs = ["--stdio"]`;
  if (client === "claude" || client === "cursor" || client === "mcp") {
    return JSON.stringify(
      {
        mcpServers: {
          loopover: {
            command,
            args: ["--stdio"],
          },
        },
      },
      null,
      2,
    );
  }
  // VS Code's native MCP support uses a `servers` map with an explicit transport type, not the
  // `mcpServers` shape the other JSON hosts use, so it needs its own snippet (see .vscode/mcp.json).
  if (client === "vscode") {
    return JSON.stringify(
      {
        servers: {
          loopover: {
            type: "stdio",
            command,
            args: ["--stdio"],
          },
        },
      },
      null,
      2,
    );
  }
  throw new Error(`Unsupported client: ${client}. Use codex, claude, cursor, mcp, or vscode.`);
}

async function getDecisionPackWithCache(login) {
  try {
    const payload = await apiGet(`/v1/contributors/${encodeURIComponent(login)}/decision-pack`);
    if (isCacheableDecisionPack(payload, login)) writeDecisionPackCache(login, payload);
    return payload;
  } catch (error) {
    if (!isDecisionPackCacheFallbackEligible(error)) throw error;
    const cached = readDecisionPackCache(login);
    if (!cached) throw error;
    return staleDecisionPackFromCache(cached, error);
  }
}

async function getRepoDecisionWithCache(login, owner, repo) {
  const repoFullName = `${owner}/${repo}`;
  try {
    return await apiGet(`/v1/contributors/${encodeURIComponent(login)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/decision`);
  } catch (error) {
    if (!isDecisionPackCacheFallbackEligible(error)) throw error;
    const cached = readDecisionPackCache(login);
    if (!cached) throw error;
    return repoDecisionFromCachedPack(cached, repoFullName, error);
  }
}

function decisionPackToolSummary(login, payload) {
  if (payload?.source === "local_cache") return `LoopOver decision pack for ${login} (stale local cache).`;
  if (payload?.freshness === "stale" || payload?.freshness === "rebuilding") return `LoopOver decision pack for ${login} (${payload.freshness}).`;
  return `LoopOver decision pack for ${login}.`;
}

function repoDecisionToolSummary(login, repoFullName, payload) {
  if (payload?.source === "local_cache") return `LoopOver repo decision for ${login} in ${repoFullName} (stale local cache).`;
  return `LoopOver repo decision for ${login} in ${repoFullName}.`;
}

function getOpenPrMonitor(login) {
  return apiGet(`/v1/contributors/${encodeURIComponent(login)}/open-pr-monitor`);
}

// Mirror the API's own `summary` when it sends one, so the CLI and the loopover_monitor_open_prs MCP
// tool (which returns monitor.summary verbatim) never drift into two different sentences for one payload.
function openPrMonitorToolSummary(login, payload) {
  const summary = typeof payload?.summary === "string" ? payload.summary.trim() : "";
  if (summary) return summary;
  return `LoopOver open-PR monitor for ${login}.`;
}

function isCacheableDecisionPack(payload, login) {
  return payload?.status === "ready" && typeof payload.login === "string" && payload.login.toLowerCase() === login.toLowerCase();
}

function decisionPackAuthCacheKey() {
  const token = getApiToken();
  if (!token) return null;
  return createHash("sha256").update(token).digest("base64url");
}

function decisionPackCachePath(login, authCacheKey = decisionPackAuthCacheKey()) {
  if (!authCacheKey) return null;
  const key = Buffer.from(`${apiUrl}\0${currentApiVersion}\0${login.toLowerCase()}\0${authCacheKey}`).toString("base64url");
  return join(decisionPackCacheDir, `${key}.json`);
}

function writeDecisionPackCache(login, payload) {
  const authCacheKey = decisionPackAuthCacheKey();
  if (!authCacheKey) return { status: "skipped", reason: "missing_auth" };
  const cachedAt = new Date().toISOString();
  const sanitizedPayload = sanitizeDecisionPackForCache(payload);
  const entry = {
    schemaVersion: decisionPackCacheSchemaVersion,
    apiVersion: typeof payload.apiVersion === "string" ? payload.apiVersion : currentApiVersion,
    packageVersion,
    apiUrl,
    authCacheKey,
    login: login.toLowerCase(),
    cachedAt,
    payload: sanitizedPayload,
  };
  if (entry.apiVersion !== currentApiVersion) return { status: "skipped", reason: "api_version_mismatch" };
  const serialized = `${JSON.stringify(entry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > decisionPackCacheMaxBytes) return { status: "skipped", reason: "too_large" };
  mkdirSync(decisionPackCacheDir, { recursive: true, mode: 0o700 });
  const path = decisionPackCachePath(login, authCacheKey);
  if (!path) return { status: "skipped", reason: "missing_auth" };
  writeFileSync(path, serialized, { mode: 0o600 });
  pruneDecisionPackCache();
  return { status: "stored", cachedAt };
}

function readDecisionPackCache(login) {
  const authCacheKey = decisionPackAuthCacheKey();
  const path = decisionPackCachePath(login, authCacheKey);
  if (!path || !existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8"));
    if (!isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey)) return null;
    return entry;
  } catch {
    return null;
  }
}

function isCompatibleDecisionPackCacheEntry(entry, login, authCacheKey = decisionPackAuthCacheKey()) {
  return (
    entry &&
    typeof entry === "object" &&
    entry.schemaVersion === decisionPackCacheSchemaVersion &&
    entry.apiVersion === currentApiVersion &&
    entry.apiUrl === apiUrl &&
    typeof entry.authCacheKey === "string" &&
    entry.authCacheKey === authCacheKey &&
    typeof entry.cachedAt === "string" &&
    typeof entry.login === "string" &&
    entry.login.toLowerCase() === login.toLowerCase() &&
    isCacheableDecisionPack(entry.payload, login)
  );
}

function staleDecisionPackFromCache(entry, error) {
  const payload = entry.payload;
  return stripUndefined({
    ...payload,
    source: "local_cache",
    stale: true,
    freshness: "stale",
    rebuildEnqueued: false,
    cachedAt: entry.cachedAt,
    cache: cacheFallbackMetadata(entry, error),
  });
}

function repoDecisionFromCachedPack(entry, repoFullName, error) {
  const pack = staleDecisionPackFromCache(entry, error);
  const decision = cachedRepoDecision(pack, repoFullName);
  return stripUndefined({
    status: decision ? "ready" : "not_found",
    login: pack.login,
    repoFullName,
    generatedAt: pack.generatedAt,
    source: "local_cache",
    stale: true,
    freshness: "stale",
    cachedAt: entry.cachedAt,
    decision,
    dataQuality: pack.dataQuality,
    cache: cacheFallbackMetadata(entry, error),
  });
}

function cachedRepoDecision(pack, repoFullName) {
  const key = repoFullName.toLowerCase();
  return pack.repoDecisions?.find((decision) => String(decision?.repoFullName ?? "").toLowerCase() === key) ?? null;
}

function cacheFallbackMetadata(entry, error) {
  return {
    source: "local_cache",
    stale: true,
    cachedAt: entry.cachedAt,
    apiVersion: entry.apiVersion,
    schemaVersion: entry.schemaVersion,
    reason: "api_unavailable",
    detail: sanitizeDiagnosticText(error instanceof Error ? error.message : "api_unavailable"),
    rerunGuidance: "Retry when LoopOver API access is restored; cached guidance may be stale.",
    clearCommand: "loopover-mcp cache clear",
  };
}

function isDecisionPackCacheFallbackEligible(error) {
  const status = error?.status;
  if (typeof status !== "number") return true;
  return status === 429 || status >= 500;
}

function sanitizeDecisionPackForCache(value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeDecisionPackForCache(entry));
  if (typeof value === "string") return sanitizeCacheString(value);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (isForbiddenCacheKey(entryKey)) continue;
    sanitized[entryKey] = sanitizeDecisionPackForCache(entryValue);
  }
  return sanitized;
}

function isForbiddenCacheKey(key) {
  return /^(?:authorization|token|accessToken|apiToken|githubToken|wallet|hotkey|coldkey|mnemonic|privateKey|private_key|sourceContent|sourceContents|fileContent|fileContents|rawSource|rawSourceContent|content|contents|diff|patch|rawDiff|localPath|absolutePath)$/i.test(
    key,
  );
}

function sanitizeCacheString(value) {
  return redactPrivateValidationMetrics(redactLocalPath(sanitizeDiagnosticText(value)));
}

function decisionPackCacheFiles() {
  if (!existsSync(decisionPackCacheDir)) return [];
  return readdirSync(decisionPackCacheDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(decisionPackCacheDir, name);
      try {
        const stats = statSync(path);
        return { path, mtimeMs: stats.mtimeMs, size: stats.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function pruneDecisionPackCache() {
  const files = decisionPackCacheFiles().sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const file of files.slice(decisionPackCacheMaxEntries)) rmSync(file.path, { force: true });
}

function clearDecisionPackCache() {
  const removed = decisionPackCacheFiles().length;
  rmSync(decisionPackCacheDir, { recursive: true, force: true });
  return {
    status: "cleared",
    removed,
    cache: {
      source: "local_cache",
      maxEntries: decisionPackCacheMaxEntries,
      clearCommand: "loopover-mcp cache clear",
    },
  };
}

function inspectDecisionPackCache() {
  const files = decisionPackCacheFiles();
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return {
    status: "ok",
    entries: files.length,
    bytes,
    maxEntries: decisionPackCacheMaxEntries,
    schemaVersion: decisionPackCacheSchemaVersion,
    apiVersion: currentApiVersion,
    clearCommand: "loopover-mcp cache clear",
  };
}

// Per-entry view of the offline decision-pack cache, newest first. Surfaces only safe metadata
// (login, when it was cached, the API/package version, size) — never the auth-cache key (a token
// hash) or the cached payload — so it stays consistent with the cache's local-only redaction.
function listDecisionPackCache() {
  const files = decisionPackCacheFiles().sort((left, right) => right.mtimeMs - left.mtimeMs);
  const entries = files.map((file) => {
    try {
      const entry = JSON.parse(readFileSync(file.path, "utf8"));
      return {
        login: typeof entry.login === "string" ? entry.login : null,
        cachedAt: typeof entry.cachedAt === "string" ? entry.cachedAt : null,
        apiVersion: typeof entry.apiVersion === "string" ? entry.apiVersion : null,
        packageVersion: typeof entry.packageVersion === "string" ? entry.packageVersion : null,
        bytes: file.size,
      };
    } catch {
      return { login: null, cachedAt: null, apiVersion: null, packageVersion: null, bytes: file.size, corrupt: true };
    }
  });
  return {
    status: "ok",
    count: entries.length,
    maxEntries: decisionPackCacheMaxEntries,
    clearCommand: "loopover-mcp cache clear",
    entries,
  };
}

function findExecutable(name) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sanitizeDiagnosticText(value, extraPaths = []) {
  return redactKnownLocalPaths(value, {
    tokens: [
      process.env.LOOPOVER_API_TOKEN,
      process.env.LOOPOVER_MCP_TOKEN,
      process.env.LOOPOVER_TOKEN,
      config.session?.token,
      ...profileSessions(config).map((entry) => entry.session.token),
    ],
    paths: [configPath, process.env.LOOPOVER_CONFIG_PATH, process.env.LOOPOVER_CONFIG_DIR, process.cwd(), homedir(), ...extraPaths],
  });
}

function loadConfig() {
  if (!existsSync(configPath)) return {};
  try {
    return normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return {};
  }
}

function saveConfig(nextConfig) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `${JSON.stringify(configForPersistence(nextConfig), null, 2)}\n`, { mode: 0o600 });
}

function normalizeConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : {};
  const profiles = {};
  const rawProfiles = raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles) ? raw.profiles : {};
  for (const [rawName, rawProfile] of Object.entries(rawProfiles)) {
    try {
      const name = normalizeProfileName(rawName);
      const profile = normalizeProfile(rawProfile);
      if (profile) profiles[name] = profile;
    } catch {
      // Ignore malformed profile names in local config instead of leaking paths or tokens.
    }
  }
  if (raw.session?.token && !profiles[defaultProfileName]) {
    profiles[defaultProfileName] = normalizeProfile({
      apiUrl: raw.apiUrl,
      session: raw.session,
    });
  }
  let activeProfile = defaultProfileName;
  try {
    activeProfile = selectProfileName({ ...raw, profiles }, raw.activeProfile);
  } catch {
    activeProfile = defaultProfileName;
  }
  return stripUndefined({
    ...raw,
    activeProfile,
    profiles,
    session: profiles[defaultProfileName]?.session,
    // Opt-in telemetry flag (#6239): only a literal `true` counts as enabled, so a malformed or legacy
    // value in the config file falls back to the privacy-preserving default (absent = disabled).
    telemetryEnabled: raw.telemetryEnabled === true ? true : undefined,
  });
}

function normalizeProfile(rawProfile) {
  const raw = rawProfile && typeof rawProfile === "object" && !Array.isArray(rawProfile) ? rawProfile : {};
  const session = normalizeSession(raw.session);
  return stripUndefined({
    apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl.replace(/\/+$/, "") : undefined,
    session,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  });
}

function normalizeSession(rawSession) {
  const raw = rawSession && typeof rawSession === "object" && !Array.isArray(rawSession) ? rawSession : {};
  if (typeof raw.token !== "string" || raw.token.length === 0) return undefined;
  return stripUndefined({
    token: raw.token,
    login: typeof raw.login === "string" ? raw.login : undefined,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : undefined,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.filter((scope) => typeof scope === "string") : [],
  });
}

function configForPersistence(nextConfig) {
  const normalized = normalizeConfig(nextConfig);
  return stripUndefined({
    apiUrl: normalized.apiUrl,
    activeProfile: normalized.activeProfile,
    profiles: normalized.profiles,
    session: normalized.profiles?.[defaultProfileName]?.session,
    telemetryEnabled: normalized.telemetryEnabled,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(path) {
  return apiFetch(path, { method: "GET" });
}

async function apiPost(path, body) {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

async function apiFetch(path, init, options = {}) {
  const token = options.token ?? getApiToken();
  if (options.auth !== false && !token) {
    const error = new Error("Run `loopover-mcp login`, or set LOOPOVER_API_TOKEN, LOOPOVER_MCP_TOKEN, or LOOPOVER_TOKEN before starting the MCP wrapper.");
    error.status = 401;
    error.code = "missing_auth";
    throw error;
  }
  const controller = new AbortController();
  const timeoutMs = Number(process.env.LOOPOVER_API_TIMEOUT_MS ?? options.timeoutMs ?? 30000);
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000);
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    signal: init?.signal ?? controller.signal,
    headers: {
      ...(token && options.auth !== false ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json",
      "x-loopover-mcp-package": packageName,
      "x-loopover-mcp-version": packageVersion,
      "x-loopover-mcp-client": "loopover-mcp-cli",
    },
  }).finally(() => clearTimeout(timeout));
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      if (response.ok) throw error;
      payload = { error: "non_json_response", body: text.slice(0, 500) };
    }
  }
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const error = new Error(`LoopOver API ${response.status}${retry ? ` retry-after=${retry}s` : ""}: ${JSON.stringify(payload).slice(0, 500)}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchLatestPackageVersion() {
  if (/^(1|true|yes)$/i.test(process.env.LOOPOVER_SKIP_NPM_VERSION_CHECK ?? "false")) return { status: "skipped" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(`${npmRegistryUrl}/@loopover%2fmcp/latest`, {
    signal: controller.signal,
    headers: { accept: "application/json" },
  }).finally(() => clearTimeout(timeout));
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.version !== "string") throw new Error("npm_latest_version_unavailable");
  return { status: "ok", version: payload.version };
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? null };
}

// Compares two dot-separated semver prerelease strings per the semver spec:
// numeric identifiers compare numerically, others lexically, numeric < non-numeric,
// and a shorter set of identifiers has lower precedence when all earlier ones match.
//
// Numeric identifiers are compared as decimal strings, not via Number(), which loses precision beyond
// Number.MAX_SAFE_INTEGER (2^53-1): two distinct digit strings past that width can round to the SAME float,
// making Number(leftId) !== Number(rightId) wrongly report them as equal (mirrors the same fix already applied
// to compareMcpSemver's comparePrerelease in src/services/mcp-compatibility.ts, #3049). With no leading zeros
// (semver's own numeric-identifier rule), a longer digit string is the larger number, and equal-length strings
// compare lexicographically.
function comparePrerelease(a, b) {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftId = left[index];
    const rightId = right[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      if (leftId.length !== rightId.length) return leftId.length < rightId.length ? -1 : 1;
      if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftId !== rightId) {
      return leftId < rightId ? -1 : 1;
    }
  }
  return 0;
}

// Returns -1 if a < b, 1 if a > b, 0 if equal, or null when either side is unparseable.
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  for (const part of ["major", "minor", "patch"]) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  // A release version has higher precedence than any prerelease of the same core.
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

// Maps a raw npm-latest lookup into a single install state. `comparison` is the result of
// compareSemver(local, latest): negative means local is behind (stale), positive means ahead.
function classifyVersionState(latestStatus, latestVersion, comparison) {
  if (latestStatus === "skipped") return "skipped";
  if (!latestVersion) return "unavailable";
  if (comparison === null) return "unknown";
  if (comparison < 0) return "stale";
  if (comparison > 0) return "ahead";
  return "current";
}

// Shared by `status` and `doctor`: compares the local install against npm latest and
// produces deterministic upgrade guidance. Never throws and never returns sensitive data.
async function inspectInstallVersion(apiRecommendedVersion) {
  let latest;
  try {
    latest = await fetchLatestPackageVersion();
  } catch (error) {
    latest = { status: "unavailable", error: sanitizeDiagnosticText(error instanceof Error ? error.message : "npm_version_check_failed") };
  }
  if (latest.status === "unavailable" && typeof apiRecommendedVersion === "string" && apiRecommendedVersion.length > 0) {
    latest = { status: "api", version: apiRecommendedVersion };
  }
  const latestVersion = typeof latest.version === "string" ? latest.version : null;
  const comparison = latestVersion ? compareSemver(packageVersion, latestVersion) : null;
  const state = classifyVersionState(latest.status, latestVersion, comparison);
  const stale = state === "stale";
  return stripUndefined({
    name: packageName,
    version: packageVersion,
    latestVersion,
    latestStatus: latest.status ?? "ok",
    state,
    updateAvailable: stale,
    upgradeCommand: stale ? upgradeCommand : undefined,
    npxFallback: stale ? npxFallbackCommand : undefined,
    detail: latest.error,
  });
}

async function inspectApiCompatibility(health) {
  try {
    const report = await apiFetch(compatibilityPath, { method: "GET" }, { auth: false, timeoutMs: 5000 });
    return { report, evaluation: evaluateApiCompatibility(report, "compatibility_endpoint") };
  } catch (error) {
    const report = {
      status: "unavailable",
      reason: "compatibility_endpoint_unavailable",
      error: sanitizeDiagnosticText(error instanceof Error ? error.message : "compatibility_check_failed"),
    };
    const fallback = evaluateApiCompatibility(health, "health");
    return {
      report,
      evaluation: fallback.reason === "not_reported" ? evaluateApiCompatibility(report, "compatibility_endpoint") : fallback,
    };
  }
}

// Prefer the first-class compatibility endpoint, but keep supporting older APIs that only
// advertise `minMcpVersion`/`minClientVersion` on /health.
function evaluateApiCompatibility(report, source) {
  if (!report || report.status === "unreachable") return { status: "unavailable", reason: "api_unreachable", source };
  if (report.status === "unavailable") {
    return stripUndefined({ status: "unavailable", reason: report.reason ?? "compatibility_unavailable", source, detail: report.error });
  }
  const minVersion = compatibilityMinimumVersion(report);
  if (!minVersion) return { status: "unavailable", reason: "not_reported", source };
  const comparison = compareSemver(packageVersion, minVersion);
  const latestRecommendedVersion = compatibilityLatestRecommendedVersion(report);
  const apiVersion = typeof report.apiVersion === "string" ? report.apiVersion : undefined;
  const warnings = Array.isArray(report.compatibilityWarnings) ? report.compatibilityWarnings : Array.isArray(report.warnings) ? report.warnings : [];
  const breakingChanges = Array.isArray(report.breakingChanges) ? report.breakingChanges : [];
  if (comparison === null) return stripUndefined({ status: "unknown", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
  if (comparison < 0) return stripUndefined({ status: "incompatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges, upgradeCommand });
  return stripUndefined({ status: "compatible", source, minVersion, latestRecommendedVersion, apiVersion, warnings, breakingChanges });
}

function compatibilityMinimumVersion(report) {
  if (typeof report?.mcp?.minimumSupportedVersion === "string") return report.mcp.minimumSupportedVersion;
  if (typeof report?.minimumSupportedMcpVersion === "string") return report.minimumSupportedMcpVersion;
  if (typeof report?.minMcpVersion === "string") return report.minMcpVersion;
  if (typeof report?.minClientVersion === "string") return report.minClientVersion;
  return null;
}

function compatibilityLatestRecommendedVersion(report) {
  if (typeof report?.mcp?.latestRecommendedVersion === "string") return report.mcp.latestRecommendedVersion;
  if (typeof report?.mcp?.latestPackageVersion === "string") return report.mcp.latestPackageVersion;
  if (typeof report?.latestRecommendedMcpVersion === "string") return report.latestRecommendedMcpVersion;
  if (typeof report?.latestPackageVersion === "string") return report.latestPackageVersion;
  return null;
}

async function analyzeCurrentBranch(input) {
  const workspace = resolveWorkspaceCwd(input);
  const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
  const { localScorerStatus, ...body } = payload;
  const analysis = await apiPost("/v1/local/branch-analysis", body);
  return {
    local: {
      sourceUpload: false,
      workspaceRoots: {
        available: workspace.rootsAvailable,
        count: workspace.rootCount,
        cwdInsideRoot: workspace.rootsAvailable ? true : undefined,
        pathsIncluded: false,
      },
      repoFullName: body.repoFullName,
      baseRef: body.baseRef,
      headRef: body.headRef,
      branchName: body.branchName,
      baseSha: body.baseSha,
      headSha: body.headSha,
      mergeBaseSha: body.mergeBaseSha,
      remoteTrackingSha: body.remoteTrackingSha,
      changedFileCount: body.changedFiles?.length ?? 0,
      testFileCount: body.changedFiles?.filter((file) => isTestFile(file.path)).length ?? 0,
      passedValidationCount: body.validation?.filter((entry) => entry.status === "passed").length ?? 0,
      localScorerStatus: sanitizeLocalScorerStatus(localScorerStatus),
      setupGuidance: setupGuidanceForLocalScorer(localScorerStatus),
    },
    analysis,
  };
}

async function agentPreparePrPacket(input) {
  const workspace = resolveWorkspaceCwd(input);
  const payload = buildBranchAnalysisPayload({ ...input, cwd: workspace.cwd });
  const { localScorerStatus: _localScorerStatus, ...body } = payload;
  return apiPost("/v1/agent/prepare-pr-packet", body);
}

// #1968 review-pr: a thin composition of the existing preflight + slop-risk + lint-pr-text checks
// into one report, so a contributor's own local agent can see everything the gate would flag before
// ever opening a PR. Reuses analyzeCurrentBranch (preflight) and collectLocalDiff (the same diff
// metadata previewLocalScore already sends) rather than reimplementing any check. Each sub-check is
// isolated with its own try/catch: one flaky endpoint degrades that section to a `failed` status with
// a public-safe reason instead of hiding the sections that did succeed.
async function reviewLocalPr(input) {
  const result = await analyzeCurrentBranch(input);
  const workspace = resolveWorkspaceCwd(input);
  const diff = collectLocalDiff(workspace.cwd, input.baseRef, input.workspaceRoots);
  const commitMessages = input.commitMessages?.length ? input.commitMessages : undefined;
  const prBody = input.body;
  const linkedIssue = input.linkedIssues?.[0];

  const slopRisk = await runReviewCheck(() =>
    apiPost("/v1/lint/slop-risk", {
      changedFiles: diff.changedFiles.map((path) => ({ path })),
      description: prBody,
      testFiles: diff.testFiles,
    }),
  );
  const prTextLint = await runReviewCheck(() =>
    apiPost("/v1/lint/pr-text", {
      ...(commitMessages ? { commitMessages } : {}),
      ...(prBody !== undefined ? { prBody } : {}),
      ...(linkedIssue !== undefined ? { linkedIssue } : {}),
    }),
  );

  const sections = [
    { name: "preflight", status: preflightSectionStatus(result.analysis.preflight?.status) },
    { name: "slop_risk", status: slopRisk.ok ? slopRiskSectionStatus(slopRisk.value) : "fail" },
    { name: "pr_text_lint", status: prTextLint.ok ? prTextLintSectionStatus(prTextLint.value) : "fail" },
  ];

  return {
    local: result.local,
    preflight: result.analysis.preflight,
    prPacket: result.analysis.prPacket,
    workspaceIntelligence: publicSafeWorkspaceIntelligence(result.analysis.workspaceIntelligence),
    slopRisk: slopRisk.ok ? slopRisk.value : undefined,
    slopRiskError: slopRisk.ok ? undefined : slopRisk.reason,
    prTextLint: prTextLint.ok ? prTextLint.value : undefined,
    prTextLintError: prTextLint.ok ? undefined : prTextLint.reason,
    overallStatus: reviewOverallStatus(sections),
    sections,
  };
}

async function runReviewCheck(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "review_check_failed" };
  }
}

function preflightSectionStatus(status) {
  if (status === "hold") return "fail";
  if (status === "needs_work") return "warn";
  return "pass";
}

function slopRiskSectionStatus(value) {
  if (value?.band === "high" || value?.band === "elevated") return "warn";
  return "pass";
}

function prTextLintSectionStatus(value) {
  if (value?.verdict === "weak") return "warn";
  return "pass";
}

function reviewOverallStatus(sections) {
  if (sections.some((section) => section.status === "fail")) return "fail";
  if (sections.some((section) => section.status === "warn")) return "warn";
  return "pass";
}

async function previewLocalScore(input) {
  const workspace = resolveWorkspaceCwd(input);
  const cwd = workspace.cwd;
  const diff = collectLocalDiff(cwd, input.baseRef, input.workspaceRoots);
  const branchPayload = buildBranchAnalysisPayload({ ...input, login: input.contributorLogin ?? "local", cwd, repoFullName: input.repoFullName, baseRef: input.baseRef });
  const upstreamPreview = branchPayload.localScorerStatus;
  const estimatedSourceLines = input.sourceLines ?? Math.max(1, diff.changedLineCount - diff.testFiles.length);
  const body = {
    repoFullName: input.repoFullName,
    targetType: "local_diff",
    targetKey: input.targetKey ?? localDiffTargetKey(branchPayload, input.baseRef),
    contributorLogin: input.contributorLogin,
    labels: input.labels,
    linkedIssueMode: input.linkedIssueMode,
    sourceTokenScore: input.sourceTokenScore ?? estimatedSourceLines,
    sourceLines: estimatedSourceLines,
    totalTokenScore: input.totalTokenScore ?? diff.changedLineCount,
    testTokenScore: diff.testFiles.length,
    openPrCount: input.openPrCount,
    credibility: input.credibility,
    changesRequestedCount: input.changesRequestedCount,
    pendingMergedPrCount: input.pendingMergedPrCount,
    pendingClosedPrCount: input.pendingClosedPrCount,
    approvedPrCount: input.approvedPrCount,
    expectedOpenPrCountAfterMerge: input.expectedOpenPrCountAfterMerge,
    projectedCredibility: input.projectedCredibility,
    scenarioNotes: input.scenarioNotes,
    branchEligibility: input.branchEligibility,
    metadataOnly: !upstreamPreview.ok,
  };
  return {
    localDiff: {
      changedFiles: diff.changedFiles,
      changedLineCount: diff.changedLineCount,
      testFiles: diff.testFiles,
      codeFiles: diff.codeFiles,
      commitMessage: input.commitMessage ?? diff.commitMessage,
    },
    upstreamPreview: sanitizeLocalScorerStatus(upstreamPreview),
    remotePreview: await apiPost("/v1/scoring/preview", body),
    setupGuidance: upstreamPreview.ok
      ? []
      : setupGuidanceForLocalScorer(upstreamPreview),
  };
}

function localDiffTargetKey(branchPayload, baseRef) {
  return [
    branchPayload.repoFullName,
    branchPayload.branchName ?? branchPayload.headRef ?? "local",
    branchPayload.headSha ?? baseRef ?? "diff",
  ]
    .filter(Boolean)
    .join(":");
}

function branchEligibilityFromOptions(options) {
  const status = options.branchEligibility ?? options.branchEligibilityStatus;
  if (!["eligible", "ineligible", "unknown"].includes(status)) return undefined;
  const source = ["github_metadata", "local_metadata", "registry", "user_supplied"].includes(options.branchEligibilitySource) ? options.branchEligibilitySource : "user_supplied";
  return stripUndefined({
    status,
    source,
    reason: options.branchEligibilityReason,
    checkedAt: options.branchEligibilityCheckedAt,
    stale: optionalBoolean(options.branchEligibilityStale),
  });
}

function optionalBoolean(value) {
  if (value === undefined) return undefined;
  if (value === true) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "no", "off"].includes(normalized)) return false;
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
  }
  return Boolean(value);
}

function toolResult(summary, data) {
  return {
    content: [
      {
        type: "text",
        text: `${summary}\n\n${JSON.stringify(data, null, 2)}`,
      },
    ],
    structuredContent: data,
  };
}

function camel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, stripUndefined(entry)]));
}
