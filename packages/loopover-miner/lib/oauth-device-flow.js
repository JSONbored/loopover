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
export async function requestDeviceCode({ clientId, scope = DEFAULT_SCOPE, fetchFn = fetch, } = {}) {
    if (!clientId)
        throw new DeviceFlowError("missing_client_id", "no OAuth client id configured for device-flow authorization");
    // Cast: ambient fetch is CF-Workers-flavored; this module only POSTs string URLs.
    const resolvedFetch = fetchFn;
    const res = await resolvedFetch(DEVICE_CODE_URL, {
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
export async function pollForAccessToken({ clientId, deviceCode, intervalSeconds = DEFAULT_INTERVAL_SECONDS, expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS, fetchFn = fetch, sleepFn = defaultSleep, now = () => Date.now(), } = {}) {
    const deadline = now() + expiresInSeconds * 1000;
    let interval = intervalSeconds;
    // Cast: ambient fetch is CF-Workers-flavored; this module only POSTs string URLs.
    const resolvedFetch = fetchFn;
    for (;;) {
        if (now() >= deadline)
            throw new DeviceFlowError("expired_token", "the device code expired before authorization completed");
        await sleepFn(interval * 1000);
        let res;
        try {
            res = await resolvedFetch(ACCESS_TOKEN_URL, {
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
        throw new DeviceFlowError(error || "device_flow_failed", (typeof data.error_description === "string" ? data.error_description : undefined) ||
            `unexpected device-flow response (HTTP ${res.status})`);
    }
}
/**
 * Run the full device-flow authorization end to end: request a code, hand it to the caller's `onCode` (so the
 * caller can display it however it likes -- CLI text, structured JSON, etc.), then poll until the user
 * completes, declines, or the code expires. Returns the resulting access token; throws a DeviceFlowError on
 * any failure -- the caller decides whether to fall back to another auth method.
 */
export async function runDeviceFlowAuthorization({ clientId, scope, onCode, fetchFn = fetch, sleepFn, now, }) {
    // Cast: optional scope/sleepFn/now may be undefined; keep the JS's always-pass shape under EOPT.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib2F1dGgtZGV2aWNlLWZsb3cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJvYXV0aC1kZXZpY2UtZmxvdy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxxR0FBcUc7QUFDckcsMEdBQTBHO0FBQzFHLDZEQUE2RDtBQUM3RCwwR0FBMEc7QUFDMUcsNkZBQTZGO0FBQzdGLEVBQUU7QUFDRiwwR0FBMEc7QUFDMUcsK0dBQStHO0FBQy9HLDZHQUE2RztBQUM3RyxxR0FBcUc7QUFDckcsb0ZBQW9GO0FBRXBGLE1BQU0sZUFBZSxHQUFHLHNDQUFzQyxDQUFDO0FBQy9ELE1BQU0sZ0JBQWdCLEdBQUcsNkNBQTZDLENBQUM7QUFDdkUsTUFBTSxhQUFhLEdBQUcsTUFBTSxDQUFDO0FBQzdCLE1BQU0sMEJBQTBCLEdBQUcsR0FBRyxDQUFDO0FBQ3ZDLE1BQU0sd0JBQXdCLEdBQUcsQ0FBQyxDQUFDO0FBQ25DLCtHQUErRztBQUMvRyxxRkFBcUY7QUFDckYsTUFBTSw0QkFBNEIsR0FBRyxNQUFNLENBQUM7QUFlNUM7MkdBQzJHO0FBQzNHLE1BQU0sVUFBVSx1QkFBdUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMzRixPQUFPLE9BQU8sR0FBRyxDQUFDLGtDQUFrQyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLGtDQUFrQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDekgsQ0FBQztBQUVELE1BQU0sT0FBTyxlQUFnQixTQUFRLEtBQUs7SUFDeEMsSUFBSSxDQUFTO0lBQ2IsWUFBWSxJQUFZLEVBQUUsT0FBZ0I7UUFDeEMsS0FBSyxDQUFDLE9BQU8sSUFBSSxJQUFJLENBQUMsQ0FBQztRQUN2QixJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQztJQUNuQixDQUFDO0NBQ0Y7QUFFRCxTQUFTLFlBQVksQ0FBQyxFQUFVO0lBQzlCLE9BQU8sSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUs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