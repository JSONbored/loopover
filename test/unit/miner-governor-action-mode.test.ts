// Root-level vitest coverage twin for `packages/loopover-engine/src/governor/action-mode.ts` (#8345).
//
// `action-mode.ts` (#2342) is the miner's dry-run-by-default write-execution gate — live, load-bearing, and
// fully exercised by the engine package's own `node --test` suite (`packages/loopover-engine/test/action-mode.test.ts`).
// But that runner is not part of the root vitest run Codecov reads `codecov/patch` from, so
// `resolveMinerActionMode` and its siblings report as ~0% covered despite being genuinely tested (same blind
// spot as #6250). This twin imports the primitives via the engine barrel and re-exercises every scenario the
// package suite covers — matching the sibling pattern in `test/unit/calibration-dashboard.test.ts` and
// `test/unit/miner-governor-kill-switch.test.ts`. Kill-switch state is expressed purely through the
// `MinerKillSwitchScope` string (`"none"`/`"repo"`/`"global"`), exactly as the package suite does, so no real
// kill-switch IO path is touched.
import { describe, expect, it } from "vitest";
import {
  MINER_LIVE_MODE_ENV_VAR,
  MINER_LIVE_MODE_OPT_IN,
  buildMinerDryRunGovernorLedgerEvent,
  isExplicitMinerLiveModeOptIn,
  isGlobalMinerLiveModeOptIn,
  minerActionModeExecutes,
  resolveMinerActionMode,
} from "../../packages/loopover-engine/src/index";

describe("barrel: action-mode primitives are re-exported from the engine entrypoint (#2342)", () => {
  it("exposes the functions and opt-in literals", () => {
    expect(typeof resolveMinerActionMode).toBe("function");
    expect(typeof minerActionModeExecutes).toBe("function");
    expect(typeof isExplicitMinerLiveModeOptIn).toBe("function");
    expect(typeof isGlobalMinerLiveModeOptIn).toBe("function");
    expect(typeof buildMinerDryRunGovernorLedgerEvent).toBe("function");
    expect(MINER_LIVE_MODE_OPT_IN).toBe("live");
    expect(MINER_LIVE_MODE_ENV_VAR).toBe("LOOPOVER_MINER_LIVE_MODE");
  });
});

describe("isExplicitMinerLiveModeOptIn", () => {
  it("only the exact `\"live\"` literal opts in — no truthy coercion, case-folding, or alternate spellings", () => {
    expect(isExplicitMinerLiveModeOptIn("live")).toBe(true);
    for (const value of [true, 1, "Live", "LIVE", "yes", "on", "1", "true", "", null, undefined, {}]) {
      expect(isExplicitMinerLiveModeOptIn(value)).toBe(false);
    }
  });
});

describe("isGlobalMinerLiveModeOptIn", () => {
  it("only the exact env value `\"live\"` opts in", () => {
    expect(isGlobalMinerLiveModeOptIn({ LOOPOVER_MINER_LIVE_MODE: "live" })).toBe(true);
    for (const value of [undefined, "", "1", "true", "Live", "on"]) {
      expect(isGlobalMinerLiveModeOptIn({ LOOPOVER_MINER_LIVE_MODE: value })).toBe(false);
    }
  });
});

describe("resolveMinerActionMode — 3-step precedence ladder", () => {
  it("no config anywhere defaults to dry_run, never live", () => {
    expect(
      resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: undefined, globalLiveModeOptIn: false }),
    ).toBe("dry_run");
  });

  it("malformed/partial repo opt-in values fail closed to dry_run (global false, && short-circuit)", () => {
    for (const repoLiveModeOptIn of [true, "yes", "LIVE", "", null, 1]) {
      expect(
        resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn, globalLiveModeOptIn: false }),
      ).toBe("dry_run");
    }
  });

  it("the exact repo-side opt-in alone stays dry_run without the operator opt-in (global false arm)", () => {
    expect(
      resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: "live", globalLiveModeOptIn: false }),
    ).toBe("dry_run");
  });

  it("the global operator opt-in alone stays dry_run without repo opt-in (global true, repo not explicit)", () => {
    expect(
      resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: undefined, globalLiveModeOptIn: true }),
    ).toBe("dry_run");
  });

  it("both the repo AND operator opt-ins are required for live (both && operands true)", () => {
    expect(
      resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    ).toBe("live");
  });

  it("the kill-switch always wins over any live-mode opt-in (repo and global scope both -> paused)", () => {
    expect(
      resolveMinerActionMode({ killSwitchScope: "repo", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    ).toBe("paused");
    expect(
      resolveMinerActionMode({ killSwitchScope: "global", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    ).toBe("paused");
  });
});

describe("minerActionModeExecutes", () => {
  it("is true only for live", () => {
    expect(minerActionModeExecutes("live")).toBe(true);
    expect(minerActionModeExecutes("dry_run")).toBe(false);
    expect(minerActionModeExecutes("paused")).toBe(false);
  });
});

describe("buildMinerDryRunGovernorLedgerEvent", () => {
  it("records the would-be action as an `allowed`/`dry_run` shadow row", () => {
    const event = buildMinerDryRunGovernorLedgerEvent({
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      wouldBeAction: { action: "open_pr", title: "example" },
    });
    expect(event).toEqual({
      eventType: "allowed",
      repoFullName: "acme/widgets",
      actionClass: "open_pr",
      decision: "dry_run",
      reason: "dry_run_mode_active",
      payload: { wouldBeAction: { action: "open_pr", title: "example" } },
    });
  });

  it("an omitted repoFullName normalizes to null via the `?? null` fallback", () => {
    const event = buildMinerDryRunGovernorLedgerEvent({
      actionClass: "open_pr",
      wouldBeAction: { action: "open_pr" },
    });
    expect(event.repoFullName).toBe(null);
  });
});
