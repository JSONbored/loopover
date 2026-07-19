import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initPortfolioQueueManager } from "./portfolio-queue-manager.js";
import { runPortfolioDashboard } from "./portfolio-dashboard.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const QUEUE_LIST_USAGE = "Usage: loopover-miner queue list [--repo <owner/repo>] [--json]";
const QUEUE_NEXT_USAGE =
  "Usage: loopover-miner queue next [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";
const QUEUE_DONE_USAGE =
  "Usage: loopover-miner queue done <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_RELEASE_USAGE =
  "Usage: loopover-miner queue release <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_REQUEUE_USAGE =
  "Usage: loopover-miner queue requeue <owner/repo> <identifier> [--api-base-url <url>] [--dry-run] [--json]";
const QUEUE_CLAIM_BATCH_USAGE =
  "Usage: loopover-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--dry-run] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

export function parseQueueListArgs(args) {
  const options = { json: false, repoFullName: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--repo") {
      const repoArg = args[index + 1];
      if (!repoArg || repoArg.startsWith("-")) {
        return { error: QUEUE_LIST_USAGE };
      }
      const repo = parseRepoArg(repoArg, QUEUE_LIST_USAGE);
      if ("error" in repo) return repo;
      options.repoFullName = repo.repoFullName;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length > 0) {
    return { error: QUEUE_LIST_USAGE };
  }

  return options;
}

// #4850: --global-wip/--per-repo-wip are OMITTED (undefined) by default -- queue next stays uncapped, byte-
// identical to its pre-#4850 behavior, unless an operator explicitly opts in. Mirrors queue claim-batch's own
// flag names (portfolio-queue-manager.js's WIP-cap-aware claimer), but claim-batch's OWN default of 1/1 is not
// reused here: claim-batch's whole purpose is cap enforcement, while queue next has always been a plain
// highest-priority dequeue and must not silently start capping existing callers that never asked for it.
export function parseQueueNextArgs(args) {
  const options = { json: false, dryRun: false, globalWipCap: undefined, perRepoWipCap: undefined };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--global-wip" || token === "--per-repo-wip") {
      const value = Number(args[index + 1]);
      if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
        return { error: QUEUE_NEXT_USAGE };
      }
      if (token === "--global-wip") options.globalWipCap = value;
      else options.perRepoWipCap = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length > 0) {
    return { error: QUEUE_NEXT_USAGE };
  }
  return options;
}

/**
 * Pick at most one atomically-claimable target from the store's already-priority-ordered active rows (queued
 * AND in_progress interleaved, exactly `batchClaim`'s own `entries` shape). `caps` of `null` replicates the
 * pre-#4850 behavior: the single highest-priority queued row, unconditionally. When caps are set, refuses to
 * select anything once the global or the target row's own per-repo in-progress count has reached its cap --
 * "stops claiming once the cap is reached" (#4850), not a diversifying batch selection (that remains
 * claim-batch's job via the engine's own `nextEligibleItems`).
 * @param {Array<{ repoFullName: string, identifier: string, apiBaseUrl: string, status: string }>} entries
 * @param {{ globalWipCap: number, perRepoWipCap: number } | null} caps
 */
export function selectNextEligibleTarget(entries, caps) {
  const topQueued = entries.find((entry) => entry.status === "queued");
  if (!topQueued) return [];
  if (!caps) {
    return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
  }
  const globalActiveCount = entries.filter((entry) => entry.status === "in_progress").length;
  if (globalActiveCount >= caps.globalWipCap) return [];
  const repoActiveCount = entries.filter(
    (entry) => entry.status === "in_progress" && entry.repoFullName === topQueued.repoFullName,
  ).length;
  if (repoActiveCount >= caps.perRepoWipCap) return [];
  return [{ repoFullName: topQueued.repoFullName, identifier: topQueued.identifier, apiBaseUrl: topQueued.apiBaseUrl }];
}

/** Shared `<owner/repo> <identifier> [--api-base-url <url>] [--json]` parse for the item-targeting subcommands
 *  (done/release/requeue). `usage` is the command-specific message surfaced on a malformed argv. */
