export function resolveAmsOauthClientId(env?: Record<string, string | undefined>): string;

export class DeviceFlowError extends Error {
  constructor(code: string, message?: string);
  code: string;
}

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
};

export type DeviceFlowTokenResult = {
  accessToken: string;
  scope: string;
};

export function requestDeviceCode(options: {
  clientId: string;
  scope?: string;
  fetchFn?: typeof fetch;
}): Promise<DeviceCode>;

export function pollForAccessToken(options: {
  clientId: string;
  deviceCode: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceFlowTokenResult>;

export function runDeviceFlowAuthorization(options: {
  clientId: string;
  scope?: string;
  onCode: (code: DeviceCode) => void | Promise<void>;
  fetchFn?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<DeviceFlowTokenResult>;
