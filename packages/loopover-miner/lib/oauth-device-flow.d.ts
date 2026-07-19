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
/** The centrally-held loopover-ams App's OAuth client id -- public (not secret), so it's safe to read from a
 *  plain env var. Empty/unset means device-flow authorization isn't available in this build/deployment. */
export declare function resolveAmsOauthClientId(env?: Record<string, string | undefined>): string;
export declare class DeviceFlowError extends Error {
    code: string;
    constructor(code: string, message?: string);
}
/** Step 1 of the device flow: request a device code + the short user-facing code from GitHub. */
export declare function requestDeviceCode({ clientId, scope, fetchFn, }: {
    clientId: string;
    scope?: string | undefined;
    fetchFn?: typeof fetch;
}): Promise<DeviceCode>;
/**
 * Step 2: poll for the access token, honoring GitHub's device-flow polling protocol --
 * `authorization_pending` keeps polling at the current interval, `slow_down` increases it (to GitHub's own
 * requested value when given), `expired_token`/`access_denied` are terminal failures, anything else is an
 * unexpected terminal failure. Bounded by `expiresInSeconds` so a caller can never poll forever.
 */
export declare function pollForAccessToken({ clientId, deviceCode, intervalSeconds, expiresInSeconds, fetchFn, sleepFn, now, }: {
    clientId: string;
    deviceCode: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    fetchFn?: typeof fetch;
    sleepFn?: ((ms: number) => Promise<void>) | undefined;
    now?: (() => number) | undefined;
}): Promise<DeviceFlowTokenResult>;
/**
 * Run the full device-flow authorization end to end: request a code, hand it to the caller's `onCode` (so the
 * caller can display it however it likes -- CLI text, structured JSON, etc.), then poll until the user
 * completes, declines, or the code expires. Returns the resulting access token; throws a DeviceFlowError on
 * any failure -- the caller decides whether to fall back to another auth method.
 */
export declare function runDeviceFlowAuthorization({ clientId, scope, onCode, fetchFn, sleepFn, now, }: {
    clientId: string;
    scope?: string | undefined;
    onCode: (code: DeviceCode) => void | Promise<void>;
    fetchFn?: typeof fetch;
    sleepFn?: ((ms: number) => Promise<void>) | undefined;
    now?: (() => number) | undefined;
}): Promise<DeviceFlowTokenResult>;
