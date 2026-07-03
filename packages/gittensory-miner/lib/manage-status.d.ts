export declare const MANAGE_STATUS_EVENT_TYPE: "manage_pr_update";

export type ManageStatusRow = {
  repoFullName: string;
  pullNumber: number;
  branch: string | null;
  ciState: string | null;
  gateVerdict: string | null;
  outcome: string | null;
  lastPolledAt: string | null;
  portfolioStatus: string | null;
};

export type ManageStatusReaders = {
  listQueue(): ReadonlyArray<{
    repoFullName: string;
    identifier: string;
    status: string;
  }>;
  readEvents(): ReadonlyArray<{
    type: string;
    repoFullName: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
};

export function buildManageStatusSnapshot(readers: ManageStatusReaders): ManageStatusRow[];
export function formatManageStatusJson(rows: ManageStatusRow[]): string;
export function formatManageStatusTable(rows: ManageStatusRow[]): string;
export function parseManageStatusArgs(cliArgs: string[]): { json: boolean };
export function runManageStatus(
  readers: ManageStatusReaders,
  options?: { json?: boolean },
): { rows: ManageStatusRow[]; output: string; exitCode: number };
