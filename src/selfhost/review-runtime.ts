import type { JobMessage } from "../types";

const REVIEW_EXECUTION_JOB_TYPES = new Set<string>([
  "github-webhook",
  "recapture-preview",
  "agent-regate-pr",
  "agent-regate-sweep",
  "run-agent",
  "notify-evaluate",
  "notify-deliver",
  "ops-alerts",
  "selftune",
  "rag-index-repo",
  "submit-draft",
]);

export function isSelfHostedReviewRuntime(env: Pick<Env, "SELFHOST_TRANSIENT_CACHE">): boolean {
  return Boolean(env.SELFHOST_TRANSIENT_CACHE);
}

export function isReviewExecutionJob(job: JobMessage | null | undefined): boolean {
  return REVIEW_EXECUTION_JOB_TYPES.has(job?.type ?? "");
}
