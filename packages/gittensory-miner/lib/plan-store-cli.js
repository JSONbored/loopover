import { PLAN_STATUSES, openPlanStore } from "./plan-store.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";

const PLAN_LIST_USAGE =
  "Usage: loopover-miner plan list [--status pending|running|completed|failed] [--json]";
const PLAN_SHOW_USAGE = "Usage: loopover-miner plan show <planId> [--json]";

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

export function parsePlanListArgs(args) {
  const options = { json: false, status: null };
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--status") {
      const status = args[index + 1];
      if (!status || status.startsWith("-")) return { error: PLAN_LIST_USAGE };
      if (!PLAN_STATUSES.includes(status)) {
        return { error: `Invalid status: ${status}. Expected one of ${PLAN_STATUSES.join(", ")}.` };
      }
      options.status = status;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    positional.push(token);
  }

  if (positional.length > 0) return { error: PLAN_LIST_USAGE };
  return options;
}

export function parsePlanShowArgs(args) {
  const parsed = parseJsonFlag(args);
  if ("error" in parsed) return parsed;
  if (parsed.positional.length !== 1) return { error: PLAN_SHOW_USAGE };

  const planId = parsed.positional[0]?.trim();
  if (!planId) return { error: PLAN_SHOW_USAGE };

  return {
    planId,
    json: parsed.json,
  };
}

function display(value) {
  if (value === null || value === undefined) return "-";
  return String(value);
}

export function renderPlanTable(plans) {
  if (!Array.isArray(plans) || plans.length === 0) return "no saved plans";
  const header = [
    "plan-id".padEnd(20),
    "status".padEnd(10),
    "steps".padStart(5),
    "updated-at".padEnd(24),
  ].join(" ");
  const lines = plans.map((record) =>
    [
      record.planId.padEnd(20),
      record.status.padEnd(10),
      String(record.plan.steps.length).padStart(5),
      display(record.updatedAt).padEnd(24),
    ].join(" "),
  );
  return [header, ...lines].join("\n");
}

function withPlanStore(options, run) {
  const ownsStore = options.openPlanStore === undefined;
  const planStore = (options.openPlanStore ?? openPlanStore)();
  try {
    return run(planStore);
  } finally {
    if (ownsStore) planStore.close();
  }
}

export function runPlanList(args, options = {}) {
  const parsed = parsePlanListArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return withPlanStore(options, (planStore) => {
      const plans = planStore.listPlans({ status: parsed.status });
      if (parsed.json) {
        console.log(JSON.stringify({ plans }, null, 2));
      } else {
        console.log(renderPlanTable(plans));
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runPlanShow(args, options = {}) {
  const parsed = parsePlanShowArgs(args);
  if ("error" in parsed) {
    return reportCliFailure(argsWantJson(args), parsed.error);
  }

  try {
    return withPlanStore(options, (planStore) => {
      const plan = planStore.loadPlan(parsed.planId);
      if (!plan) {
        return reportCliFailure(parsed.json, "plan_not_found");
      }
      if (parsed.json) {
        console.log(JSON.stringify({ plan }, null, 2));
      } else {
        console.log(`${plan.status} (${plan.plan.steps.length} steps)`);
      }
      return 0;
    });
  } catch (error) {
    return reportCliFailure(parsed.json, describeCliError(error));
  }
}

export function runPlanCli(subcommand, args, options = {}) {
  if (subcommand === "list") return runPlanList(args, options);
  if (subcommand === "show") return runPlanShow(args, options);
  return reportCliFailure(argsWantJson(args), `Unknown plan subcommand: ${subcommand ?? ""}. ${PLAN_LIST_USAGE}`);
}
