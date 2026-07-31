// Read-only grounding tools for the maintainer chat surface (#9189, epic #9183, spec #9187).
//
// GROUNDING, NOT GENERATION. Every tool here returns deterministic JSON read from state ORB already holds.
// The model consumes these results; it never produces the numbers itself. That split is the whole design:
// a maintainer asking "why is this PR held" gets the recorded verdict, not a paraphrase of one.
//
// ── READ-ONLY IS ENFORCED BY CONSTRUCTION, NOT PROMISED ──────────────────────────────────────────────
// {@link GroundingServices} is the ENTIRE capability surface these tools have, and it contains no Octokit,
// no token, and no write function of any kind. A tool cannot perform a GitHub write because there is nothing
// in scope to write with -- rather than because a reviewer checked that it doesn't. The invariant test
// asserts the shape of this interface, so adding a write capability fails a test rather than passing review.
//
// ── REDACTION IS STRUCTURAL ──────────────────────────────────────────────────────────────────────────
// Every response is built by NAMING its fields, never by filtering a wider object. A blocklist has to
// anticipate every field an upstream type might grow and silently leaks the one it did not; an allowlisted
// shape cannot leak a field nobody wrote down. Wallet, hotkey, reward, private-ranking and raw-trust values
// are therefore unreachable here by construction, not by vigilance.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────────────────────────────
// Identical state must produce identical bytes, so a model is not re-grounded differently on a retry and a
// cache is meaningful. Every list is sorted on a stable key before it is returned; nothing relies on the
// order a query happened to yield.

/**
 * The complete capability surface of the grounding tools.
 *
 * DELIBERATELY NARROW. Each member is an existing service, injected so the registry is testable without a
 * database and so the read-only property is visible in one place rather than argued about per tool. Note
 * what is absent: no Octokit, no installation token, no mutation of any kind.
 */
export type GroundingServices = {
  queueSnapshot: (repoFullName: string) => Promise<{ pending: number; processing: number } | null>;
  ledgerVerify: () => Promise<{ ok: boolean; tipSeq: number; totalCount: number } | null>;
  proofSummary: (repoFullName: string) => Promise<GroundingProofSummary | null>;
  effectiveConfig: (repoFullName: string) => Promise<{ present: boolean; source: string; fields: string[] } | null>;
  repoSettings: (repoFullName: string) => Promise<{ gatePack: string | null; autonomy: Record<string, string> } | null>;
  prStatus: (repoFullName: string, pullNumber: number) => Promise<GroundingPrStatus | null>;
};

/** The subset of the proof summary chat surfaces. Accuracy NEVER travels without its coverage and interval
 *  -- requirement 6, and the same rule `buildProofSummary` already enforces for the public proof page. */
export type GroundingProofSummary = {
  decisionCount: number;
  accuracy:
    | { state: "published"; accuracy: number; decided: number; confirmed: number; interval: { lo: number; hi: number } }
    | { state: "insufficient_data"; decided: number; minimumDecisions: number };
  ledgerState: string;
  anchorState: string;
};

export type GroundingPrStatus = {
  pullNumber: number;
  action: string | null;
  reasonCode: string | null;
  holdCause: string[];
  ciState: string | null;
  recordDigest: string | null;
};

/** A tool result. `budgetTokens` is the tool's declared ceiling, carried on the result so a caller can
 *  enforce it without a second table mapping names to budgets. */
export type GroundingResult = { tool: string; budgetTokens: number; data: unknown };

export type GroundingTool = {
  name: string;
  /** Response ceiling. Declared per tool because the shapes differ by an order of magnitude, and a single
   *  global budget would either truncate the queue snapshot or waste the ledger check. */
  budgetTokens: number;
  /** Whether the tool needs a pull number. Declared rather than inferred from the args, so a caller can
   *  present the catalog without invoking anything. */
  needsPullNumber: boolean;
  run: (services: GroundingServices, repoFullName: string, pullNumber: number | null) => Promise<unknown>;
};

/** PURE. Stable ordering for any string list a tool returns. Sorting on the value itself (rather than
 *  leaving query order) is what makes two identical calls byte-identical. */
