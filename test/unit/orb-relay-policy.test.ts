import { describe, expect, it } from "vitest";
import {
  isRelayFailureRetryTerminal,
  isRelayForwardableEvent,
  shouldPersistRelayFailure,
} from "../../src/orb/relay";

describe("orb relay delivery policy", () => {
  describe("isRelayForwardableEvent", () => {
    it("includes review/actuation events and excludes CI firehose + install lifecycle", () => {
      expect(isRelayForwardableEvent("pull_request")).toBe(true);
      expect(isRelayForwardableEvent("check_suite")).toBe(true);
      expect(isRelayForwardableEvent("check_run")).toBe(false);
      expect(isRelayForwardableEvent("installation")).toBe(false);
    });
  });

  describe("shouldPersistRelayFailure", () => {
    it("persists HTTP failures and transient skips for forwardable events with an installation id", () => {
      expect(shouldPersistRelayFailure("failed", "pull_request", 42)).toBe(true);
      expect(shouldPersistRelayFailure("skipped", "pull_request", 42)).toBe(true);
    });

    it("does not persist success outcomes or permanently non-forwardable events", () => {
      expect(shouldPersistRelayFailure("forwarded", "pull_request", 42)).toBe(false);
      expect(shouldPersistRelayFailure("queued", "pull_request", 42)).toBe(false);
      expect(shouldPersistRelayFailure("ignored", "pull_request", 42)).toBe(false);
      expect(shouldPersistRelayFailure("skipped", "check_run", 42)).toBe(false);
      expect(shouldPersistRelayFailure("failed", "check_run", 42)).toBe(false);
    });

    it("does not persist when the installation id is absent", () => {
      expect(shouldPersistRelayFailure("failed", "pull_request", null)).toBe(false);
      expect(shouldPersistRelayFailure("skipped", "pull_request", undefined)).toBe(false);
    });
  });

  describe("isRelayFailureRetryTerminal", () => {
    it("deletes rows after successful delivery", () => {
      expect(isRelayFailureRetryTerminal("forwarded", "pull_request")).toBe(true);
      expect(isRelayFailureRetryTerminal("queued", "pull_request")).toBe(true);
      expect(isRelayFailureRetryTerminal("ignored", "pull_request")).toBe(true);
    });

    it("deletes skipped rows only when the event is permanently non-forwardable", () => {
      expect(isRelayFailureRetryTerminal("skipped", "check_run")).toBe(true);
      expect(isRelayFailureRetryTerminal("skipped", "pull_request")).toBe(false);
    });

    it("keeps failed and transient-skipped forwardable rows for backoff retry", () => {
      expect(isRelayFailureRetryTerminal("failed", "pull_request")).toBe(false);
      expect(isRelayFailureRetryTerminal("skipped", "issues")).toBe(false);
    });
  });
});
