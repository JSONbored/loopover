import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAmsAttemptFailedPayload,
  buildAmsAttemptStartedPayload,
  buildAmsGovernorPausedPayload,
  buildAmsPrOutcomePayload,
  publishAmsNotificationEvents,
  scheduleAmsNotificationEvents,
} from "../../packages/loopover-miner/lib/ams-notifications.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeSessionConfig(loginToken = "session-token"): { env: Record<string, string | undefined>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ams-notifications-config-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      activeProfile: "default",
      profiles: {
        default: {
          apiUrl: "https://api.example.test",
          session: { token: loginToken },
        },
      },
    }),
  );
  return { env: { LOOPOVER_CONFIG_PATH: configPath }, root };
}

describe("ams-notifications (#7657)", () => {
  it("builds AMS payloads mirroring hosted DetectedNotificationEvent shape", () => {
    expect(
      buildAmsAttemptStartedPayload({
        recipientLogin: "Miner",
        repoFullName: "acme/widgets",
        issueNumber: 2,
        attemptId: "a1",
        detectedAt: "2026-07-21T00:00:00.000Z",
      }),
    ).toMatchObject({
      eventType: "ams_attempt_started",
      recipientLogin: "miner",
      pullNumber: 2,
    });
    expect(
      buildAmsAttemptFailedPayload({
        recipientLogin: "miner",
        repoFullName: "acme/widgets",
        issueNumber: 2,
        attemptId: "a1",
        reason: "abandon",
      }).dedupKey,
    ).toContain(":abandon");
    expect(buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" }).pullNumber).toBe(0);
    expect(
      buildAmsPrOutcomePayload({
        recipientLogin: "miner",
        repoFullName: "acme/widgets",
        pullNumber: 9,
        decision: "closed",
        closedAt: "t",
      }).eventType,
    ).toBe("ams_pr_outcome");
  });

  it("defaults detectedAt/reason when omitted (branch coverage)", () => {
    expect(
      buildAmsAttemptStartedPayload({ recipientLogin: "miner", repoFullName: "acme/widgets", issueNumber: 1, attemptId: "a1" })
        .detectedAt,
    ).toEqual(expect.any(String));
    expect(
      buildAmsAttemptFailedPayload({ recipientLogin: "miner", repoFullName: "acme/widgets", issueNumber: 1, attemptId: "a1" })
        .dedupKey,
    ).toBe("ams_attempt_failed:acme/widgets#1:a1");
    const paused = buildAmsGovernorPausedPayload({ recipientLogin: "miner" });
    expect(paused.dedupKey).toBe(`ams_governor_paused:miner:${paused.detectedAt}`);
    expect(
      buildAmsPrOutcomePayload({ recipientLogin: "miner", repoFullName: "acme/widgets", pullNumber: 1, decision: "merged" })
        .detectedAt,
    ).toEqual(expect.any(String));
  });

  it("uses an injected dispatch (job-dispatch evaluate→deliver shape) when provided", async () => {
    const dispatch = vi.fn(async () => undefined);
    const event = buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" });
    await expect(publishAmsNotificationEvents([event], { dispatch })).resolves.toEqual({ sent: 1 });
    expect(dispatch).toHaveBeenCalledWith([event]);
  });

  it("returns no_session without a loopover backend session", async () => {
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env: { LOOPOVER_CONFIG_PATH: join(tmpdir(), "missing-loopover-config.json") },
      }),
    ).resolves.toEqual({ sent: 0, error: "no_session" });
  });

  it("falls back to process.env when no env option is provided", async () => {
    const original = process.env.LOOPOVER_CONFIG_PATH;
    process.env.LOOPOVER_CONFIG_PATH = join(tmpdir(), "missing-loopover-config.json");
    try {
      await expect(
        publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })]),
      ).resolves.toEqual({ sent: 0, error: "no_session" });
    } finally {
      if (original === undefined) delete process.env.LOOPOVER_CONFIG_PATH;
      else process.env.LOOPOVER_CONFIG_PATH = original;
    }
  });

  it("includes an optional pause reason in the dedupKey", () => {
    expect(buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t", reason: "ops incident" }).dedupKey).toContain(
      ":ops incident",
    );
  });

  it("returns missing_recipient when the recipient login is blank", async () => {
    const { env } = writeSessionConfig();
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "  ", pausedAt: "t" })], { env }),
    ).resolves.toEqual({ sent: 0, error: "missing_recipient" });
  });

  it("POSTs to the contributor ams-notifications ingest when a session is present", async () => {
    const { env } = writeSessionConfig();
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));
    const event = buildAmsAttemptStartedPayload({
      recipientLogin: "miner",
      repoFullName: "acme/widgets",
      issueNumber: 1,
      attemptId: "a1",
      detectedAt: "2026-07-21T00:00:00.000Z",
    });
    await expect(publishAmsNotificationEvents([event], { env, fetchFn })).resolves.toEqual({ sent: 1 });
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.example.test/v1/contributors/miner/ams-notifications",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session-token" }),
      }),
    );
  });

  it("reports http errors and mixed recipients on the HTTP path", async () => {
    const { env } = writeSessionConfig();
    const fetchFn = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env,
        fetchFn,
      }),
    ).resolves.toEqual({ sent: 0, error: "http_500" });

    await expect(
      publishAmsNotificationEvents(
        [
          buildAmsGovernorPausedPayload({ recipientLogin: "a", pausedAt: "t" }),
          buildAmsGovernorPausedPayload({ recipientLogin: "b", pausedAt: "t" }),
        ],
        { env, fetchFn },
      ),
    ).resolves.toEqual({ sent: 0, error: "mixed_recipients" });
  });

  it("reports network failures on the HTTP path without throwing", async () => {
    const { env } = writeSessionConfig();
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env,
        fetchFn,
      }),
    ).resolves.toEqual({ sent: 0, error: "network down" });
  });

  it("scheduleAmsNotificationEvents is fire-and-forget", async () => {
    const dispatch = vi.fn(async () => undefined);
    scheduleAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
      dispatch,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled());
  });

  it("reports dispatch failures without throwing", async () => {
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        dispatch: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toEqual({ sent: 0, error: "boom" });
  });

  it("falls back to a generic error string when a non-Error is thrown (dispatch and HTTP paths)", async () => {
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        dispatch: async () => {
          throw "not an Error instance";
        },
      }),
    ).resolves.toEqual({ sent: 0, error: "dispatch_failed" });

    const { env } = writeSessionConfig();
    await expect(
      publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], {
        env,
        fetchFn: async () => {
          throw "not an Error instance";
        },
      }),
    ).resolves.toEqual({ sent: 0, error: "network_failed" });
  });

  it("uses the ambient global fetch when fetchFn is not injected", async () => {
    const { env } = writeSessionConfig();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(
        publishAmsNotificationEvents([buildAmsGovernorPausedPayload({ recipientLogin: "miner", pausedAt: "t" })], { env }),
      ).resolves.toEqual({ sent: 1 });
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns sent 0 for an empty event list", async () => {
    await expect(publishAmsNotificationEvents([])).resolves.toEqual({ sent: 0 });
  });
});