function parseRepoIdentifierArgs(args, usage) {
  const options = { json: false, dryRun: false, apiBaseUrl: undefined };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: reports what a real mutation would do and returns before opening the portfolio queue at all.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    // #5563: scope the target to a non-default forge host, so it doesn't collide with (or get confused for) a
    // same-named repo on the default github.com host.
    if (token === "--api-base-url") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { error: usage };
      }
      options.apiBaseUrl = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  if (positional.length !== 2) {
    return { error: usage };
  }

  const repo = parseRepoArg(positional[0], usage);
  if ("error" in repo) return repo;

  const identifier = positional[1]?.trim();
  if (!identifier) {
    return { error: usage };
  }

  return {
    repoFullName: repo.repoFullName,
    identifier,
    dryRun: options.dryRun,
    json: options.json,
    apiBaseUrl: options.apiBaseUrl,
  };
}

export function parseQueueDoneArgs(args) {
  return parseRepoIdentifierArgs(args, QUEUE_DONE_USAGE);
}

export function parseQueueReleaseArgs(args) {
  return parseRepoIdentifierArgs(args, QUEUE_RELEASE_USAGE);
}

export function parseQueueRequeueArgs(args) {
  return parseRepoIdentifierArgs(args, QUEUE_REQUEUE_USAGE);
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderQueueTable(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "no portfolio queue entries";
  const header = [
    "repo".padEnd(24),
    "identifier".padEnd(16),
    // #7225: surface the host so a reader of the plain-text table can supply the `--api-base-url` a follow-up
    // done/release/requeue needs to disambiguate two rows sharing a repo+identifier across forge hosts.
    "host".padEnd(30),
    "status".padEnd(12),
    "pri".padStart(4),
    "enqueued-at".padEnd(24),
  ].join(" ");
  const lines = entries.map((entry) =>
    [
      entry.repoFullName.padEnd(24),
      entry.identifier.padEnd(16),
      display(entry.apiBaseUrl).padEnd(30),
      entry.status.padEnd(12),
      display(entry.priority).padStart(4),
      display(entry.enqueuedAt).padEnd(24),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

function withPortfolioQueue(options, run) {
  const ownsStore = options.initPortfolioQueue === undefined;
  const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
  try {
    return run(portfolioQueue);
  } finally {
    if (ownsStore) portfolioQueue.close();
  }
}

export function runQueueList(args, options = {}) {
  const parsed = parseQueueListArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entries = portfolioQueue.listQueue(parsed.repoFullName);
      if (parsed.json) {
        console.log(JSON.stringify({ entries }, null, 2));
      } else {
        console.log(renderQueueTable(entries));
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runQueueNext(args, options = {}) {
  const parsed = parseQueueNextArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  const capsRequested = parsed.globalWipCap !== undefined || parsed.perRepoWipCap !== undefined;
  if (parsed.dryRun) {
    const dryRunResult = capsRequested
      ? { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap }
      : { outcome: "dry_run" };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else if (capsRequested) {
      console.log(
        `DRY RUN: would dequeue the highest-priority queued item within WIP caps (global-wip: ${parsed.globalWipCap ?? "unset"}, per-repo-wip: ${parsed.perRepoWipCap ?? "unset"}). No portfolio-queue write was made.`,
      );
    } else {
      console.log("DRY RUN: would dequeue the highest-priority queued item. No portfolio-queue write was made.");
    }
    return 0;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      let entry;
      if (capsRequested) {
        // Unset dimensions stay genuinely uncapped (Infinity), not silently defaulted to 1 like claim-batch.
        const caps = {
          globalWipCap: parsed.globalWipCap ?? Number.POSITIVE_INFINITY,
          perRepoWipCap: parsed.perRepoWipCap ?? Number.POSITIVE_INFINITY,
        };
        const claimed = portfolioQueue.batchClaim((entries) => selectNextEligibleTarget(entries, caps));
        entry = claimed[0] ?? null;
      } else {
        entry = portfolioQueue.dequeueNext();
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry ? entry.identifier : "none");
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runQueueDone(args, options = {}) {
  const parsed = parseQueueDoneArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(`DRY RUN: would mark ${parsed.repoFullName} ${parsed.identifier} done. No portfolio-queue write was made.`);
    }
    return 0;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.markDone(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
      if (!entry) {
        return reportCliFailure(parsed.json, "queue_entry_not_found");
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

/** `release <owner/repo> <identifier>`: manually give up a CLAIMED (in_progress) item, returning it to the queue
 *  (the manual counterpart to the automated stuck-lease sweep). Exit 2 when there is no in-flight item to release. */
export function runQueueRelease(args, options = {}) {
  const parsed = parseQueueReleaseArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(`DRY RUN: would release ${parsed.repoFullName} ${parsed.identifier} back to the queue. No portfolio-queue write was made.`);
    }
    return 0;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.reclaimStuckItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
      if (!entry) {
        return reportCliFailure(parsed.json, "queue_entry_not_in_progress");
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

/** `requeue <owner/repo> <identifier>`: manually put a COMPLETED (done) item back on the queue so it is picked up
 *  again, keeping its original FIFO position. Exit 2 when there is no done item to requeue (already queued,
 *  in-flight — release it instead — or absent). */
export function runQueueRequeue(args, options = {}) {
  const parsed = parseQueueRequeueArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", repoFullName: parsed.repoFullName, identifier: parsed.identifier };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(`DRY RUN: would requeue ${parsed.repoFullName} ${parsed.identifier}. No portfolio-queue write was made.`);
    }
    return 0;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.requeueItem(parsed.repoFullName, parsed.identifier, parsed.apiBaseUrl);
      if (!entry) {
        return reportCliFailure(parsed.json, "queue_entry_not_requeuable");
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function parseQueueClaimBatchArgs(args) {
  const options = { json: false, dryRun: false, globalWipCap: 1, perRepoWipCap: 1 };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--global-wip" || token === "--per-repo-wip") {
      const value = Number(args[index + 1]);
      if (args[index + 1] === undefined || !Number.isFinite(value) || value < 0) {
        return { error: QUEUE_CLAIM_BATCH_USAGE };
      }
      if (token === "--global-wip") options.globalWipCap = value;
      else options.perRepoWipCap = value;
      index += 1;
      continue;
    }
    return { error: QUEUE_CLAIM_BATCH_USAGE };
  }
  return options;
}

/** Claim the next caps-aware batch via the WIP-cap-aware batch claimer (portfolio-queue-manager.js), which also
 *  reclaims any leases orphaned by a crashed process first (#4833 wires the previously caller-less claimer). */
export function runQueueClaimBatch(args, options = {}) {
  const parsed = parseQueueClaimBatchArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult, null, 2));
    } else {
      console.log(
        `DRY RUN: would claim a batch (global-wip: ${parsed.globalWipCap}, per-repo-wip: ${parsed.perRepoWipCap}). No portfolio-queue write was made.`,
      );
    }
    return 0;
  }

  // Open the manager INSIDE the try so a store open failure returns 2 instead of crashing; the finally guards the
  // close with `?.` since the initializer may have thrown before assigning.
  const ownsManager = options.initPortfolioQueueManager === undefined;
  let manager;
  try {
    manager = (options.initPortfolioQueueManager ?? initPortfolioQueueManager)({
      caps: { globalWipCap: parsed.globalWipCap, perRepoWipCap: parsed.perRepoWipCap },
    });
    const claimed = manager.claimNextBatch();
    if (parsed.json) {
      console.log(JSON.stringify({ claimed }, null, 2));
    } else {
      console.log(claimed.length === 0 ? "none" : claimed.map((entry) => entry.identifier).join("\n"));
    }
    return 0;
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  } finally {
    if (ownsManager) manager?.close();
  }
}

const QUEUE_METRICS_USAGE = "Usage: loopover-miner queue metrics";

// Prometheus metric names for the portfolio-queue gauges (#5186). Mirrors the `loopover_miner_*` naming and
// HELP/TYPE/label conventions of event-ledger-cli.js's renderEventLedgerMetrics / the engine's
// renderMinerPredictionMetrics, rather than importing across the package boundary.
export const QUEUE_ITEMS = "loopover_miner_portfolio_queue_items";
export const QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS = "loopover_miner_portfolio_queue_oldest_in_progress_lease_age_seconds";

/** HELP-text escaping — backslash + newline (mirrors miner-prediction-metrics.ts's escapeHelpText). */
function escapeMetricsHelpText(help) {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/**
 * Render portfolio-queue backlog health as Prometheus text-exposition gauges: current item count per status, and
 * the age of the OLDEST still-in-flight lease -- the concrete "is anything stuck" signal a
 * `loopover_queue_oldest_maintenance_pending_age_seconds`-style alert rule can threshold on (#5186). Pure and
 * side-effect-free: the caller supplies the rows and `nowMs` (no internal clock read, matching
 * store-maintenance.js's pruneLedgerByRetention convention) and prints the result. Deterministic (status series
 * sorted); always emits HELP/TYPE so an empty queue is still a well-formed exposition document, and the lease-age
 * gauge reads 0 (never stuck) rather than being omitted when nothing is in-flight.
 * @param {Array<{ status: string }>} queueEntries - every row, any status (e.g. store.listQueue()'s output).
 * @param {Array<{ leasedAt: string | null }>} leaseEntries - in-flight rows only (store.listInProgress()'s output).
 * @param {number} nowMs
 */
export function renderPortfolioQueueMetrics(queueEntries, leaseEntries, nowMs) {
  const countByStatus = new Map();
  for (const entry of queueEntries) {
    countByStatus.set(entry.status, (countByStatus.get(entry.status) ?? 0) + 1);
  }

  let oldestLeaseAgeSeconds = 0;
  for (const lease of leaseEntries) {
    const leasedAtMs = Date.parse(lease.leasedAt ?? "");
    if (!Number.isFinite(leasedAtMs)) continue;
    const ageSeconds = Math.max(0, (nowMs - leasedAtMs) / 1000);
    if (ageSeconds > oldestLeaseAgeSeconds) oldestLeaseAgeSeconds = ageSeconds;
  }

  const lines = [
    `# HELP ${QUEUE_ITEMS} ${escapeMetricsHelpText("Current portfolio-queue item count, by status.")}`,
    `# TYPE ${QUEUE_ITEMS} gauge`,
  ];
  for (const [status, count] of [...countByStatus.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${QUEUE_ITEMS}{status="${status}"} ${count}`);
  }

  lines.push(
    `# HELP ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${escapeMetricsHelpText("Age in seconds of the oldest still-in-flight (in_progress) claim lease. 0 when nothing is in-flight.")}`,
  );
  lines.push(`# TYPE ${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} gauge`);
  lines.push(`${QUEUE_OLDEST_IN_PROGRESS_LEASE_AGE_SECONDS} ${oldestLeaseAgeSeconds}`);

  return `${lines.join("\n")}\n`;
}

export function runQueueMetrics(args, options = {}) {
  if (args.length > 0) {
    return reportCliFailure(argsWantJson(args), QUEUE_METRICS_USAGE);
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
      // renderPortfolioQueueMetrics returns a newline-terminated document; console.log re-adds the terminator, so
      // trim it to emit exactly one trailing newline (mirrors metrics-cli.js's runMetrics).
      console.log(
        renderPortfolioQueueMetrics(portfolioQueue.listQueue(), portfolioQueue.listInProgress(), nowMs).trimEnd(),
      );
      return 0;
    });
  } catch (error) {
    return reportCliFailure(argsWantJson(args), describeCliError(error));
  }
}

export function runQueueCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runQueueList(args, options);
  if (subcommand === "next") return runQueueNext(args, options);
  if (subcommand === "done") return runQueueDone(args, options);
  if (subcommand === "release") return runQueueRelease(args, options);
  if (subcommand === "requeue") return runQueueRequeue(args, options);
  if (subcommand === "claim-batch") return runQueueClaimBatch(args, options);
  if (subcommand === "metrics") return runQueueMetrics(args, options);
  if (subcommand === "dashboard") return runPortfolioDashboard(args, options);
  return reportCliFailure(argsWantJson(args), `Unknown queue subcommand: ${subcommand ?? ""}. ${QUEUE_LIST_USAGE}`);
}
