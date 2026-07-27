import { afterEach, describe, expect, it, vi } from "vitest";
import { mintShotRenderToken, verifyShotRenderToken } from "../../src/review/visual/shot-render-token";
import { createTestEnv } from "../helpers/d1";

const URL_A = "https://preview.pages.dev/app";
const URL_B = "https://preview.pages.dev/other";

function paramsFromSuffix(suffix: string): URLSearchParams {
  return new URLSearchParams(suffix);
}

describe("shot-render-token (#9044 -- signed, expiring gate for /loopover/shot's on-demand render mode)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a token that validates for the exact url it was minted for", async () => {
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    expect(suffix).toMatch(/^exp=\d+&sig=[0-9a-f]{64}$/);
    await expect(verifyShotRenderToken(env, URL_A, paramsFromSuffix(suffix))).resolves.toBe(true);
  });

  it("rejects a token minted for a DIFFERENT url -- the signature binds to the exact url, not just any valid token shape", async () => {
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    await expect(verifyShotRenderToken(env, URL_B, paramsFromSuffix(suffix))).resolves.toBe(false);
  });

  it("rejects a token with a tampered signature", async () => {
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    const params = paramsFromSuffix(suffix);
    const sig = params.get("sig")!;
    // Flip one hex character -- still a well-formed 64-char hex string, just not the real signature.
    const tampered = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
    params.set("sig", tampered);
    await expect(verifyShotRenderToken(env, URL_A, params)).resolves.toBe(false);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    // Past the 24h TTL.
    vi.setSystemTime(new Date("2026-06-25T12:00:01.000Z"));
    await expect(verifyShotRenderToken(env, URL_A, paramsFromSuffix(suffix))).resolves.toBe(false);
  });

  it("accepts a token right up to (but not past) its expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    vi.setSystemTime(new Date("2026-06-25T11:59:59.000Z")); // 1s before the 24h TTL elapses
    await expect(verifyShotRenderToken(env, URL_A, paramsFromSuffix(suffix))).resolves.toBe(true);
  });

  it("rejects a missing sig param", async () => {
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    const params = paramsFromSuffix(suffix);
    params.delete("sig");
    await expect(verifyShotRenderToken(env, URL_A, params)).resolves.toBe(false);
  });

  it("rejects a missing exp param", async () => {
    const env = createTestEnv();
    const suffix = await mintShotRenderToken(env, URL_A);
    const params = paramsFromSuffix(suffix);
    params.delete("exp");
    await expect(verifyShotRenderToken(env, URL_A, params)).resolves.toBe(false);
  });

  it("rejects a non-numeric exp param", async () => {
    const env = createTestEnv();
    await expect(verifyShotRenderToken(env, URL_A, new URLSearchParams({ exp: "not-a-number", sig: "a".repeat(64) }))).resolves.toBe(false);
  });

  it("rejects entirely absent params", async () => {
    const env = createTestEnv();
    await expect(verifyShotRenderToken(env, URL_A, new URLSearchParams())).resolves.toBe(false);
  });

  it("two mints for the same url+instant produce the same signature (deterministic HMAC, not a nonce)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const env = createTestEnv();
    const first = await mintShotRenderToken(env, URL_A);
    const second = await mintShotRenderToken(env, URL_A);
    expect(first).toBe(second);
  });

  it("different INTERNAL_JOB_TOKEN secrets produce different signatures -- an instance's own secret is what a token is bound to", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-24T12:00:00.000Z"));
    const envA = createTestEnv({ INTERNAL_JOB_TOKEN: "secret-a" });
    const envB = createTestEnv({ INTERNAL_JOB_TOKEN: "secret-b" });
    const suffixA = await mintShotRenderToken(envA, URL_A);
    await expect(verifyShotRenderToken(envB, URL_A, paramsFromSuffix(suffixA))).resolves.toBe(false);
  });
});
