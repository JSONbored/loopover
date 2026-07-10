import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestEnv } from "../helpers/d1";
import type { GitHubWebhookPayload } from "../../src/types";

// Spy on the one function this issue wires up; keep every other decision-pack export real so outcomes-wire's
// transitive graph is unaffected.
const { enqueueSpy } = vi.hoisted(() => ({ enqueueSpy: vi.fn() }));
vi.mock("../../src/services/decision-pack", async (importActual) => ({
  ...(await importActual<typeof import("../../src/services/decision-pack")>()),
  tryEnqueueDecisionPackRebuild: enqueueSpy,
}));

import { recordPrOutcome } from "../../src/review/outcomes-wire";

const closedPr = (opts: { author: string; sender: string; merged: boolean; senderType?: string }) =>
  ({
    action: "closed",
    pull_request: { number: 7, merged_at: opts.merged ? "2026-01-01T00:00:00Z" : null, user: { login: opts.author } },
    repository: { full_name: "acme/widgets" },
    sender: { login: opts.sender, type: opts.senderType ?? "User" },
  }) as unknown as GitHubWebhookPayload;

describe("recordPrOutcome → proactive decision-pack rebuild (#4283)", () => {
  beforeEach(() => enqueueSpy.mockReset().mockResolvedValue(true));

  it("enqueues a rebuild for the PR author on a merged (maintainer-authoritative) close", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", closedPr({ author: "Miner1", sender: "maintainer", merged: true }));
    expect(enqueueSpy).toHaveBeenCalledWith(env, "miner1"); // authorLogin, lowercased
  });

  it("does NOT enqueue on a self-close (author closes their own unmerged PR — anti-poisoning suppression)", async () => {
    const env = createTestEnv();
    await recordPrOutcome(env, "pull_request", closedPr({ author: "miner1", sender: "miner1", merged: false }));
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when the PR has no author login (ghost/deleted account)", async () => {
    const env = createTestEnv();
    // merged (so the self-close guard doesn't apply), but no user login ⇒ authorLogin is empty ⇒ skip the enqueue
    const payload = { action: "closed", pull_request: { number: 7, merged_at: "2026-01-01T00:00:00Z", user: null }, repository: { full_name: "acme/widgets" }, sender: { login: "maintainer", type: "User" } } as unknown as GitHubWebhookPayload;
    await recordPrOutcome(env, "pull_request", payload);
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it("a rebuild-enqueue failure never throws out of recordPrOutcome", async () => {
    const env = createTestEnv();
    enqueueSpy.mockRejectedValueOnce(new Error("boom"));
    await expect(
      recordPrOutcome(env, "pull_request", closedPr({ author: "miner1", sender: "bot", senderType: "Bot", merged: true })),
    ).resolves.toBeUndefined();
    expect(enqueueSpy).toHaveBeenCalledWith(env, "miner1");
  });
});
