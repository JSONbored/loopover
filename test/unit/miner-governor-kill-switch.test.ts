import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  checkMinerKillSwitch,
  notifyMinerKillSwitchPagerDuty,
  recordMinerKillSwitchTransition,
} from "../../packages/loopover-miner/lib/governor-kill-switch";
import { initGovernorLedger } from "../../packages/loopover-miner/lib/governor-ledger";
import type { MinerKillSwitchPagerDutyAlert } from "../../packages/loopover-engine/src/index";

const VALID_ROUTING_KEY = "a".repeat(32);

function stubFetch(status = 202): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    return new Response(null, { status });
  });
  return calls;
}

function pagerDutyAlert(over: Partial<MinerKillSwitchPagerDutyAlert> = {}): MinerKillSwitchPagerDutyAlert {
  return {
    repoFullName: "acme/widgets",
    scope: "repo",
    actionClass: "open_pr",
    summary: "AMS miner kill-switch tripped (repo) — open_pr halted for acme/widgets",
    severity: "critical",
    dedupKey: "miner_kill_switch_tripped:repo:acme/widgets",
    customDetails: { scope: "repo", previousScope: "none", repoFullName: "acme/widgets", actionClass: "open_pr" },
    ...over,
  };
}

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("checkMinerKillSwitch (#2341)", () => {
  it("global env switch halts regardless of per-repo state", () => {
    expect(checkMinerKillSwitch({ repoPaused: false, env: { LOOPOVER_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
    expect(checkMinerKillSwitch({ repoPaused: true, env: { LOOPOVER_MINER_KILL_SWITCH: "true" } })).toEqual({
      scope: "global",
      active: true,
    });
  });

  it("per-repo pause halts only when the global switch is not tripped", () => {
    expect(checkMinerKillSwitch({ repoPaused: true, env: {} })).toEqual({ scope: "repo", active: true });
    expect(checkMinerKillSwitch({ repoPaused: false, env: {} })).toEqual({ scope: "none", active: false });
  });

  it("defaults to reading process.env when no env override is given", () => {
    const original = process.env.LOOPOVER_MINER_KILL_SWITCH;
    try {
      process.env.LOOPOVER_MINER_KILL_SWITCH = "1";
      expect(checkMinerKillSwitch({ repoPaused: false })).toEqual({ scope: "global", active: true });
    } finally {
      if (original === undefined) delete process.env.LOOPOVER_MINER_KILL_SWITCH;
      else process.env.LOOPOVER_MINER_KILL_SWITCH = original;
    }
  });
});

describe("recordMinerKillSwitchTransition (#2341)", () => {
  it("records a tripped transition to the governor ledger and resuming records a second row", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(tripped?.eventType).toBe("kill_switch");
    expect(tripped?.decision).toBe("tripped");

    const resumed = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "repo", scope: "none" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );
    expect(resumed?.decision).toBe("resumed");

    const rows = ledger.readGovernorEvents({ repoFullName: "acme/widgets" });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBeLessThan(rows[1]?.id ?? 0);
  });

  it("a transition with no repoFullName supplied records a null repoFullName, not an omitted or undefined one", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-no-repo-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);

    const tripped = recordMinerKillSwitchTransition(
      { actionClass: "open_pr", previousScope: "none", scope: "global" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(tripped?.repoFullName).toBeNull();
    const rows = ledger.readGovernorEvents({});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repoFullName).toBeNull();
  });

  it("is a no-op and appends nothing when the scope has not changed", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-noop-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const append = vi.fn((event: Parameters<typeof ledger.appendGovernorEvent>[0]) => ledger.appendGovernorEvent(event));

    const result = recordMinerKillSwitchTransition(
      { actionClass: "open_pr", previousScope: "none", scope: "none" },
      { append },
    );

    expect(result).toBeNull();
    expect(append).not.toHaveBeenCalled();
    expect(ledger.readGovernorEvents({})).toHaveLength(0);
  });

  it("falls back to the real governor-ledger appendGovernorEvent when no append override is supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-default-append-"));
    roots.push(root);
    const dbPath = join(root, "governor-ledger.sqlite3");
    const previousDbPath = process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
    process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = dbPath;
    try {
      const { closeDefaultGovernorLedger } = await import("../../packages/loopover-miner/lib/governor-ledger");
      const tripped = recordMinerKillSwitchTransition({
        repoFullName: "acme/widgets",
        actionClass: "open_pr",
        previousScope: "none",
        scope: "repo",
      });
      expect(tripped?.decision).toBe("tripped");
      closeDefaultGovernorLedger();

      // recordMinerKillSwitchTransition wrote through the module-level default appendGovernorEvent (no override
      // passed); reopening the same file after closing that default confirms the write was actually persisted.
      const reopened = initGovernorLedger(dbPath);
      ledgers.push(reopened);
      expect(reopened.readGovernorEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
    } finally {
      if (previousDbPath === undefined) delete process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB;
      else process.env.LOOPOVER_MINER_GOVERNOR_LEDGER_DB = previousDbPath;
    }
  });

  it("pages PagerDuty on a TRIP transition, after the ledger row is appended (#7666)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-trip-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const calls: MinerKillSwitchPagerDutyAlert[] = [];
    const notify = vi.fn((alert: MinerKillSwitchPagerDutyAlert) => {
      // The ledger row must already be visible by the time notify fires.
      expect(ledger.readGovernorEvents({ repoFullName: "acme/widgets" })).toHaveLength(1);
      calls.push(alert);
    });

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event), notify, env: {} },
    );

    expect(tripped?.decision).toBe("tripped");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ repoFullName: "acme/widgets", scope: "repo", dedupKey: "miner_kill_switch_tripped:repo:acme/widgets" });
  });

  it("does NOT page PagerDuty on a resume transition (#7666)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-resume-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const notify = vi.fn();

    const resumed = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "repo", scope: "none" },
      { append: (event) => ledger.appendGovernorEvent(event), notify, env: {} },
    );

    expect(resumed?.decision).toBe("resumed");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a synchronously-throwing notify hook is swallowed and never blocks the returned ledger entry (#7666)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-sync-throw-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const notify = vi.fn(() => {
      throw new Error("pagerduty transport down");
    });

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event), notify, env: {} },
    );

    expect(tripped?.decision).toBe("tripped");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an asynchronously-rejecting notify hook is caught and never surfaces as unhandled (#7666)", async () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-async-reject-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const notify = vi.fn(async () => {
      throw new Error("pagerduty http 500");
    });

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event), notify, env: {} },
    );

    expect(tripped?.decision).toBe("tripped");
    // Let the fire-and-forget rejection's own .catch handler run so it never surfaces as unhandled.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("a sync notify hook returning void (not a promise) is accepted without calling .catch on it (#7666)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-sync-void-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const notify = vi.fn(() => undefined);

    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event), notify, env: {} },
    );

    expect(tripped?.decision).toBe("tripped");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("defaults to the real notifyMinerKillSwitchPagerDuty + process.env when no notify/env override is passed (#7666)", () => {
    const root = mkdtempSync(join(tmpdir(), "loopover-miner-governor-kill-switch-page-default-notify-"));
    roots.push(root);
    const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
    ledgers.push(ledger);
    const calls = stubFetch();

    // LOOPOVER_ENABLE_PAGERDUTY is unset in the test environment, so the real default notify path resolves to a
    // no-op -- this exercises the "no notify/env option passed" default-parameter branches themselves; the live
    // network call's own guard branches are covered in the notifyMinerKillSwitchPagerDuty describe block below.
    const tripped = recordMinerKillSwitchTransition(
      { repoFullName: "acme/widgets", actionClass: "open_pr", previousScope: "none", scope: "repo" },
      { append: (event) => ledger.appendGovernorEvent(event) },
    );

    expect(tripped?.decision).toBe("tripped");
    expect(calls).toHaveLength(0);
  });
});

