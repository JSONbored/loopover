export type GateVerdict = "merge" | "close" | "hold" | "pending";

export const GATE_VERDICTS: readonly GateVerdict[];

export function mapGateDisposition(disposition: unknown): GateVerdict;

export function readGateDisposition(body: unknown): string | null;

export type PollGateVerdictOptions = {
  fetchFn?: (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
  sleepFn?: (ms: number) => Promise<void>;
  headers?: Record<string, string>;
  maxAttempts?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
};

export type GateVerdictPollResult = {
  verdict: GateVerdict;
  disposition: string | null;
  attempts: number;
  body: unknown;
};

export function pollGateVerdict(
  url: string,
  options?: PollGateVerdictOptions,
): Promise<GateVerdictPollResult>;
