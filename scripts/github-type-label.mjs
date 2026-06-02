#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TYPE_LABELS = new Set(["bug", "feature"]);

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
  if (normalizedLabels.some((label) => TYPE_LABELS.has(label))) return null;

  const normalizedTitle = String(title ?? "").trim();
  if (/^\[bug\]\s*:?\s*/i.test(normalizedTitle) || /^(?:fix|bug)(?:\([^)]+\))?:/i.test(normalizedTitle)) {
    return "bug";
  }
  if (/^\[feature\]\s*:?\s*/i.test(normalizedTitle) || /^(?:feat|feature)(?:\([^)]+\))?:/i.test(normalizedTitle)) {
    return "feature";
  }
  return null;
}

export function getTypeLabelDecision(eventName, payload) {
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

    const label = classifyTypeLabel(pullRequest.title, pullRequest.labels);
    if (!label) return { action: "skip", reason: "no-type-label", number: numberOrUndefined(pullRequest.number), title: stringOrEmpty(pullRequest.title) };
    return { action: "apply", label, number: pullRequest.number, title: stringOrEmpty(pullRequest.title) };
  }

  return { action: "skip", reason: "unsupported-event" };
}

export async function applyTypeLabel({ apiUrl = "https://api.github.com", repository, token, number, label, fetchImpl = fetch }) {
  const [owner, repo, ...extraParts] = String(repository ?? "").split("/");
  if (!owner || !repo || extraParts.length > 0) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!Number.isInteger(number) || number <= 0) throw new Error("Issue or pull request number must be a positive integer");
  if (!TYPE_LABELS.has(label)) throw new Error(`Unsupported type label: ${label}`);

  const issueLabelsUrl = `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/labels`;
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };

  const labels = await readCurrentLabels({ issueLabelsUrl, headers, fetchImpl });
  if (labels.some((currentLabel) => TYPE_LABELS.has(currentLabel))) {
    return { applied: false, reason: "type-label-already-present" };
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
  const decision = getTypeLabelDecision(process.env.GITHUB_EVENT_NAME ?? "", payload);
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
