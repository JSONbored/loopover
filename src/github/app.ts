import { Octokit } from "@octokit/core";
import type { Advisory, GitHubWebhookPayload } from "../types";
import { signRs256Jwt } from "../utils/crypto";
import { evaluateGateCheck, formatCheckRunOutput, formatGateCheckOutput, type GateCheckConclusion, type GateCheckPolicy } from "../rules/advisory";

type CheckRunResponse = {
  id: number;
  html_url?: string;
};

type CheckRunListResponse = {
  check_runs?: Array<{
    id: number;
    html_url?: string;
    name?: string;
  }>;
};

export type CheckRunOutcome =
  | { kind: "published"; id: number; html_url?: string }
  | { kind: "permission_missing"; warning: string };

export const GITTENSORY_CONTEXT_CHECK_NAME = "Gittensory Context";
export const GITTENSORY_GATE_CHECK_NAME = "Gittensory Gate";

type GitHubCheckConclusion = Advisory["conclusion"] | GateCheckConclusion | "skipped";
type GitHubCheckStatus = "queued" | "in_progress" | "completed";

export async function createInstallationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await createAppJwt(env);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to create GitHub installation token (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { token?: string };
  if (!payload.token) throw new Error("GitHub installation token response did not include a token.");
  return payload.token;
}

export async function getAppInstallation(env: Env, installationId: number): Promise<NonNullable<GitHubWebhookPayload["installation"]>> {
  const jwt = await createAppJwt(env);
  const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch GitHub App installation (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as NonNullable<GitHubWebhookPayload["installation"]>;
  if (!payload.id) throw new Error("GitHub installation response did not include an id.");
  return payload;
}

export type GitHubRepositoryCollaboratorPermission = "admin" | "maintain" | "write" | "triage" | "read" | "none" | string;

export async function getRepositoryCollaboratorPermission(
  env: Env,
  installationId: number,
  repoFullName: string,
  login: string,
): Promise<GitHubRepositoryCollaboratorPermission | null> {
  const [owner, name] = repoFullName.split("/");
  if (!owner || !name || !login) return null;
  const token = await createInstallationToken(env, installationId);
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/collaborators/${encodeURIComponent(login)}/permission`,
    { headers: githubHeaders(`Bearer ${token}`) },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch GitHub collaborator permission (${response.status}): ${body.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { permission?: GitHubRepositoryCollaboratorPermission };
  return payload.permission ?? null;
}

async function createAppJwt(env: Env): Promise<string> {
  if (!env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured.");
  }
  const now = Math.floor(Date.now() / 1000);
  return signRs256Jwt(
    {
      iss: env.GITHUB_APP_ID,
      iat: now - 60,
      exp: now + 540,
    },
    env.GITHUB_APP_PRIVATE_KEY,
  );
}

export async function createOrUpdateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  detailLevel: "minimal" | "standard" | "deep" = "minimal",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(env, installationId, repoFullName, advisory, {
    name: GITTENSORY_CONTEXT_CHECK_NAME,
    conclusion: advisory.conclusion,
    output: formatCheckRunOutput(advisory, detailLevel),
  });
}

export async function createOrUpdateGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  policy: GateCheckPolicy = {},
  options: { checkRunId?: number | undefined } = {},
): Promise<CheckRunOutcome | null> {
  const gate = evaluateGateCheck(advisory, policy);
  return createOrUpdateNamedCheckRun(env, installationId, repoFullName, advisory, {
    name: GITTENSORY_GATE_CHECK_NAME,
    status: "completed",
    conclusion: gate.conclusion,
    output: formatGateCheckOutput(gate),
    checkRunId: options.checkRunId,
  });
}

export async function createOrUpdatePendingGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(env, installationId, repoFullName, advisory, {
    name: GITTENSORY_GATE_CHECK_NAME,
    status: "in_progress",
    output: {
      title: "Gittensory Gate is evaluating",
      summary: "Gittensory is running deterministic public PR hygiene checks.",
      text: "The Gate preserves legacy linked-issue and duplicate-PR blockers unless this repository explicitly sets those rules to advisory or off.",
    },
  });
}

export async function createOrUpdateSkippedGateCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  reason = "PR closed before full evaluation.",
): Promise<CheckRunOutcome | null> {
  return createOrUpdateNamedCheckRun(env, installationId, repoFullName, advisory, {
    name: GITTENSORY_GATE_CHECK_NAME,
    status: "completed",
    conclusion: "skipped",
    output: {
      title: "Gittensory Gate skipped",
      summary: reason,
      text: "Gittensory does not post late first comments on closed or merged pull requests.",
    },
  });
}

async function createOrUpdateNamedCheckRun(
  env: Env,
  installationId: number,
  repoFullName: string,
  advisory: Advisory,
  check: {
    name: string;
    status?: GitHubCheckStatus | undefined;
    conclusion?: GitHubCheckConclusion | undefined;
    output: { title: string; summary: string; text: string };
    checkRunId?: number | undefined;
  },
): Promise<CheckRunOutcome | null> {
  if (!advisory.headSha) return null;
  const [owner, repo] = repoFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repoFullName}`);

  const token = await createInstallationToken(env, installationId);
  const octokit = new Octokit({ auth: token });

  try {
    if (check.checkRunId) {
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner,
        repo,
        check_run_id: check.checkRunId,
        name: check.name,
        /* v8 ignore next 2 -- Exported check helpers always provide status/conclusion for known-id finalization. */
        status: check.status ?? "completed",
        ...(check.conclusion ? { conclusion: check.conclusion } : {}),
        output: check.output,
      });
      const data = response.data as CheckRunResponse;
      return publishedOutcome(data);
    }

    const existing = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: advisory.headSha,
      check_name: check.name,
      filter: "latest",
      per_page: 1,
    });
    const existingCheckRun = (existing.data as CheckRunListResponse).check_runs?.[0];
    if (existingCheckRun) {
      const response = await octokit.request("PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}", {
        owner,
        repo,
        check_run_id: existingCheckRun.id,
        name: check.name,
        status: check.status ?? "completed",
        ...(check.conclusion ? { conclusion: check.conclusion } : {}),
        output: check.output,
      });
      const data = response.data as CheckRunResponse;
      return publishedOutcome(data);
    }

    const response = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: check.name,
      head_sha: advisory.headSha,
      status: check.status ?? "completed",
      ...(check.conclusion ? { conclusion: check.conclusion } : {}),
      output: check.output,
    });
    const data = response.data as CheckRunResponse;
    return publishedOutcome(data);
  } catch (error) {
    if (isCheckRunPermissionError(error)) {
      return {
        kind: "permission_missing",
        warning: "GitHub App Checks: write permission is missing. Enable it in the GitHub App settings and re-approve the installation.",
      };
    }
    throw error;
  }
}

function publishedOutcome(data: CheckRunResponse): CheckRunOutcome {
  const outcome: { kind: "published"; id: number; html_url?: string } = { kind: "published", id: data.id };
  if (data.html_url) outcome.html_url = data.html_url;
  return outcome;
}

function isCheckRunPermissionError(error: unknown): boolean {
  /* v8 ignore next -- Octokit wraps thrown fetch values in HttpError objects before this helper sees them. */
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: number; message?: string };
  if (e.status === 403) return true;
  return typeof e.message === "string" && /resource not accessible by integration|not have permission/i.test(e.message);
}

export function getInstallationId(payload: GitHubWebhookPayload): number | null {
  return payload.installation?.id ?? null;
}

function githubHeaders(authorization: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "gittensory/0.1",
    "x-github-api-version": "2022-11-28",
  };
}
