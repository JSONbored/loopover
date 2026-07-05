import type { PlanRecord, PlanStatus, PlanStore } from "./plan-store.js";

export type ParsedPlanListArgs =
  | {
      json: boolean;
      status: PlanStatus | null;
    }
  | { error: string };

export type ParsedPlanShowArgs =
  | {
      planId: string;
      json: boolean;
    }
  | { error: string };

export function parsePlanListArgs(args: string[]): ParsedPlanListArgs;

export function parsePlanShowArgs(args: string[]): ParsedPlanShowArgs;

export function renderPlanTable(plans: PlanRecord[]): string;

export function runPlanList(
  args: string[],
  options?: { openPlanStore?: () => PlanStore },
): number;

export function runPlanShow(
  args: string[],
  options?: { openPlanStore?: () => PlanStore },
): number;

export function runPlanCli(
  subcommand: string | undefined,
  args: string[],
  options?: { openPlanStore?: () => PlanStore },
): number;