describe("notifyMinerKillSwitchPagerDuty (#7666)", () => {
  it("no-op when LOOPOVER_ENABLE_PAGERDUTY is not truthy", async () => {
    const calls = stubFetch();
    await notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), {});
    expect(calls).toHaveLength(0);
  });

  it("no-op when the flag is on but no routing key resolves", async () => {
    const calls = stubFetch();
    await notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "true" });
    expect(calls).toHaveLength(0);
  });

  it("no-op when the routing key is present but malformed", async () => {
    const calls = stubFetch();
    await notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "1", PAGERDUTY_ROUTING_KEY: "not-hex" });
    expect(calls).toHaveLength(0);
  });

  it("no-op when the routing key is present but blank/whitespace-only (envString's trim-to-empty branch)", async () => {
    const calls = stubFetch();
    await notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "1", PAGERDUTY_ROUTING_KEY: "   " });
    expect(calls).toHaveLength(0);
  });

  it("fires the Events API v2 enqueue call when enabled and configured, for a repo-scoped alert", async () => {
    const calls = stubFetch(202);
    const alert = pagerDutyAlert();

    await notifyMinerKillSwitchPagerDuty(alert, { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://events.pagerduty.com/v2/enqueue");
    const body = calls[0]?.body as { routing_key: string; event_action: string; dedup_key: string; payload: { severity: string; component: string; source: string } };
    expect(body.routing_key).toBe(VALID_ROUTING_KEY);
    expect(body.event_action).toBe("trigger");
    expect(body.dedup_key).toBe(alert.dedupKey);
    expect(body.payload.severity).toBe("critical");
    expect(body.payload.component).toBe("acme/widgets");
    expect(body.payload.source).toBe("loopover-miner");
  });

  it("a global-scope alert (no repoFullName) reports 'global' as the payload component", async () => {
    const calls = stubFetch(202);
    const alert = pagerDutyAlert({ repoFullName: null, scope: "global", dedupKey: "miner_kill_switch_tripped:global:global" });

    await notifyMinerKillSwitchPagerDuty(alert, { LOOPOVER_ENABLE_PAGERDUTY: "1", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY });

    const body = calls[0]?.body as { payload: { component: string } };
    expect(body.payload.component).toBe("global");
  });

  it("a non-ok response is warned but never throws", async () => {
    stubFetch(500);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("a thrown fetch error is caught and warned, never throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("a thrown non-Error value is coerced via String(), not read as .message", async () => {
    vi.stubGlobal("fetch", async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal -- deliberately non-Error, to exercise
      // warnMinerKillSwitchPagerDutyFailed's String(error) coercion branch (not every thrown value is an Error).
      throw "connection refused";
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(notifyMinerKillSwitchPagerDuty(pagerDutyAlert(), { LOOPOVER_ENABLE_PAGERDUTY: "true", PAGERDUTY_ROUTING_KEY: VALID_ROUTING_KEY })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [warnedJson] = warnSpy.mock.calls[0] ?? [];
    expect(String(warnedJson)).toContain("connection refused");
    warnSpy.mockRestore();
  });

  it("falls back to process.env when no env override is passed", async () => {
    const hadFlag = Object.prototype.hasOwnProperty.call(process.env, "LOOPOVER_ENABLE_PAGERDUTY");
    const previousFlag = process.env.LOOPOVER_ENABLE_PAGERDUTY;
    delete process.env.LOOPOVER_ENABLE_PAGERDUTY;
    const calls = stubFetch();

    try {
      await notifyMinerKillSwitchPagerDuty(pagerDutyAlert());
      expect(calls).toHaveLength(0);
    } finally {
      if (hadFlag) process.env.LOOPOVER_ENABLE_PAGERDUTY = previousFlag;
    }
  });
});
