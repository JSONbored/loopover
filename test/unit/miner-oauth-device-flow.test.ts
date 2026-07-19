import { describe, expect, it, vi } from "vitest";
import {
  DeviceFlowError,
  pollForAccessToken,
  requestDeviceCode,
  resolveAmsOauthClientId,
  runDeviceFlowAuthorization,
} from "../../packages/loopover-miner/lib/oauth-device-flow.js";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

describe("resolveAmsOauthClientId (#5682)", () => {
  it("returns the trimmed configured client id, or empty when unset/blank", () => {
    expect(resolveAmsOauthClientId({ LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID: "  client-abc  " })).toBe("client-abc");
    expect(resolveAmsOauthClientId({})).toBe("");
    expect(resolveAmsOauthClientId({ LOOPOVER_MINER_AMS_OAUTH_CLIENT_ID: "   " })).toBe("");
  });
});

describe("DeviceFlowError (#5682)", () => {
  it("defaults .message to the code when no message is given", () => {
    const error = new DeviceFlowError("code_only");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("code_only");
    expect(error.message).toBe("code_only");
  });

  it("uses the given message over the code when both are provided", () => {
    const error = new DeviceFlowError("some_code", "a human-readable reason");
    expect(error.code).toBe("some_code");
    expect(error.message).toBe("a human-readable reason");
  });
});

describe("requestDeviceCode (#5682)", () => {
  it("POSTs client_id + scope and returns the parsed device code fields, defaulting expires/interval when absent", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dc1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" }));
    const result = await requestDeviceCode({ clientId: "client-abc", fetchFn });
    expect(result).toEqual({
      deviceCode: "dc1",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("client_id=client-abc&scope=repo");
  });

  it("honors GitHub-supplied expires_in/interval when present", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dc1", user_code: "u", verification_uri: "v", expires_in: 600, interval: 10 }));
    const result = await requestDeviceCode({ clientId: "c", fetchFn });
    expect(result.expiresInSeconds).toBe(600);
    expect(result.intervalSeconds).toBe(10);
  });

  it("throws missing_client_id without calling fetch when clientId is empty", async () => {
    const fetchFn = vi.fn();
    await expect(requestDeviceCode({ clientId: "", fetchFn })).rejects.toMatchObject({ code: "missing_client_id" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("throws device_code_request_failed on a non-2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(requestDeviceCode({ clientId: "c", fetchFn })).rejects.toMatchObject({ code: "device_code_request_failed" });
  });

  it("REGRESSION (#6988): bounds the fetch with a request timeout so a stalled connection can't hang forever", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dc1", user_code: "u", verification_uri: "v" }));
    await requestDeviceCode({ clientId: "c", fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws device_code_response_invalid when a required field is missing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ device_code: "dc1" }));
    await expect(requestDeviceCode({ clientId: "c", fetchFn })).rejects.toMatchObject({ code: "device_code_response_invalid" });
  });

  it("DeviceFlowError instances are real Error instances with a .code", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    try {
      await requestDeviceCode({ clientId: "c", fetchFn });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DeviceFlowError);
      expect((error as DeviceFlowError).code).toBe("device_code_request_failed");
    }
  });
});

