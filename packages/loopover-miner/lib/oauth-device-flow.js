// GitHub OAuth Device Flow client (#5682) for the centrally-held `loopover-ams` GitHub App -- lets a
// contributor authorize loopover-miner by visiting a URL and entering a short code, instead of generating
// and pasting a PAT. Uses GitHub's PUBLIC-client device flow
// (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow): no
// client secret is required or ever held by this CLI, only the App's public OAuth client id.
//
// The resulting user-to-server access token acts AS the authorizing human's own account, within their own
// GitHub permissions -- the exact same identity/attribution as a manually pasted PAT (see LOCAL_WRITE_BOUNDARY
// in @loopover/engine's local-write-tools.ts). This is deliberately NOT the installation-token mechanism Orb
// uses: an installation token requires the repo owner to install the App on their own repo, which is
// mechanically incompatible with contributing to third-party repos AMS doesn't own.
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPE = "repo";
const DEFAULT_EXPIRES_IN_SECONDS = 900;
const DEFAULT_INTERVAL_SECONDS = 5;
// #miner-github-read-timeouts: matches github-token-resolution.js's GITHUB_TOKEN_FETCH_TIMEOUT_MS -- a stalled
// connection can't hang forever, here or anywhere else this package talks to GitHub.
const DEVICE_FLOW_FETCH_TIMEOUT_MS = 10_000;
/** The centrally-held loopover-ams App's OAuth client id -- public (not secret), so it's safe to read from a
 *  plain env var. Empty/unset means device-flow authorization isn't available in this build/deployment. */
export function resolveAmsOauthClientId(env = process.env) {
    return typeof env.LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID === "string" ? env.LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID.trim() : "";
}
export class DeviceFlowError extends Error {
    code;
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Step 1 of the device flow: request a device code + the short user-facing code from GitHub. */
export async function requestDeviceCode({ clientId, scope = DEFAULT_SCOPE, fetchFn = fetch, }) {
    if (!clientId)
        throw new DeviceFlowError("missing_client_id", "no OAuth client id configured for device-flow authorization");
    const res = await fetchFn(DEVICE_CODE_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, scope }).toString(),
        signal: AbortSignal.timeout(DEVICE_FLOW_FETCH_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new DeviceFlowError("device_code_request_failed", `GitHub returned HTTP ${res.status} requesting a device code`);
    const data = (await res.json());
    if (!data || typeof data.device_code !== "string" || typeof data.user_code !== "string" || typeof data.verification_uri !== "string") {
        throw new DeviceFlowError("device_code_response_invalid", "GitHub's device-code response was missing required fields");
    }
    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresInSeconds: typeof data.expires_in === "number" ? data.expires_in : DEFAULT_EXPIRES_IN_SECONDS,
        intervalSeconds: typeof data.interval === "number" ? data.interval : DEFAULT_INTERVAL_SECONDS,
    };
}
/**
 * Step 2: poll for the access token, honoring GitHub's device-flow polling protocol --
 * `authorization_pending` keeps polling at the current interval, `slow_down` increases it (to GitHub's own
 * requested value when given), `expired_token`/`access_denied` are terminal failures, anything else is an
 * unexpected terminal failure. Bounded by `expiresInSeconds` so a caller can never poll forever.
 */
