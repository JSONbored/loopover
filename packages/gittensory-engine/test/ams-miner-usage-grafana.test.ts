import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AMS_MINER_USAGE_PROVIDER_NAMES,
  buildAmsMinerUsageProviderSqlFilter,
  buildAmsMinerUsageProviderWhereClause,
  isAmsMinerUsageProviderName,
  resolveAmsMinerUsageProviderFilter,
} from "../dist/miner/ams-miner-usage-grafana.js";

test("AMS_MINER_USAGE_PROVIDER_NAMES lists the three coding-agent drivers", () => {
  assert.deepEqual(AMS_MINER_USAGE_PROVIDER_NAMES, ["claude-cli", "codex-cli", "agent-sdk"]);
});

test("resolveAmsMinerUsageProviderFilter treats $__all and empty as show-all", () => {
  assert.deepEqual(resolveAmsMinerUsageProviderFilter("$__all"), { mode: "all" });
  assert.deepEqual(resolveAmsMinerUsageProviderFilter(""), { mode: "all" });
  assert.deepEqual(resolveAmsMinerUsageProviderFilter(null), { mode: "all" });
  assert.deepEqual(resolveAmsMinerUsageProviderFilter(undefined), { mode: "all" });
});

test("resolveAmsMinerUsageProviderFilter accepts known providers", () => {
  assert.deepEqual(resolveAmsMinerUsageProviderFilter("claude-cli"), { mode: "one", provider: "claude-cli" });
  assert.equal(isAmsMinerUsageProviderName("agent-sdk"), true);
});

test("resolveAmsMinerUsageProviderFilter rejects unknown providers instead of merging all rows", () => {
  assert.deepEqual(resolveAmsMinerUsageProviderFilter("mystery"), { mode: "invalid" });
  assert.equal(buildAmsMinerUsageProviderWhereClause("mystery"), "1=0");
});

test("buildAmsMinerUsageProviderWhereClause scopes a single provider", () => {
  assert.equal(buildAmsMinerUsageProviderWhereClause("codex-cli"), "driver_provider = 'codex-cli'");
});

test("buildAmsMinerUsageProviderSqlFilter matches Grafana template syntax", () => {
  assert.equal(
    buildAmsMinerUsageProviderSqlFilter(),
    "(${provider:sqlstring} = '$__all' OR driver_provider = ${provider:sqlstring})",
  );
});
