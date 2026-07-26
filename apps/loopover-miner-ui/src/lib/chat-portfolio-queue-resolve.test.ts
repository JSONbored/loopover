import { describe, expect, it } from "vitest";

import {
  PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
  PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
  resolvePortfolioQueueChatAction,
} from "./chat-portfolio-queue-resolve";

// (#8671) Bare positive integer after the repo (IDENTIFIER_RE's third arm) was never covered —
// existing chat-portfolio-queue-actions cases only used `#7` / `issue:12`.

describe("resolvePortfolioQueueChatAction bare-integer identifier (#8671)", () => {
  it('resolves "release acme/widgets 12" to identifier issue:12', () => {
    expect(resolvePortfolioQueueChatAction("release acme/widgets 12")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      target: { repoFullName: "acme/widgets", identifier: "issue:12" },
    });
  });

  it('resolves "requeue acme/widgets 12" to identifier issue:12', () => {
    expect(resolvePortfolioQueueChatAction("requeue acme/widgets 12")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
      target: { repoFullName: "acme/widgets", identifier: "issue:12" },
    });
  });

  it("does not treat a digit glued to a letter (e.g. v2) as a bare-integer identifier", () => {
    // Lookbehind/lookahead require the digit not be adjacent to alphanumerics — "v2" must not become issue:2.
    expect(resolvePortfolioQueueChatAction("release acme/widgets for sprint v2")).toEqual({
      ok: true,
      action: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
      target: { repoFullName: "acme/widgets" },
    });
  });
});
