export type GittensorySession = {
  token: string;
  login: string;
  expiresAt: string;
  scopes: string[];
  lastAuthenticatedAt: string;
};

export type StoredAuthState = {
  apiOrigin: string;
  session: GittensorySession | null;
};

export type DeviceFlowStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export type DeviceFlowPollResult =
  | { status: "authorization_pending" | "slow_down"; message?: string }
  | { status: "error"; message?: string }
  | GittensorySession;

export type SessionStatus = {
  signedIn: boolean;
  login?: string;
  expiresAt?: string;
  scopes?: string[];
  expired?: boolean;
};

export type FetchLike = typeof fetch;

export type SleepFn = (ms: number) => Promise<void>;
