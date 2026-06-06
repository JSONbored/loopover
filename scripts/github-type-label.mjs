import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BUG_LABEL = "gittensor:bug";
const FEATURE_LABEL = "gittensor:feature";
const PRIORITY_LABEL = "gittensor:priority";
const AUTO_TYPE_LABELS = new Set([BUG_LABEL, FEATURE_LABEL]);
const SCORING_LABELS = new Set([BUG_LABEL, FEATURE_LABEL, PRIORITY_LABEL]);
const FEATURE_SOURCE_LABELS = new Set(["feature", FEATURE_LABEL]);
const MAX_CLOSING_ISSUE_REFERENCES = 5;
const LABEL_DEFINITIONS = {
  [BUG_LABEL]: { color: "d73a4a", description: "Gittensor-scored bug fix" },
  [FEATURE_LABEL]: { color: "0e8a16", description: "Gittensor-scored feature linked to a feature issue" },
};

export function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === "string") return label;
      if (label && typeof label === "object" && typeof label.name === "string") return label.name;
      return "";
    })
    .filter(Boolean)
    .map((label) => label.toLowerCase());
}

export function classifyTypeLabel(title, labels = []) {
  const normalizedLabels = normalizeLabels(labels);
  if (hasScoringLabel(normalizedLabels)) return null;

  const normalizedTitle = String(title ?? "").trim();
  if (isBugTitle(normalizedTitle)) {
    return BUG_LABEL;
  }
  if (isFeatureTitle(normalizedTitle)) {
    return FEATURE_LABEL;
  }
  return null;
}

export function getTypeLabelDecision(eventName, payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return { action: "skip", reason: "missing-event-payload" };
  }

  if (eventName === "issues") {
    const issue = payload.issue;
    if (!issue || typeof issue !== "object") return { action: "skip", reason: "missing-issue" };
    if (issue.pull_request) return { action: "skip", reason: "issue-is-pull-request", number: numberOrUndefined(issue.number), title: stringOrEmpty(issue.title) };

    const label = classifyTypeLabel(issue.title, issue.labels);
    if (!label) return { action: "skip", reason: "no-type-label", number: numberOrUndefined(issue.number), title: stringOrEmpty(issue.title) };
    return { action: "apply", label, number: issue.number, title: stringOrEmpty(issue.title) };
  }

  if (eventName === "pull_request_target") {
    const pullRequest = payload.pull_request;
    if (!pullRequest || typeof pullRequest !== "object") return { action: "skip", reason: "missing-pull-request" };

    const decision = classifyPullRequestLabel(pullRequest, options.issueReferences ?? []);
    if (!decision.label) return { action: "skip", reason: decision.reason, number: numberOrUndefined(pullRequest.number), title: stringOrEmpty(pullRequest.title) };
    return { action: "apply", label: decision.label, number: pullRequest.number, title: stringOrEmpty(pullRequest.title) };
  }

  return { action: "skip", reason: "unsupported-event" };
}

export async function applyTypeLabel({ apiUrl = "https://api.github.com", repository, token, number, label, fetchImpl = fetch }) {
  const [owner, repo, ...extraParts] = String(repository ?? "").split("/");
  if (!owner || !repo || extraParts.length > 0) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!Number.isInteger(number) || number <= 0) throw new Error("Issue or pull request number must be a positive integer");
  if (!AUTO_TYPE_LABELS.has(label)) throw new Error(`Unsupported type label: ${label}`);

  const issueLabelsUrl = `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  const labels = await readCurrentLabels({ issueLabelsUrl, headers, fetchImpl });
  if (labels.some((currentLabel) => SCORING_LABELS.has(currentLabel))) {
    return { applied: false, reason: "type-label-already-present" };
  }

  const labelReady = await ensureRepositoryLabel({ apiUrl, owner, repo, headers, label, fetchImpl });
  if (!labelReady.created && labelReady.reason) {
    return { applied: false, reason: labelReady.reason };
  }

  const response = await fetchImpl(issueLabelsUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ labels: [label] }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (isLabelWriteForbidden(response.status, text)) {
      return { applied: false, reason: "label-write-forbidden" };
    }
    throw new Error(`Failed to apply ${label} to #${number}: ${response.status} ${text}`);
  }
  return { applied: true };
}

export async function ensureRepositoryLabel({ apiUrl = "https://api.github.com", owner, repo, headers, label, fetchImpl = fetch }) {
  const definition = LABEL_DEFINITIONS[label];
  if (!definition) return { created: false };

  const baseUrl = `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`;
  const labelUrl = `${baseUrl}/${encodeURIComponent(label)}`;
  const existing = await fetchImpl(labelUrl, { method: "GET", headers });
  if (existing.ok) return { created: false };

  const existingText = await existing.text();
  if (existing.status !== 404) {
    if (isLabelWriteForbidden(existing.status, existingText)) return { created: false, reason: "label-write-forbidden" };
    throw new Error(`Failed to read repository label ${label}: ${existing.status} ${existingText}`);
  }

  const created = await fetchImpl(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: label, color: definition.color, description: definition.description }),
  });
  if (created.ok) return { created: true };

  const createdText = await created.text();
  if (/already exists|already_exists/i.test(createdText)) return { created: false };
  if (isLabelWriteForbidden(created.status, createdText)) return { created: false, reason: "label-write-forbidden" };
  throw new Error(`Failed to create repository label ${label}: ${created.status} ${createdText}`);
}

