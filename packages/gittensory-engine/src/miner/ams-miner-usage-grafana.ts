// Grafana SQL helpers for the AMS miner-usage dashboard (#5185). The dashboard JSON itself lives under
// grafana/dashboards/, but provider-filter semantics are centralized here so unit tests can assert the
// fail-closed behavior required when an operator selects an unknown provider.

/** Coding-agent providers the miner-usage dashboard is scoped to (excludes `noop`). */
export const AMS_MINER_USAGE_PROVIDER_NAMES = Object.freeze(["claude-cli", "codex-cli", "agent-sdk"] as const);

export type AmsMinerUsageProviderName = (typeof AMS_MINER_USAGE_PROVIDER_NAMES)[number];

const providerNameSet = new Set<string>(AMS_MINER_USAGE_PROVIDER_NAMES);

export function isAmsMinerUsageProviderName(value: string): value is AmsMinerUsageProviderName {
  return providerNameSet.has(value);
}

export type AmsMinerUsageProviderFilter =
  | { mode: "all" }
  | { mode: "one"; provider: AmsMinerUsageProviderName }
  | { mode: "invalid" };

/** Classify a concrete provider selection (tests / programmatic query builders). Grafana's own `$__all`
 *  sentinel and an empty selection mean "show every provider"; anything else must match the bounded list. */
export function resolveAmsMinerUsageProviderFilter(
  selected: string | null | undefined,
): AmsMinerUsageProviderFilter {
  if (selected === undefined || selected === null || selected === "" || selected === "$__all") {
    return { mode: "all" };
  }
  if (isAmsMinerUsageProviderName(selected)) {
    return { mode: "one", provider: selected };
  }
  return { mode: "invalid" };
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Grafana template-variable filter for the redacted `driver_provider` column. */
export function buildAmsMinerUsageProviderSqlFilter(providerVariable = "provider"): string {
  return `(\${${providerVariable}:sqlstring} = '$__all' OR driver_provider = \${${providerVariable}:sqlstring})`;
}

/** Concrete WHERE fragment for direct sqlite3 CLI runs in tests (not Grafana macro syntax). */
export function buildAmsMinerUsageProviderWhereClause(selected: string | null | undefined): string {
  const resolved = resolveAmsMinerUsageProviderFilter(selected);
  if (resolved.mode === "all") return "1=1";
  if (resolved.mode === "one") return `driver_provider = ${sqlStringLiteral(resolved.provider)}`;
  return "1=0";
}
