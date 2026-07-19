import type { PlanRecord, PlanStatus, PlanStore } from "./plan-store.js";
export type ParsedPlanListArgs = {
    json: boolean;
    status: PlanStatus | null;
} | {
    error: string;
};
export type ParsedPlanShowArgs = {
    planId: string;
    json: boolean;
} | {
    error: string;
};
type RunPlanOptions = {
    openPlanStore?: () => PlanStore;
};
export declare function parsePlanListArgs(args: string[]): ParsedPlanListArgs;
export declare function parsePlanShowArgs(args: string[]): ParsedPlanShowArgs;
export declare function renderPlanTable(plans: PlanRecord[]): string;
export declare function runPlanList(args: string[], options?: RunPlanOptions): number;
export declare function runPlanShow(args: string[], options?: RunPlanOptions): number;
export declare function runPlanCli(subcommand: string | undefined, args: string[], options?: RunPlanOptions): number;
export {};