export function extractClosingIssueNumbers(text, { maxCount = MAX_CLOSING_ISSUE_REFERENCES } = {}) {
  const body = String(text ?? "");
  const limit = Number.isInteger(maxCount) && maxCount > 0 ? maxCount : 0;
  if (limit === 0) return [];

  const numbers = new Set();
  const closingRef = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of body.matchAll(closingRef)) {
    const number = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(number) && number > 0) numbers.add(number);
    if (numbers.size >= limit) break;
  }
  return [...numbers];
}

export async function fetchReferencedIssues({ apiUrl = "https://api.github.com", repository, token, body, maxReferences = MAX_CLOSING_ISSUE_REFERENCES, fetchImpl = fetch }) {
  const [owner, repo, ...extraParts] = String(repository ?? "").split("/");
  if (!owner || !repo || extraParts.length > 0) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const numbers = extractClosingIssueNumbers(body, { maxCount: maxReferences });
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };

  const issues = [];
  for (const number of numbers) {
    const issueUrl = `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
    const response = await fetchImpl(issueUrl, { method: "GET", headers });
    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404) continue;
      throw new Error(`Failed to read referenced issue #${number}: ${response.status} ${text}`);
    }
    issues.push(await response.json());
  }
  return issues;
}

export async function readCurrentLabels({ issueLabelsUrl, headers, fetchImpl = fetch }) {
  const labels = [];
  let nextUrl = `${issueLabelsUrl}?per_page=100`;

  while (nextUrl) {
    const response = await fetchImpl(nextUrl, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to read labels: ${response.status} ${text}`);
    }

    labels.push(...normalizeLabels(await response.json()));
    nextUrl = nextLink(response.headers.get("link"));
  }

  return labels;
}

export async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");

  const payload = JSON.parse(await readFile(eventPath, "utf8"));
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const issueReferences = shouldFetchReferencedIssues(eventName, payload)
    ? await fetchReferencedIssues({
        apiUrl: process.env.GITHUB_API_URL,
        repository: process.env.GITHUB_REPOSITORY ?? "",
        token: process.env.GITHUB_TOKEN ?? "",
        body: payload.pull_request?.body ?? "",
      })
    : [];
  const decision = getTypeLabelDecision(eventName, payload, { issueReferences });
  if (decision.action === "skip") {
    console.log(`type-label: skipped ${decision.reason}`);
    return;
  }

  const result = await applyTypeLabel({
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
    number: decision.number,
    label: decision.label,
  });
  if (!result.applied) {
    console.log(`type-label: skipped ${result.reason}`);
    return;
  }
  console.log(`type-label: applied ${decision.label} to #${decision.number}`);
}

function numberOrUndefined(value) {
  return Number.isInteger(value) ? value : undefined;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value : "";
}

function shouldFetchReferencedIssues(eventName, payload) {
  if (eventName !== "pull_request_target") return false;
  const pullRequest = payload?.pull_request;
  if (!pullRequest || typeof pullRequest !== "object") return false;
  if (hasScoringLabel(normalizeLabels(pullRequest.labels))) return false;
  return isFeatureTitle(String(pullRequest.title ?? "").trim());
}

function classifyPullRequestLabel(pullRequest, issueReferences) {
  const normalizedLabels = normalizeLabels(pullRequest.labels);
  if (hasScoringLabel(normalizedLabels)) return { label: null, reason: "type-label-already-present" };

  const title = String(pullRequest.title ?? "").trim();
  if (isBugTitle(title)) return { label: BUG_LABEL, reason: "" };
  if (!isFeatureTitle(title)) return { label: null, reason: "no-type-label" };
  if (issueReferences.some(isFeatureIssue)) return { label: FEATURE_LABEL, reason: "" };
  return { label: null, reason: "feature-pr-missing-feature-issue" };
}

function isFeatureIssue(issue) {
  if (!issue || typeof issue !== "object" || issue.pull_request) return false;
  const labels = normalizeLabels(issue.labels);
  return labels.some((label) => FEATURE_SOURCE_LABELS.has(label)) || isFeatureTitle(issue.title);
}

function hasScoringLabel(labels) {
  return labels.some((label) => SCORING_LABELS.has(label));
}

function isBugTitle(title) {
  return /^\[bug\]\s*:?\s*/i.test(title) || /^(?:fix|bug)(?:\([^)]+\))?:/i.test(title);
}

function isFeatureTitle(title) {
  return /^\[feature\]\s*:?\s*/i.test(title) || /^(?:feat|feature)(?:\([^)]+\))?:/i.test(title);
}

function nextLink(linkHeader) {
  if (!linkHeader) return "";
  for (const part of linkHeader.split(",")) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/);
    if (match) return match[1];
  }
  return "";
}

function isLabelWriteForbidden(status, text) {
  return status === 403 && /resource not accessible by integration/i.test(text);
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entrypointUrl) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
