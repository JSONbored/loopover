import { initPortfolioQueueStore } from "./portfolio-queue.js";

const QUEUE_LIST_USAGE = "Usage: gittensory-miner queue list [--repo <owner/repo>] [--json]";
const QUEUE_NEXT_USAGE = "Usage: gittensory-miner queue next [--json]";
const QUEUE_DONE_USAGE = "Usage: gittensory-miner queue done <owner/repo> <identifier> [--json]";

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

export function parseQueueDoneArgs(args) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length !== 2) {
    return { error: QUEUE_DONE_USAGE };
  }

  const repo = parseRepoArg(parsed.positional[0], QUEUE_DONE_USAGE);
  if ("error" in repo) return repo;

  const identifier = parsed.positional[1]?.trim();
  if (!identifier) {
    return { error: QUEUE_DONE_USAGE };
  }

  return {
    repoFullName: repo.repoFullName,
    identifier,
    json: parsed.json,
  };
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

export function runQueueNext(args, options = {}) {
  const parsed = parseQueueNextArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return withPortfolioQueue(options, (portfolioQueue) => {
      const entry = portfolioQueue.dequeueNext();
      if (parsed.json) {
        console.log(JSON.stringify({ entry }, null, 2));
      } else {
        console.log(entry ? entry.identifier : "none");
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
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

export function runQueueCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runQueueList(args, options);
  if (subcommand === "next") return runQueueNext(args, options);
  if (subcommand === "done") return runQueueDone(args, options);
  console.error(`Unknown queue subcommand: ${subcommand ?? ""}. ${QUEUE_LIST_USAGE}`);
  return 2;
}
