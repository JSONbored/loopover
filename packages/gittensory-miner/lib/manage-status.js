/** Manage-phase event vocabulary — later phases append these to the local event ledger (#2325). */
export const MANAGE_STATUS_EVENT_TYPE = "manage_pr_update";

const portfolioPrIdentifierPattern = /^pr:(\d+)$/;

function parsePortfolioPullNumber(identifier) {
  if (typeof identifier !== "string") return null;
  const match = portfolioPrIdentifierPattern.exec(identifier.trim());
  if (!match) return null;
  const pullNumber = Number(match[1]);
  return Number.isInteger(pullNumber) && pullNumber > 0 ? pullNumber : null;
}

function rowKey(repoFullName, pullNumber) {
  return `${repoFullName}#${pullNumber}`;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizePullNumber(value) {
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function mergeManageFields(target, payload, eventCreatedAt) {
  const pullNumber = normalizePullNumber(payload?.pullNumber);
  if (pullNumber !== null) target.pullNumber = pullNumber;
  const branch = normalizeOptionalString(payload?.branch);
  if (branch !== null) target.branch = branch;
  const ciState = normalizeOptionalString(payload?.ciState);
  if (ciState !== null) target.ciState = ciState;
  const gateVerdict = normalizeOptionalString(payload?.gateVerdict);
  if (gateVerdict !== null) target.gateVerdict = gateVerdict;
  const outcome = normalizeOptionalString(payload?.outcome);
  if (outcome !== null) target.outcome = outcome;
  const lastPolledAt =
    normalizeOptionalString(payload?.lastPolledAt) ?? normalizeOptionalString(eventCreatedAt);
  if (lastPolledAt !== null) target.lastPolledAt = lastPolledAt;
}

/**
 * Aggregate manage-phase rows from the portfolio queue and append-only event ledger. Pure read/render input —
 * no network calls and no writes (#2325).
 */
export function buildManageStatusSnapshot(readers) {
  const rows = new Map();

  for (const item of readers.listQueue()) {
    if (item.status === "done") continue;
    const pullNumber = parsePortfolioPullNumber(item.identifier);
    if (pullNumber === null) continue;
    const key = rowKey(item.repoFullName, pullNumber);
    rows.set(key, {
      repoFullName: item.repoFullName,
      pullNumber,
      branch: null,
      ciState: item.status === "in_progress" ? "unknown" : "unknown",
      gateVerdict: null,
      outcome: null,
      lastPolledAt: null,
      portfolioStatus: item.status,
    });
  }

  for (const event of readers.readEvents()) {
    if (event.type !== MANAGE_STATUS_EVENT_TYPE) continue;
    if (!event.repoFullName) continue;
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const pullNumber = normalizePullNumber(payload.pullNumber);
    if (pullNumber === null) continue;
    const key = rowKey(event.repoFullName, pullNumber);
    const existing = rows.get(key) ?? {
      repoFullName: event.repoFullName,
      pullNumber,
      branch: null,
      ciState: "unknown",
      gateVerdict: null,
      outcome: null,
      lastPolledAt: null,
      portfolioStatus: null,
    };
    mergeManageFields(existing, payload, event.createdAt);
    rows.set(key, existing);
  }

  return [...rows.values()].sort((left, right) => {
    const repoCompare = left.repoFullName.localeCompare(right.repoFullName);
    if (repoCompare !== 0) return repoCompare;
    return left.pullNumber - right.pullNumber;
  });
}

export function formatManageStatusJson(rows) {
  return `${JSON.stringify({ rows }, null, 2)}\n`;
}

function pad(value, width) {
  const text = String(value ?? "");
  return text.length >= width ? text : `${text}${" ".repeat(width - text.length)}`;
}

export function formatManageStatusTable(rows) {
  if (rows.length === 0) {
    return "No managed pull requests in the local portfolio.\n";
  }
  const headers = [
    "repo",
    "pr",
    "branch",
    "ci",
    "gate",
    "outcome",
    "last_polled_at",
  ];
  const widths = [28, 6, 24, 10, 10, 10, 24];
  const lines = [
    headers.map((header, index) => pad(header, widths[index])).join("  "),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];
  for (const row of rows) {
    lines.push(
      [
        pad(row.repoFullName, widths[0]),
        pad(row.pullNumber, widths[1]),
        pad(row.branch ?? "-", widths[2]),
        pad(row.ciState ?? "unknown", widths[3]),
        pad(row.gateVerdict ?? "-", widths[4]),
        pad(row.outcome ?? "-", widths[5]),
        pad(row.lastPolledAt ?? "-", widths[6]),
      ].join("  "),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function parseManageStatusArgs(cliArgs) {
  const json = cliArgs.includes("--json");
  const positional = cliArgs.filter((arg) => arg !== "--json");
  if (positional.length > 0) {
    throw new Error(`unexpected_arguments:${positional.join(",")}`);
  }
  return { json };
}

export function runManageStatus(readers, options = {}) {
  const rows = buildManageStatusSnapshot(readers);
  const output = options.json ? formatManageStatusJson(rows) : formatManageStatusTable(rows);
  return { rows, output, exitCode: 0 };
}
