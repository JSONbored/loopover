// GitHub OAuth Device Flow client (#5682) for the centrally-held `loopover-ams` GitHub App -- lets a
// contributor authorize gittensory-miner by visiting a URL and entering a short code, instead of generating
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

/** The centrally-held loopover-ams App's OAuth client id -- public (not secret), so it's safe to read from a
 *  plain env var. Empty/unset means device-flow authorization isn't available in this build/deployment. */
export function resolveAmsOauthClientId(env = process.env) {
  return typeof env.LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID === "string" ? env.LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID.trim() : "";
}

export class DeviceFlowError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Step 1 of the device flow: request a device code + the short user-facing code from GitHub. */
export async function requestDeviceCode({ clientId, scope = DEFAULT_SCOPE, fetchFn = fetch } = {}) {
  if (!clientId) throw new DeviceFlowError("missing_client_id", "no OAuth client id configured for device-flow authorization");
  const res = await fetchFn(DEVICE_CODE_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  if (!res.ok) throw new DeviceFlowError("device_code_request_failed", `GitHub returned HTTP ${res.status} requesting a device code`);
  const data = await res.json();
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
export async function pollForAccessToken({
  clientId,
  deviceCode,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
  fetchFn = fetch,
  sleepFn = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const deadline = now() + expiresInSeconds * 1000;
  let interval = intervalSeconds;
  for (;;) {
    if (now() >= deadline) throw new DeviceFlowError("expired_token", "the device code expired before authorization completed");
    await sleepFn(interval * 1000);
    const res = await fetchFn(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (data && typeof data.access_token === "string" && data.access_token) {
      return { accessToken: data.access_token, scope: typeof data.scope === "string" ? data.scope : "" };
    }
    const error = data && typeof data.error === "string" ? data.error : null;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = typeof data.interval === "number" ? data.interval : interval + 5;
      continue;
    }
    if (error === "expired_token") throw new DeviceFlowError("expired_token", "the device code expired before authorization completed");
    if (error === "access_denied") throw new DeviceFlowError("access_denied", "authorization was declined");
    throw new DeviceFlowError(error || "device_flow_failed", (data && data.error_description) || `unexpected device-flow response (HTTP ${res.status})`);
  }
}

/**
 * Run the full device-flow authorization end to end: request a code, hand it to the caller's `onCode` (so the
 * caller can display it however it likes -- CLI text, structured JSON, etc.), then poll until the user
 * completes, declines, or the code expires. Returns the resulting access token; throws a DeviceFlowError on
 * any failure -- the caller decides whether to fall back to another auth method.
 */
export async function runDeviceFlowAuthorization({ clientId, scope, onCode, fetchFn = fetch, sleepFn, now }) {
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
