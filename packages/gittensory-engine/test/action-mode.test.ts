import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MINER_LIVE_MODE_ENV_VAR,
  MINER_LIVE_MODE_OPT_IN,
  buildMinerDryRunGovernorLedgerEvent,
  isExplicitMinerLiveModeOptIn,
  isGlobalMinerLiveModeOptIn,
  minerActionModeExecutes,
  resolveMinerActionMode,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports the action-mode primitive (#2342)", () => {
  assert.equal(typeof resolveMinerActionMode, "function");
  assert.equal(typeof minerActionModeExecutes, "function");
  assert.equal(typeof isExplicitMinerLiveModeOptIn, "function");
  assert.equal(typeof isGlobalMinerLiveModeOptIn, "function");
  assert.equal(typeof buildMinerDryRunGovernorLedgerEvent, "function");
  assert.equal(MINER_LIVE_MODE_OPT_IN, "live");
  assert.equal(MINER_LIVE_MODE_ENV_VAR, "LOOPOVER_MINER_LIVE_MODE");
});

test("isExplicitMinerLiveModeOptIn: only the exact literal opts in, no truthy coercion", () => {
  assert.equal(isExplicitMinerLiveModeOptIn("live"), true);
  for (const value of [true, 1, "Live", "LIVE", "yes", "on", "1", "true", "", null, undefined, {}]) {
    assert.equal(isExplicitMinerLiveModeOptIn(value), false, `expected ${JSON.stringify(value)} not to opt in`);
  }
});

test("isGlobalMinerLiveModeOptIn: only the exact env value opts in", () => {
  assert.equal(isGlobalMinerLiveModeOptIn({ LOOPOVER_MINER_LIVE_MODE: "live" }), true);
  for (const value of [undefined, "", "1", "true", "Live", "on"]) {
    assert.equal(isGlobalMinerLiveModeOptIn({ LOOPOVER_MINER_LIVE_MODE: value }), false);
  }
});

test("resolveMinerActionMode: no config anywhere defaults to dry_run, never live", () => {
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: undefined, globalLiveModeOptIn: false }),
    "dry_run",
  );
});

test("resolveMinerActionMode: malformed/partial opt-in values fail closed to dry_run", () => {
  for (const repoLiveModeOptIn of [true, "yes", "LIVE", "", null, 1]) {
    assert.equal(
      resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn, globalLiveModeOptIn: false }),
      "dry_run",
      `expected ${JSON.stringify(repoLiveModeOptIn)} to stay dry_run`,
    );
  }
});

test("resolveMinerActionMode: the exact repo-side opt-in alone stays dry_run without operator opt-in", () => {
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: "live", globalLiveModeOptIn: false }),
    "dry_run",
  );
});

test("resolveMinerActionMode: the global operator opt-in alone also stays dry_run without repo opt-in", () => {
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: undefined, globalLiveModeOptIn: true }),
    "dry_run",
  );
});

test("resolveMinerActionMode: both repo and operator opt-ins are required for live", () => {
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "none", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    "live",
  );
});

test("resolveMinerActionMode: the kill-switch always wins over any live-mode opt-in", () => {
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "repo", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    "paused",
  );
  assert.equal(
    resolveMinerActionMode({ killSwitchScope: "global", repoLiveModeOptIn: "live", globalLiveModeOptIn: true }),
    "paused",
  );
});

test("minerActionModeExecutes: true only for live", () => {
  assert.equal(minerActionModeExecutes("live"), true);
  assert.equal(minerActionModeExecutes("dry_run"), false);
  assert.equal(minerActionModeExecutes("paused"), false);
});

test("buildMinerDryRunGovernorLedgerEvent: records the would-be action without eventType denied/throttled", () => {
  const event = buildMinerDryRunGovernorLedgerEvent({
    repoFullName: "acme/widgets",
    actionClass: "open_pr",
    wouldBeAction: { action: "open_pr", title: "example" },
  });
  assert.deepEqual(event, {
    eventType: "allowed",
    repoFullName: "acme/widgets",
    actionClass: "open_pr",
    decision: "dry_run",
    reason: "dry_run_mode_active",
    payload: { wouldBeAction: { action: "open_pr", title: "example" } },
  });
});

test("buildMinerDryRunGovernorLedgerEvent: an omitted repoFullName normalizes to null", () => {
  const event = buildMinerDryRunGovernorLedgerEvent({
    actionClass: "open_pr",
    wouldBeAction: { action: "open_pr" },
  });
  assert.equal(event.repoFullName, null);
});
