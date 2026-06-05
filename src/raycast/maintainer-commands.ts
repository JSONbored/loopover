import { sanitizePublicComment } from "../github/commands";

export type RaycastCommandFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  json: () => Promise<unknown>;
}>;

export type RaycastRepoTarget = {
  owner: string;
  repo: string;
  repoFullName: string;
};

export type RaycastApiClient = {
  apiOrigin: string;
  sessionToken: string;
  fetchImpl: RaycastCommandFetch;
};

export type RaycastPublicSurfaceSummary = {
  commentMode: string;
  labelMode: string;
  checkMode: string;
  publicSurface: string;
  summary: string;
};

export type RaycastInstallHealthSummary = {
  status: "healthy" | "needs_attention" | "not_installed" | "unavailable";
  installationId: number | null;
  missingPermissions: string[];
  missingEvents: string[];
  details: string[];
  nextActions: string[];
};

export type RaycastMaintainerQueueCommand = {
  command: "maintainer_queue";
  repo: RaycastRepoTarget;
  generatedAt: string | null;
  queue: {
    level: string;
    openPullRequests: number | null;
    openIssues: number | null;
    likelyReviewablePullRequests: number | null;
    warnings: string[];
  };
  installHealth: RaycastInstallHealthSummary;
  publicSurface: RaycastPublicSurfaceSummary;
  privateView: {
    localOnly: true;
    sections: string[];
  };
  actions: Array<{
    id: string;
    title: string;
    mode: "private_view" | "preview_only";
    endpoint: string;
    mutatesGitHub: false;
  }>;
  privacy: {
    sourceUpload: false;
    storesGitHubPat: false;
    githubMutations: false;
    publicPacketIncludesPrivateContext: false;
  };
};

export type RaycastPublicPreviewCommand = {
  command: "public_preview";
  repo: RaycastRepoTarget;
  pullNumber: number;
  body: string;
  decision: Record<string, unknown>;
  warnings: string[];
  privacy: {
    previewOnly: true;
    sourceUpload: false;
    githubMutations: false;
    publicPacketIncludesPrivateContext: false;
  };
};

