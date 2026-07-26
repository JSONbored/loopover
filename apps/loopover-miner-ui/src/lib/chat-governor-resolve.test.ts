import { describe, expect, it } from "vitest";

import {
  GOVERNOR_PAUSE_CHAT_ACTION,
  GOVERNOR_RESUME_CHAT_ACTION,
  resolveGovernorChatAction,
} from "./chat-governor-resolve";

describe("resolveGovernorChatAction (#8670)", () => {
  it("resolves plain pause intents to governor_pause with no params", () => {
    for (const text of [
      "pause the governor",
      "Please PAUSE the governor now",
      "halt the governor",
      "suspend the governor",
    ]) {
      expect(resolveGovernorChatAction(text)).toEqual({ ok: true, action: GOVERNOR_PAUSE_CHAT_ACTION });
    }
  });

  it("resolves resume intents to governor_resume", () => {
    for (const text of ["resume the governor", "unpause the governor", "please Resume the governor"]) {
      expect(resolveGovernorChatAction(text)).toEqual({ ok: true, action: GOVERNOR_RESUME_CHAT_ACTION });
    }
  });

  it('does NOT read "unpause" as a pause intent (word boundaries keep the verb sets disjoint)', () => {
    const resolved = resolveGovernorChatAction("unpause the governor");
    expect(resolved).toEqual({ ok: true, action: GOVERNOR_RESUME_CHAT_ACTION });
  });

  it("extracts a pause reason from a trailing because-clause, trimming end punctuation", () => {
    expect(resolveGovernorChatAction("pause the governor because release traffic spiked.")).toEqual({
      ok: true,
      action: GOVERNOR_PAUSE_CHAT_ACTION,
      params: { reason: "release traffic spiked" },
    });
  });

  it("extracts a pause reason from a reason: clause", () => {
    expect(resolveGovernorChatAction("pause the governor reason: maintenance window")).toEqual({
      ok: true,
      action: GOVERNOR_PAUSE_CHAT_ACTION,
      params: { reason: "maintenance window" },
    });
  });

  it("omits an empty because-clause instead of sending an empty reason", () => {
    expect(resolveGovernorChatAction("pause the governor because ")).toEqual({
      ok: true,
      action: GOVERNOR_PAUSE_CHAT_ACTION,
    });
  });

  it("is unresolvable for empty / non-governor / verb-less / ambiguous text", () => {
    for (const text of [
      "",
      "   ",
      "pause everything", // no governor mention — a bare "pause" must not guess a target
      "what is the governor status?", // governor question, no pause/resume verb
      "governor paused?", // "paused" is not the verb "pause" (word-bounded)
      "pause and then resume the governor", // both intents at once — ambiguous
    ]) {
      const resolved = resolveGovernorChatAction(text);
      expect(resolved.ok).toBe(false);
      if (!resolved.ok) {
        expect(resolved.reason).toBe("unresolvable");
        expect(resolved.message).toContain("governor");
      }
    }
  });
});