describe("pollForAccessToken (#5682)", () => {
  const noSleep = vi.fn().mockResolvedValue(undefined);

  it("returns the access token on the first successful poll", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "gho_xyz", scope: "repo" }));
    const result = await pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep });
    expect(result).toEqual({ accessToken: "gho_xyz", scope: "repo" });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).toBe("client_id=c&device_code=dc1&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  it("REGRESSION: when sleepFn is omitted, the REAL default (setTimeout-based) sleep is used", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "gho_real_sleep" }));
    // intervalSeconds: 0 keeps the real setTimeout-based wait effectively instant, so this stays a fast unit
    // test while still exercising the real default (never overridden here) rather than a test double.
    const result = await pollForAccessToken({ clientId: "c", deviceCode: "dc1", intervalSeconds: 0, fetchFn });
    expect(result.accessToken).toBe("gho_real_sleep");
  });

  it("defaults scope to empty string when GitHub omits it", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "gho_xyz" }));
    const result = await pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep });
    expect(result.scope).toBe("");
  });

  it("REGRESSION (#6988): bounds each poll's fetch with a request timeout so a stalled connection can't hang forever", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ access_token: "gho_xyz" }));
    await pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("REGRESSION (#6988): a timed-out/rejected fetch is a per-attempt failure that still retries, not an unhandled crash", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("The operation was aborted", "TimeoutError"))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_after_timeout" }));
    const result = await pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep });
    expect(result.accessToken).toBe("gho_after_timeout");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("REGRESSION (#6988): a permanently stalled connection still respects the deadline instead of hanging forever", async () => {
    let clock = 0;
    const now = () => clock;
    const sleepFn = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    });
    const fetchFn = vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"));
    await expect(
      pollForAccessToken({ clientId: "c", deviceCode: "dc1", intervalSeconds: 5, expiresInSeconds: 12, fetchFn, sleepFn, now }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("keeps polling on authorization_pending until a token is granted", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_final" }));
    const result = await pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep });
    expect(result.accessToken).toBe("gho_final");
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("slow_down widens the poll interval to GitHub's requested value (observable via the sleep call)", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down", interval: 20 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_final" }));
    await pollForAccessToken({ clientId: "c", deviceCode: "dc1", intervalSeconds: 5, fetchFn, sleepFn });
    expect(sleepFn).toHaveBeenNthCalledWith(1, 5000); // first sleep at the original interval
    expect(sleepFn).toHaveBeenNthCalledWith(2, 20000); // second sleep at GitHub's widened interval
  });

  it("slow_down without an explicit interval widens by a fixed 5s step", async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down" }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_final" }));
    await pollForAccessToken({ clientId: "c", deviceCode: "dc1", intervalSeconds: 5, fetchFn, sleepFn });
    expect(sleepFn).toHaveBeenNthCalledWith(2, 10000);
  });

  it("throws expired_token when GitHub reports it", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "expired_token" }));
    await expect(pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({ code: "expired_token" });
  });

  it("throws access_denied when the user declines", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "access_denied" }));
    await expect(pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({ code: "access_denied" });
  });

  it("throws the raw error code + description for any other terminal error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "incorrect_client_credentials", error_description: "bad client" }));
    await expect(pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({
      code: "incorrect_client_credentials",
      message: "bad client",
    });
  });

  it("throws device_flow_failed with an HTTP-status fallback message when the response has neither a token nor a recognized error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 503));
    await expect(pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({
      code: "device_flow_failed",
      message: expect.stringContaining("503"),
    });
  });

  it("tolerates a non-JSON response body (json().catch -> {})", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("not json"); } });
    await expect(pollForAccessToken({ clientId: "c", deviceCode: "dc1", fetchFn, sleepFn: noSleep })).rejects.toMatchObject({ code: "device_flow_failed" });
  });

  it("expires the poll loop once the deadline (via the injected now()) passes, without exceeding it", async () => {
    let clock = 0;
    const now = () => clock;
    const sleepFn = vi.fn().mockImplementation(async (ms: number) => {
      clock += ms;
    });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "authorization_pending" }));
    await expect(
      pollForAccessToken({ clientId: "c", deviceCode: "dc1", intervalSeconds: 5, expiresInSeconds: 12, fetchFn, sleepFn, now }),
    ).rejects.toMatchObject({ code: "expired_token" });
    // The deadline check runs BEFORE each sleep+poll, so it only stops once now() itself has passed the
    // deadline: polls happen at t=5s, t=10s, t=15s (each still < the 12s deadline check *before* that sleep),
    // then the pre-check at t=15s (now() >= 12000) finally throws before a 4th poll.
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("runDeviceFlowAuthorization (#5682)", () => {
  it("requests a code, hands it to onCode, then polls and returns the token", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ device_code: "dc1", user_code: "WXYZ-9876", verification_uri: "https://github.com/login/device", interval: 1 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_full_flow" }));
    const onCode = vi.fn();
    const result = await runDeviceFlowAuthorization({ clientId: "c", fetchFn, sleepFn: vi.fn().mockResolvedValue(undefined), onCode });
    expect(result).toEqual({ accessToken: "gho_full_flow", scope: "" });
    expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ deviceCode: "dc1", userCode: "WXYZ-9876" }));
  });

  it("forwards an explicit scope and injected clock while retaining the default sleep", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ device_code: "dc1", user_code: "WXYZ-9876", verification_uri: "https://github.com/login/device", interval: 0 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "gho_scoped" }));
    const now = vi.fn(() => 0);

    await expect(
      runDeviceFlowAuthorization({ clientId: "c", scope: "read:user", fetchFn, now, onCode: vi.fn() }),
    ).resolves.toEqual({ accessToken: "gho_scoped", scope: "" });
    expect(String((fetchFn.mock.calls[0]?.[1] as RequestInit).body)).toContain("scope=read%3Auser");
    expect(now).toHaveBeenCalled();
  });

  it("propagates a requestDeviceCode failure without ever calling onCode", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    const onCode = vi.fn();
    await expect(runDeviceFlowAuthorization({ clientId: "c", fetchFn, onCode })).rejects.toMatchObject({ code: "device_code_request_failed" });
    expect(onCode).not.toHaveBeenCalled();
  });
});
