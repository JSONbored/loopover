import type { GitHubWebhookPayload } from "../types";

type GitHubAppRef = {
  slug?: string | null;
};

type CheckRunWebhookNode = {
  app?: GitHubAppRef | null;
  check_suite?: {
    app?: GitHubAppRef | null;
  } | null;
};

type CheckSuiteWebhookNode = {
  app?: GitHubAppRef | null;
};

function normalizeGitHubSlug(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function ownAppSlug(env: Env): string {
  return normalizeGitHubSlug(env.GITHUB_APP_SLUG);
}

function appSlugMatches(env: Env, app: GitHubAppRef | null | undefined): boolean {
  const expected = ownAppSlug(env);
  return expected !== "" && normalizeGitHubSlug(app?.slug) === expected;
}

function ciCompletionApp(
  eventName: "check_run" | "check_suite",
  payload: GitHubWebhookPayload,
): GitHubAppRef | null | undefined {
  const record = payload as Record<string, unknown>;
  if (eventName === "check_suite") {
    return (record.check_suite as CheckSuiteWebhookNode | undefined)?.app;
  }
  const checkRun = record.check_run as CheckRunWebhookNode | undefined;
  return checkRun?.app ?? checkRun?.check_suite?.app;
}

export function isSelfAuthoredAppCommentWebhook(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): boolean {
  if (eventName !== "issue_comment") return false;
  if (payload.action !== "created" && payload.action !== "edited") return false;
  const slug = ownAppSlug(env);
  if (!slug) return false;
  const botLogin = `${slug}[bot]`;
  return (
    payload.sender?.type === "Bot" &&
    payload.sender.login?.toLowerCase() === botLogin &&
    payload.comment?.user?.type === "Bot" &&
    payload.comment.user.login?.toLowerCase() === botLogin
  );
}

export function isSelfAuthoredCiCompletionWebhook(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): boolean {
  if (eventName !== "check_run" && eventName !== "check_suite") return false;
  if (payload.action !== "completed") return false;
  return appSlugMatches(env, ciCompletionApp(eventName, payload));
}

export function isSelfAuthoredWebhookNoise(
  env: Env,
  eventName: string,
  payload: GitHubWebhookPayload,
): boolean {
  return (
    isSelfAuthoredAppCommentWebhook(env, eventName, payload) ||
    isSelfAuthoredCiCompletionWebhook(env, eventName, payload)
  );
}
