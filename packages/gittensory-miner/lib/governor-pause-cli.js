// The governor pause/resume control surface (#4851): a real, persisted pause flag an operator (or, in a future
// wave, the governor itself) can toggle via this CLI, that loop-cli.js's iteration loop actually checks before
// each cycle. Distinct from governor-kill-switch.js (a read-only resolver over pre-existing env/YAML inputs this
// package never itself writes) and governor-run-halt.js (a one-way, run-scoped terminal breaker with no resume
// path) -- this is the first genuinely operator/governor-writable stop/go control. Persisted on governor-state.js's
// existing single-row scalar-state table, not a new store: a pause flag has no relational key of its own, the
// same reasoning that table's other scalar fields (rate-limit buckets, cap usage) already rely on.

import { openGovernorState } from "./governor-state.js";

const GOVERNOR_PAUSE_USAGE = "Usage: gittensory-miner governor pause [--reason <text>] [--dry-run] [--json]";
const GOVERNOR_RESUME_USAGE = "Usage: gittensory-miner governor resume [--dry-run] [--json]";
const GOVERNOR_STATUS_USAGE = "Usage: gittensory-miner governor status [--json]";

export function parseGovernorPauseArgs(args) {
  const options = { json: false, dryRun: false, reason: null };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: reports what pausing would do and returns before writing to governor-state.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--reason") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: GOVERNOR_PAUSE_USAGE };
      options.reason = value;
      index += 1;
      continue;
    }
    return { error: `Unknown option: ${token}` };
  }

  return options;
}

export function parseGovernorResumeArgs(args) {
  const options = { json: false, dryRun: false };

  for (const token of args) {
    if (token === "--json") {
      options.json = true;
      continue;
    }
    // #4847: reports what resuming would do and returns before writing to governor-state.
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    return { error: GOVERNOR_RESUME_USAGE };
  }

  return options;
}

function parseNoArgsSubcommand(args, usage) {
  if (args.length === 0) return { json: false };
  if (args.length === 1 && args[0] === "--json") return { json: true };
  return { error: usage };
}

async function withGovernorState(options, run) {
  const ownsGovernorState = options.openGovernorState === undefined;
  const governorState = (options.openGovernorState ?? openGovernorState)();
  try {
    return run(governorState);
  } finally {
    if (ownsGovernorState) governorState.close();
  }
}

function renderPauseState(pauseState) {
  if (!pauseState.paused) return "governor is not paused";
  const reason = pauseState.reason ? ` (${pauseState.reason})` : "";
  return `governor is PAUSED since ${pauseState.pausedAt}${reason}`;
}

export async function runGovernorPause(args, options = {}) {
  const parsed = parseGovernorPauseArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", paused: true, reason: parsed.reason };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult));
    } else {
      const reason = parsed.reason ? ` (${parsed.reason})` : "";
      console.log(`DRY RUN: would pause the governor${reason}. No governor-state write was made.`);
    }
    return 0;
  }

  try {
    return await withGovernorState(options, (governorState) => {
      const pauseState = governorState.savePauseState({ paused: true, reason: parsed.reason });
      if (parsed.json) {
        console.log(JSON.stringify(pauseState));
      } else {
        console.log(renderPauseState(pauseState));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function runGovernorResume(args, options = {}) {
  const parsed = parseGovernorResumeArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  if (parsed.dryRun) {
    const dryRunResult = { outcome: "dry_run", paused: false };
    if (parsed.json) {
      console.log(JSON.stringify(dryRunResult));
    } else {
      console.log("DRY RUN: would resume the governor. No governor-state write was made.");
    }
    return 0;
  }

  try {
    return await withGovernorState(options, (governorState) => {
      const pauseState = governorState.savePauseState({ paused: false });
      if (parsed.json) {
        console.log(JSON.stringify(pauseState));
      } else {
        console.log(renderPauseState(pauseState));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function runGovernorStatus(args, options = {}) {
  const parsed = parseNoArgsSubcommand(args, GOVERNOR_STATUS_USAGE);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  try {
    return await withGovernorState(options, (governorState) => {
      const pauseState = governorState.loadPauseState();
      if (parsed.json) {
        console.log(JSON.stringify(pauseState));
      } else {
        console.log(renderPauseState(pauseState));
      }
      return 0;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