export function stableStrings(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/**
 * The v1 catalog: six tools, each wrapping a service that already exists.
 *
 * `decision_record_by_digest` and `audit_tail` from the spec's candidate set are deliberately ABSENT -- see
 * the note on #9189. Neither has a reader today (`loadDecisionRecordCollapsible` is by pull number and the
 * public ledger row endpoint is by sequence), so shipping them here would mean inventing a query inside a
 * chat PR, which is exactly what requirement 1 rules out. They are filed separately so each new read gets
 * its own authz and redaction review.
 */
export const GROUNDING_TOOLS: readonly GroundingTool[] = [
  {
    name: "queue_snapshot",
    budgetTokens: 2000,
    needsPullNumber: false,
    run: async (services, repoFullName) => {
      const snapshot = await services.queueSnapshot(repoFullName);
      return snapshot === null ? { available: false } : { available: true, pending: snapshot.pending, processing: snapshot.processing };
    },
  },
  {
    name: "ledger_verify",
    budgetTokens: 500,
    needsPullNumber: false,
    run: async (services) => {
      const verified = await services.ledgerVerify();
      // `available: false` rather than an error: a deployment with no ledger is not a broken one, and the
      // model must not narrate an outage from a surface that simply is not present here.
      return verified === null ? { available: false } : { available: true, ok: verified.ok, tipSeq: verified.tipSeq, totalCount: verified.totalCount };
    },
  },
  {
    name: "fairness_summary",
    budgetTokens: 1500,
    needsPullNumber: false,
    run: async (services, repoFullName) => {
      const summary = await services.proofSummary(repoFullName);
      if (summary === null) return { available: false };
      // Copied field by field, and the accuracy union is passed through WHOLE. Flattening it to a bare
      // number here would strip the coverage and interval that make it a claim rather than marketing --
      // requirement 6, and the reason this reuses buildProofSummary instead of aggregating again.
      return {
        available: true,
        decisionCount: summary.decisionCount,
        accuracy: summary.accuracy,
        ledgerState: summary.ledgerState,
        anchorState: summary.anchorState,
      };
    },
  },
  {
    name: "effective_config",
    budgetTokens: 2000,
    needsPullNumber: false,
    run: async (services, repoFullName) => {
      const config = await services.effectiveConfig(repoFullName);
      // Field NAMES only, never values. Which fields an operator set is the useful grounding; the values
      // are the operator's configuration and have no business being narrated by a model.
      return config === null ? { available: false } : { available: true, present: config.present, source: config.source, fields: stableStrings(config.fields) };
    },
  },
  {
    name: "repo_settings",
    budgetTokens: 1000,
    needsPullNumber: false,
    run: async (services, repoFullName) => {
      const settings = await services.repoSettings(repoFullName);
      if (settings === null) return { available: false };
      const autonomy = Object.fromEntries(stableStrings(Object.keys(settings.autonomy)).map((key) => [key, settings.autonomy[key]!]));
      return { available: true, gatePack: settings.gatePack, autonomy };
    },
  },
  {
    name: "pr_status",
    budgetTokens: 1000,
    needsPullNumber: true,
    run: async (services, repoFullName, pullNumber) => {
      if (pullNumber === null) return { available: false, reason: "pull_number_required" };
      const status = await services.prStatus(repoFullName, pullNumber);
      if (status === null) return { available: false };
      return {
        available: true,
        pullNumber: status.pullNumber,
        action: status.action,
        reasonCode: status.reasonCode,
        // #9991: WHY it was held, now that the ledger records it. Sorted for determinism.
        holdCause: stableStrings(status.holdCause),
        ciState: status.ciState,
        recordDigest: status.recordDigest,
      };
    },
  },
];

/** PURE. The catalog, for a caller that wants to present the tools without invoking one. Sorted by name so
 *  the advertised catalog is stable across processes. */
export function groundingToolCatalog(): { name: string; budgetTokens: number; needsPullNumber: boolean }[] {
  return [...GROUNDING_TOOLS]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({ name: tool.name, budgetTokens: tool.budgetTokens, needsPullNumber: tool.needsPullNumber }));
}

/** Run one tool by name. Returns null for an unknown name so the caller decides the status code, rather than
 *  this module inventing an HTTP concern. */
export async function runGroundingTool(
  name: string,
  services: GroundingServices,
  repoFullName: string,
  pullNumber: number | null = null,
): Promise<GroundingResult | null> {
  const tool = GROUNDING_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return null;
  return { tool: tool.name, budgetTokens: tool.budgetTokens, data: await tool.run(services, repoFullName, pullNumber) };
}
