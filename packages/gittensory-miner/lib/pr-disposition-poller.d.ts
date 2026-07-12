export type PrDisposition = {
  state: "open" | "closed";
  merged: boolean;
  closedAt: string | null;
  attempts: number;
};

export type PollPrDispositionOptions = {
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  githubToken?: string;
  maxAttempts?: number;
  minIntervalMs?: number;
  maxIntervalMs?: number;
  sleepFn?: (delayMs: number) => Promise<void>;
};

export function pollPrDisposition(
  repoFullName: string,
  prNumber: number,
  options?: PollPrDispositionOptions,
): Promise<PrDisposition>;

export function classifyPrDisposition(
  disposition: Pick<PrDisposition, "state" | "merged">,
): "merged" | "disengaged" | "other";