const DEFAULT_PUBLIC_SURFACE = "confirmed-miner-only";
export function parseRaycastRepoInput(input: string): RaycastRepoTarget {
  const trimmed = input.trim();
  const fromUrl = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+)(?:[/?#].*)?$/i);
  const fromPair = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  const match = fromUrl ?? fromPair;
  if (!match?.[1] || !match?.[2]) {
    throw new Error("Raycast repo input must be owner/repo or a GitHub repository URL.");
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  return { owner, repo, repoFullName: `${owner}/${repo}` };
}

export async function runRaycastMaintainerQueueCommand(args: {
  client: RaycastApiClient;
  repoInput: string;
}): Promise<RaycastMaintainerQueueCommand> {
  const repo = parseRaycastRepoInput(args.repoInput);
  const [intelligence, settings] = await Promise.all([
    fetchRaycastJson(args.client, `/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/intelligence`),
    fetchRaycastJson(args.client, `/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/settings`).catch(() => null),
  ]);
  const repoRecord = recordAt(intelligence, "repo");
  const installationId = numberAt(repoRecord, "installationId");
  const installHealth = installationId === null
    ? notInstalledHealth()
    : summarizeInstallHealth(
        await fetchRaycastJson(args.client, `/v1/installations/${installationId}/health`).catch(() => null),
        installationId,
      );
  return {
    command: "maintainer_queue",
    repo,
    generatedAt: stringAt(intelligence, "generatedAt"),
    queue: summarizeQueue(intelligence),
    installHealth,
    publicSurface: summarizePublicSurface(settings),
    privateView: {
      localOnly: true,
      sections: privateSections(intelligence),
    },
    actions: [
      {
        id: "view_private_queue",
        title: "View private queue context in Raycast",
        mode: "private_view",
        endpoint: `/v1/repos/${repo.repoFullName}/intelligence`,
        mutatesGitHub: false,
      },
      {
        id: "preview_public_output",
        title: "Preview public-safe command output",
        mode: "preview_only",
        endpoint: "/v1/app/commands/preview",
        mutatesGitHub: false,
      },
    ],
    privacy: {
      sourceUpload: false,
      storesGitHubPat: false,
      githubMutations: false,
      publicPacketIncludesPrivateContext: false,
    },
  };
}

export async function runRaycastInstallHealthCommand(args: {
  client: RaycastApiClient;
  repoInput: string;
}): Promise<{ command: "install_health"; repo: RaycastRepoTarget; installHealth: RaycastInstallHealthSummary }> {
  const repo = parseRaycastRepoInput(args.repoInput);
  const intelligence = await fetchRaycastJson(args.client, `/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/intelligence`);
  const installationId = numberAt(recordAt(intelligence, "repo"), "installationId");
  return {
    command: "install_health",
    repo,
    installHealth: installationId === null
      ? notInstalledHealth()
      : summarizeInstallHealth(
          await fetchRaycastJson(args.client, `/v1/installations/${installationId}/health`).catch(() => null),
          installationId,
        ),
  };
}

export async function runRaycastPublicPreviewCommand(args: {
  client: RaycastApiClient;
  repoInput: string;
  pullNumber: number;
  command?: string;
  maintainerLogin?: string;
}): Promise<RaycastPublicPreviewCommand> {
  const repo = parseRaycastRepoInput(args.repoInput);
  if (!Number.isInteger(args.pullNumber) || args.pullNumber <= 0) {
    throw new Error("Raycast preview requires a positive pull request number.");
  }
  const payload = await fetchRaycastJson(args.client, "/v1/app/commands/preview", {
    command: args.command ?? "@gittensory queue-summary",
    repoFullName: repo.repoFullName,
    pullNumber: args.pullNumber,
    sample: {
      commenterLogin: args.maintainerLogin ?? "maintainer",
      commenterAssociation: "OWNER",
    },
  });
  const preview = recordAt(payload, "preview");
  const body = sanitizePreviewBody(stringAt(preview, "body") ?? "");
  return {
    command: "public_preview",
    repo,
    pullNumber: args.pullNumber,
    body,
    decision: recordAt(preview, "decision"),
    warnings: arrayOfStrings(preview, "warnings"),
    privacy: {
      previewOnly: true,
      sourceUpload: false,
      githubMutations: false,
      publicPacketIncludesPrivateContext: false,
    },
  };
}

async function fetchRaycastJson(client: RaycastApiClient, path: string, body?: Record<string, unknown>): Promise<unknown> {
  const url = new URL(path, client.apiOrigin);
  const response = await client.fetchImpl(url.toString(), {
    method: body ? "POST" : "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${client.sessionToken}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorFromPayload(payload, response));
  }
  return payload;
}

function summarizeQueue(intelligence: unknown): RaycastMaintainerQueueCommand["queue"] {
  const queueHealth = recordAt(intelligence, "queueHealth");
  const signals = recordAt(queueHealth, "signals");
  return {
    level: stringAt(queueHealth, "level") ?? "unknown",
    openPullRequests: numberAt(signals, "openPullRequests"),
    openIssues: numberAt(signals, "openIssues"),
    likelyReviewablePullRequests: numberAt(signals, "likelyReviewablePullRequests"),
    warnings: arrayOfStrings(recordAt(intelligence, "dataQuality"), "warnings"),
  };
}

function summarizePublicSurface(settings: unknown): RaycastPublicSurfaceSummary {
  const commentMode = stringAt(settings, "commentMode") ?? "unknown";
  const labelMode = booleanAt(settings, "autoLabelEnabled") === false ? "disabled" : "configured";
  const checkMode = stringAt(settings, "checkRunMode") ?? "unknown";
  const publicSurface = stringAt(settings, "publicSurface") ?? DEFAULT_PUBLIC_SURFACE;
  return {
    commentMode,
    labelMode,
    checkMode,
    publicSurface,
    summary: `Comments: ${commentMode}; labels: ${labelMode}; checks: ${checkMode}; public surface: ${publicSurface}.`,
  };
}

function summarizeInstallHealth(payload: unknown, installationId: number): RaycastInstallHealthSummary {
  if (!payload || typeof payload !== "object") {
    return {
      status: "unavailable",
      installationId,
      missingPermissions: [],
      missingEvents: [],
      details: ["Installation health is unavailable from the current API response."],
      nextActions: ["Refresh installation health, then retry the Raycast command."],
    };
  }
  const missingPermissions = arrayOfStrings(payload, "missingPermissions");
  const missingEvents = arrayOfStrings(payload, "missingEvents");
  const status = missingPermissions.length === 0 && missingEvents.length === 0 && stringAt(payload, "status") === "healthy"
    ? "healthy"
    : "needs_attention";
  return {
    status,
    installationId,
    missingPermissions,
    missingEvents,
    details: [
      status === "healthy" ? "GitHub App installation is healthy." : "GitHub App installation needs attention.",
      ...missingPermissions.map((permission) => `Missing GitHub App permission: ${permission}.`),
      ...missingEvents.map((event) => `Missing GitHub App event subscription: ${event}.`),
    ],
    nextActions: [
      ...missingPermissions.map((permission) => `Grant ${permission} permission, then approve the GitHub App permission update.`),
      ...missingEvents.map((event) => `Enable the ${event} webhook event, then refresh installation health.`),
      ...(missingPermissions.length === 0 && missingEvents.length === 0 ? ["No installation repair action is required."] : []),
    ],
  };
}

function notInstalledHealth(): RaycastInstallHealthSummary {
  return {
    status: "not_installed",
    installationId: null,
    missingPermissions: [],
    missingEvents: [],
    details: ["No GitHub App installation is linked to this repository."],
    nextActions: ["Install the Gittensory GitHub App for this repository before using maintainer queue automation."],
  };
}

function privateSections(intelligence: unknown): string[] {
  return [
    ...privateSectionLine(intelligence, "maintainerLane", "Maintainer lane"),
    ...privateSectionLine(intelligence, "maintainerCutReadiness", "Maintainer cut readiness"),
    ...privateSectionLine(intelligence, "contributorIntakeHealth", "Contributor intake health"),
  ];
}

function privateSectionLine(source: unknown, key: string, label: string): string[] {
  const value = recordAt(source, key);
  if (Object.keys(value).length === 0) return [];
  const status = stringAt(value, "status") ?? stringAt(value, "level") ?? "available";
  return [`${label}: ${status}`];
}

function sanitizePreviewBody(body: string): string {
  return sanitizePublicComment(body);
}

function errorFromPayload(payload: unknown, response: { status: number; statusText?: string }): string {
  const error = stringAt(payload, "error");
  return error ?? `${response.status} ${response.statusText ?? "Raycast API request failed"}`;
}

function recordAt(source: unknown, key: string): Record<string, unknown> {
  if (!source || typeof source !== "object") return {};
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringAt(source: unknown, key: string): string | null {
  const value = valueAt(source, key);
  return typeof value === "string" ? value : null;
}

function numberAt(source: unknown, key: string): number | null {
  const value = valueAt(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanAt(source: unknown, key: string): boolean | null {
  const value = valueAt(source, key);
  return typeof value === "boolean" ? value : null;
}

function arrayOfStrings(source: unknown, key: string): string[] {
  const value = valueAt(source, key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function valueAt(source: unknown, key: string): unknown {
  if (!source || typeof source !== "object") return undefined;
  return (source as Record<string, unknown>)[key];
}
