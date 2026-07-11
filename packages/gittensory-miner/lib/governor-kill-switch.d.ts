import type { MinerKillSwitchScope } from "@jsonbored/gittensory-engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type CheckMinerKillSwitchInput = {
  repoPaused?: boolean;
  env?: Record<string, string | undefined>;
};

export type CheckMinerKillSwitchResult = {
  scope: MinerKillSwitchScope;
  active: boolean;
};

export function checkMinerKillSwitch(input?: CheckMinerKillSwitchInput): CheckMinerKillSwitchResult;

export type RecordMinerKillSwitchTransitionInput = {
  repoFullName?: string;
  actionClass: string;
  previousScope: MinerKillSwitchScope;
  scope: MinerKillSwitchScope;
};

export function recordMinerKillSwitchTransition(
  input: RecordMinerKillSwitchTransitionInput,
  options?: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry },
): GovernorLedgerEntry | null;
