import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverMinerGoalSpecPath, parseMinerGoalSpecContent } from "@jsonbored/gittensory-engine";
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { initPortfolioQueueManager } from "./portfolio-queue-manager.js";
import { runPortfolioDashboard } from "./portfolio-dashboard.js";

// No MinerGoalSpec field bounds the portfolio-wide (cross-repo) WIP count today, so `queue next` (#4850) only
// enforces the per-repo cap from config; this stands in for "no cap" without tripping the caps-aware selector's
// own `cap === 0` ⇒ "claim nothing" rule (queue.ts), which a non-finite/undefined value would.
const UNBOUNDED_WIP_CAP = Number.MAX_SAFE_INTEGER;

/**
 * Resolve `queue next`'s per-repo WIP cap from the CWD's discovered `.gittensory-miner.yml` (mirrors status.js's
 * own config-file discovery), reusing `maxConcurrentClaims` -- already documented as "max issues a single miner
 * may hold claimed on this repo at once" -- rather than inventing a new field. Falls back to an effectively
 * unbounded cap when NO config file exists at all, so an operator who has never configured a cap keeps today's
 * uncapped `queue next` behavior unchanged; the cap only applies once a config file is actually present (#4850).
 */
export function resolveQueueNextCaps(cwd = process.cwd(), deps = {}) {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? readFileSync;
  const relativePath = discoverMinerGoalSpecPath((candidate) => exists(join(cwd, candidate)));
  if (!relativePath) return { globalWipCap: UNBOUNDED_WIP_CAP, perRepoWipCap: UNBOUNDED_WIP_CAP };
  const { spec } = parseMinerGoalSpecContent(read(join(cwd, relativePath), "utf8"));
  return { globalWipCap: UNBOUNDED_WIP_CAP, perRepoWipCap: spec.maxConcurrentClaims };
}

const QUEUE_LIST_USAGE = "Usage: gittensory-miner queue list [--repo <owner/repo>] [--json]";
const QUEUE_NEXT_USAGE = "Usage: gittensory-miner queue next [--json]";
const QUEUE_DONE_USAGE = "Usage: gittensory-miner queue done <owner/repo> <identifier> [--json]";
const QUEUE_RELEASE_USAGE = "Usage: gittensory-miner queue release <owner/repo> <identifier> [--json]";
const QUEUE_REQUEUE_USAGE = "Usage: gittensory-miner queue requeue <owner/repo> <identifier> [--json]";
const QUEUE_CLAIM_BATCH_USAGE =
  "Usage: gittensory-miner queue claim-batch [--global-wip <n>] [--per-repo-wip <n>] [--json]";

function parseRepoArg(value, usage) {
  if (!value) return { error: usage };
  const trimmed = value.trim();
  const [owner, repo, extra] = trimmed.split("/");
  if (!owner || !repo || extra !== undefined) {
    return { error: "Repository must be in owner/repo form." };
  }
  return { repoFullName: `${owner}/${repo}` };
}

function parseJsonFlag(args) {
  const options = { json: false };
  const positional = [];

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token.startsWith("-")) {
      return { error: `Unknown option: ${token}` };
    }
    positional.push(token);
  }

  return { positional, ...options };
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

export function parseQueueNextArgs(args) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length > 0) {
    return { error: QUEUE_NEXT_USAGE };
  }
  return { json: parsed.json };
}

/** Shared `<owner/repo> <identifier> [--json]` parse for the item-targeting subcommands (done/release/requeue).
 *  `usage` is the command-specific message surfaced on a malformed argv. */
function parseRepoIdentifierArgs(args, usage) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length !== 2) {
    return { error: usage };
  }

  const repo = parseRepoArg(parsed.positional[0], usage);
  if ("error" in repo) return repo;

  const identifier = parsed.positional[1]?.trim();
  if (!identifier) {
    return { error: usage };
  }

  return {
    repoFullName: repo.repoFullName,
    identifier,
    json: parsed.json,
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
    "status".padEnd(12),
    "pri".padStart(4),
    "enqueued-at".padEnd(24),
  ].join(" ");
  const lines = entries.map((entry) =>
    [
      entry.repoFullName.padEnd(24),
      entry.identifier.padEnd(16),
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
    console.error(parsed.error);
    return 2;
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
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/** Claim the single next eligible item via the WIP-cap-aware claimer (portfolio-queue-manager.js's
 *  `claimNext()`), respecting the per-repo cap configured via `.gittensory-miner.yml` (#4850). */
export function runQueueNext(args, options = {}) {
  const parsed = parseQueueNextArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  // Open the manager INSIDE the try so a store/config-read failure returns 2 instead of crashing; the finally
  // guards the close with `?.` since the initializer may have thrown before assigning (mirrors claim-batch).
  const ownsManager = options.initPortfolioQueueManager === undefined;
  let manager;
  try {
    const caps = (options.resolveQueueNextCaps ?? resolveQueueNextCaps)(options.cwd);
    manager = (options.initPortfolioQueueManager ?? initPortfolioQueueManager)({ caps });
    const entry = manager.claimNext();
    if (parsed.json) {
      console.log(JSON.stringify({ entry }, null, 2));
    } else {
      console.log(entry ? entry.identifier : "none");
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (ownsManager) manager?.close();
  }
}

export function runQueueDone(args, options = {}) {
  const parsed = parseQueueDoneArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.markDone(parsed.repoFullName, parsed.identifier);
      if (!entry) {
        console.error("queue_entry_not_found");
        return 2;
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/** `release <owner/repo> <identifier>`: manually give up a CLAIMED (in_progress) item, returning it to the queue
 *  (the manual counterpart to the automated stuck-lease sweep). Exit 2 when there is no in-flight item to release. */
export function runQueueRelease(args, options = {}) {
  const parsed = parseQueueReleaseArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.reclaimStuckItem(parsed.repoFullName, parsed.identifier);
      if (!entry) {
        console.error("queue_entry_not_in_progress");
        return 2;
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/** `requeue <owner/repo> <identifier>`: manually put a COMPLETED (done) item back on the queue so it is picked up
 *  again, keeping its original FIFO position. Exit 2 when there is no done item to requeue (already queued,
 *  in-flight — release it instead — or absent). */
export function runQueueRequeue(args, options = {}) {
  const parsed = parseQueueRequeueArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.requeueItem(parsed.repoFullName, parsed.identifier);
      if (!entry) {
        console.error("queue_entry_not_requeuable");
        return 2;
      }
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry.status);
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export function parseQueueClaimBatchArgs(args) {
  const options = { json: false, globalWipCap: 1, perRepoWipCap: 1 };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
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
    console.error(parsed.error);
    return 2;
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
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    if (ownsManager) manager?.close();
  }
}

export function runQueueCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runQueueList(args, options);
  if (subcommand === "next") return runQueueNext(args, options);
  if (subcommand === "done") return runQueueDone(args, options);
  if (subcommand === "release") return runQueueRelease(args, options);
  if (subcommand === "requeue") return runQueueRequeue(args, options);
  if (subcommand === "claim-batch") return runQueueClaimBatch(args, options);
  if (subcommand === "dashboard") return runPortfolioDashboard(args, options);
  console.error(`Unknown queue subcommand: ${subcommand ?? ""}. ${QUEUE_LIST_USAGE}`);
  return 2;
}