export async function pollForAccessToken({ clientId, deviceCode, intervalSeconds = DEFAULT_INTERVAL_SECONDS, expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS, fetchFn = fetch, sleepFn = defaultSleep, now = () => Date.now(), }) {
    const deadline = now() + expiresInSeconds * 1000;
    let interval = intervalSeconds;
    for (;;) {
        if (now() >= deadline)
            throw new DeviceFlowError("expired_token", "the device code expired before authorization completed");
        await sleepFn(interval * 1000);
        let res;
        try {
            res = await fetchFn(ACCESS_TOKEN_URL, {
                method: "POST",
                headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: clientId,
                    device_code: deviceCode,
                    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                }).toString(),
                signal: AbortSignal.timeout(DEVICE_FLOW_FETCH_TIMEOUT_MS),
            });
        }
        catch {
            // A stalled/timed-out attempt is a per-attempt failure, not a fatal one -- the existing deadline check
            // at the top of the loop still bounds total polling time, so this just costs one wasted interval.
            continue;
        }
        const data = (await res.json().catch(() => ({})));
        if (data && typeof data.access_token === "string" && data.access_token) {
            return { accessToken: data.access_token, scope: typeof data.scope === "string" ? data.scope : "" };
        }
        const error = data && typeof data.error === "string" ? data.error : null;
        if (error === "authorization_pending")
            continue;
        if (error === "slow_down") {
            interval = typeof data.interval === "number" ? data.interval : interval + 5;
            continue;
        }
        if (error === "expired_token")
            throw new DeviceFlowError("expired_token", "the device code expired before authorization completed");
        if (error === "access_denied")
            throw new DeviceFlowError("access_denied", "authorization was declined");
        throw new DeviceFlowError(error || "device_flow_failed", (data && data.error_description) || `unexpected device-flow response (HTTP ${res.status})`);
    }
}
/**
 * Run the full device-flow authorization end to end: request a code, hand it to the caller's `onCode` (so the
 * caller can display it however it likes -- CLI text, structured JSON, etc.), then poll until the user
 * completes, declines, or the code expires. Returns the resulting access token; throws a DeviceFlowError on
 * any failure -- the caller decides whether to fall back to another auth method.
 */
export async function runDeviceFlowAuthorization({ clientId, scope, onCode, fetchFn = fetch, sleepFn, now, }) {
    const code = await requestDeviceCode({ clientId, scope, fetchFn });
    await onCode(code);
    return pollForAccessToken({
        clientId,
        deviceCode: code.deviceCode,
        intervalSeconds: code.intervalSeconds,
        expiresInSeconds: code.expiresInSeconds,
        fetchFn,
        sleepFn,
        now,
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2F1dGgtZGV2aWNlLWZsb3cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJvYXV0aC1kZXZpY2UtZmxvdy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxR0FBcUc7QUFDckcsMEdBQTBHO0FBQzFHLDZEQUE2RDtBQUM3RCwwR0FBMEc7QUFDMUcsNkZBQTZGO0FBQzdGLEVBQUU7QUFDRiwwR0FBMEc7QUFDMUcsK0dBQStHO0FBQy9HLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFDckcsb0ZBQW9GO0FBRXBGLE1BQU0sZUFBZSxHQUFHLHNDQUFzQyxDQUFDO0FBQy9ELE1BQU0sZ0JBQWdCLEdBQUcsNkNBQTZDLENBQUM7QUFDdkUsTUFBTSxhQUFhLEdBQUcsTUFBTSxDQUFDO0FBQzdCLE1BQU0sMEJBQTBCLEdBQUcsR0FBRyxDQUFDO0FBQ3ZDLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxDQUFDO0FBQ25DLCtHQUErRztBQUMvRyxxRkFBcUY7QUFDckYsTUFBTSw0QkFBNEIsR0FBRyxNQUFNLENBQUM7QUFlNUM7MkdBQzJHO0FBQzNHLE1BQU0sVUFBVSx1QkFBdUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMzRixPQUFPLE9BQU8sR0FBRyxDQUFDLGtDQUFrQyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLGtDQUFrQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDekgsQ0FBQztBQUVELE1BQU0sT0FBTyxlQUFnQixTQUFRLEtBQUs7SUFDeEMsSUFBSSxDQUFTO0lBQ2IsWUFBWSxJQUFZLEVBQUUsT0FBZ0I7UUFDeEMsS0FBSyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsQ0FBQztRQUN2QixJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztJQUNuQixDQUFDO0NBQ0Y7QUFFRCxTQUFTLFlBQVksQ0FBQyxFQUFVO0lBQzlCLE9BQU8sSUFBSSxPQUFPLENBQU8sQ0FBQyxPQUFPLEVBQUUs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