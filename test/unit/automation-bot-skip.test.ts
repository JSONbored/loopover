import { describe, expect, it } from "vitest";
import {
  isSkipAutomationBotPullRequestsEnabledGlobally,
  isTrustedAutomationBotAuthor,
  isTrustedAutomationBotWebhookActor,
  resolveSkipAutomationBotPullRequests,
} from "../../src/settings/automation-bot-skip";

describe("isSkipAutomationBotPullRequestsEnabledGlobally", () => {
  it("defaults ON when unset (unlike most LOOPOVER_REVIEW_* flags)", () => {
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({})).toBe(true);
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: undefined })).toBe(true);
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "" })).toBe(true);
  });

  it("stays ON for an explicit truthy value", () => {
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "true" })).toBe(true);
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "1" })).toBe(true);
  });

  it("turns OFF only for an explicit falsy value, case-insensitively", () => {
    for (const value of ["0", "false", "False", "FALSE", "no", "No", "off", "OFF"]) {
      expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: value })).toBe(false);
    }
  });

  it("stays ON for whitespace around a truthy/garbage value", () => {
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "  false  " })).toBe(false);
    expect(isSkipAutomationBotPullRequestsEnabledGlobally({ GITTENSORY_SKIP_AUTOMATION_BOT_PRS: "banana" })).toBe(true);
  });
});

describe("resolveSkipAutomationBotPullRequests", () => {
  it("inherit defers to the global default in both directions", () => {
    expect(resolveSkipAutomationBotPullRequests(true, "inherit")).toBe(true);
    expect(resolveSkipAutomationBotPullRequests(false, "inherit")).toBe(false);
  });

  it("null/undefined mode behaves the same as inherit", () => {
    expect(resolveSkipAutomationBotPullRequests(true, null)).toBe(true);
    expect(resolveSkipAutomationBotPullRequests(false, undefined)).toBe(false);
  });

  it("off fully overrides a globally-ON default", () => {
    expect(resolveSkipAutomationBotPullRequests(true, "off")).toBe(false);
  });

  it("enabled fully overrides a globally-OFF default (symmetric, unlike moderation's global-authoritative gate)", () => {
    expect(resolveSkipAutomationBotPullRequests(false, "enabled")).toBe(true);
  });
});

describe("isTrustedAutomationBotAuthor (re-entry paths: stored author precondition)", () => {
  it("true for every known automation login, case-insensitively", () => {
    expect(isTrustedAutomationBotAuthor("github-actions[bot]")).toBe(true);
    expect(isTrustedAutomationBotAuthor("Renovate[Bot]")).toBe(true);
    expect(isTrustedAutomationBotAuthor("dependabot[bot]")).toBe(true);
  });

  it("false for a human contributor, including a look-alike login", () => {
    expect(isTrustedAutomationBotAuthor("JSONbored")).toBe(false);
    expect(isTrustedAutomationBotAuthor("renovate")).toBe(false); // missing the [bot] suffix
    expect(isTrustedAutomationBotAuthor(null)).toBe(false);
    expect(isTrustedAutomationBotAuthor(undefined)).toBe(false);
  });
});

// SECURITY: these pin the exploit-resistance guarantee described in isTrustedAutomationBotWebhookActor's own
// doc comment. Do not relax any of the "false" cases below without re-reading that comment first.
describe("isTrustedAutomationBotWebhookActor (SECURITY: the live webhook actor, not just the PR author)", () => {
  it("true for a genuine bot-originated event: sender IS the bot, type is Bot, and it's also the stored PR author", () => {
    expect(
      isTrustedAutomationBotWebhookActor({ login: "github-actions[bot]", type: "Bot" }, "github-actions[bot]"),
    ).toBe(true);
    expect(isTrustedAutomationBotWebhookActor({ login: "renovate[bot]", type: "Bot" }, "renovate[bot]")).toBe(true);
    expect(isTrustedAutomationBotWebhookActor({ login: "dependabot[bot]", type: "Bot" }, "dependabot[bot]")).toBe(true);
  });

  it("true regardless of login casing (mirrors isProtectedAutomationAuthor's own case-insensitivity)", () => {
    expect(isTrustedAutomationBotWebhookActor({ login: "RENOVATE[BOT]", type: "Bot" }, "Renovate[Bot]")).toBe(true);
  });

  it("EXPLOIT CASE: a human who gained push access to an existing bot PR's branch must NOT inherit the skip -- sender is the human triggering THIS event, even though the PR's original/stored author is still the bot", () => {
    expect(
      isTrustedAutomationBotWebhookActor({ login: "malicious-contributor", type: "User" }, "renovate[bot]"),
    ).toBe(false);
  });

  it("false when sender's login matches but type does not say Bot (defense in depth against a future looser login match)", () => {
    expect(isTrustedAutomationBotWebhookActor({ login: "renovate[bot]", type: "User" }, "renovate[bot]")).toBe(false);
  });

  it("false when sender is a genuine bot but NOT one of the trusted three (an untrusted third-party App/bot)", () => {
    expect(isTrustedAutomationBotWebhookActor({ login: "some-other-app[bot]", type: "Bot" }, "some-other-app[bot]")).toBe(false);
  });

  it("false when the stored PR author does not ALSO match, even if sender does (defense in depth: both must agree)", () => {
    expect(isTrustedAutomationBotWebhookActor({ login: "renovate[bot]", type: "Bot" }, "some-human-contributor")).toBe(false);
  });

  it("false (fail-safe) when sender is missing entirely", () => {
    expect(isTrustedAutomationBotWebhookActor(null, "renovate[bot]")).toBe(false);
    expect(isTrustedAutomationBotWebhookActor(undefined, "renovate[bot]")).toBe(false);
    expect(isTrustedAutomationBotWebhookActor({}, "renovate[bot]")).toBe(false);
  });

  it("false when the PR author is missing entirely, even with a genuine bot sender", () => {
    expect(isTrustedAutomationBotWebhookActor({ login: "renovate[bot]", type: "Bot" }, null)).toBe(false);
    expect(isTrustedAutomationBotWebhookActor({ login: "renovate[bot]", type: "Bot" }, undefined)).toBe(false);
  });
});
