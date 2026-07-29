// The real store operations behind the miner's mutating MCP tools (#9523).
//
// These are what `chat-miner-ops-actions.ts`'s governor-gated handlers ultimately call. They live apart from
// that registration module for one reason: registration is the SAFETY boundary and must stay readable as
// such, while this is the plumbing. Neither the MCP layer nor this module can bypass the gate -- the MCP
// layer dispatches an action name, and the gate sits between that name and these functions.
//
// Every operation opens the store it needs, does one thing, and closes it. That mirrors how the miner MCP's
// read tools already treat their stores: the process is a CLI, not a daemon holding handles open.
import { initPortfolioQueueStore } from "./portfolio-queue.js";
import { openClaimLedger } from "./claim-ledger.js";
import { initDenyHookSynthesisStore } from "./deny-hook-synthesis.js";
import { runMigrateChecks } from "./migrate-cli.js";
import { purgeRepoAcrossStores } from "./purge-cli.js";
import type { MinerOpsActions } from "./chat-miner-ops-actions.js";

/** The queue keys items by a string identifier; an issue number is its canonical form here. */
function queueIdentifier(issueNumber: number): string {
  return String(issueNumber);
}

/**
 * The default operations, wired to the real on-disk stores.
 *
 * Every seam is overridable so a test can drive the whole dispatch path -- MCP tool through governor gate
 * through action -- without touching disk.
 */
export function createMinerOpsActions(
  deps: {
    initPortfolioQueue?: typeof initPortfolioQueueStore;
    openClaims?: typeof openClaimLedger;
    openDenyHooks?: typeof initDenyHookSynthesisStore;
    migrate?: typeof runMigrateChecks;
    purge?: typeof purgeRepoAcrossStores;
  } = {},
): MinerOpsActions {
  const openQueue = deps.initPortfolioQueue ?? initPortfolioQueueStore;
  const openClaims = deps.openClaims ?? openClaimLedger;
  const openDenyHooks = deps.openDenyHooks ?? initDenyHookSynthesisStore;
  const migrate = deps.migrate ?? runMigrateChecks;
  const purge = deps.purge ?? purgeRepoAcrossStores;

  return {
    releaseQueueItem({ repoFullName, issueNumber }) {
      const queue = openQueue();
      try {
        // "Release" a claimed item = return it to the pool, which is what reclaimStuckItem does for a lease
        // the miner still holds. Same call the dashboard's release action makes.
        const entry = queue.reclaimStuckItem(repoFullName, queueIdentifier(issueNumber));
        return { released: entry !== null, entry };
      } finally {
        queue.close();
      }
    },

    requeueQueueItem({ repoFullName, issueNumber }) {
      const queue = openQueue();
      try {
        const entry = queue.requeueItem(repoFullName, queueIdentifier(issueNumber));
        return { requeued: entry !== null, entry };
      } finally {
        queue.close();
      }
    },

    releaseClaim({ repoFullName, issueNumber }) {
      const claims = openClaims();
      try {
        const entry = claims.releaseClaim(repoFullName, issueNumber);
        return { released: entry !== null, entry };
      } finally {
        claims.close();
      }
    },

    decideDenyHook({ repoFullName, hookId, decision }) {
      const store = openDenyHooks();
      try {
        const proposal = store.listProposals(repoFullName).find((entry) => entry.id === hookId);
        if (!proposal) return { decided: false, notFound: true, hookId };
        const status = decision === "approve" ? "approved" : "rejected";
        store.setProposalStatus(repoFullName, hookId, status);
        return { decided: true, hookId, status };
      } finally {
        store.close();
      }
    },

    runMigrations() {
      // The SAME core the `migrate` CLI drives (existing stores only; it never creates one). Opening a store
      // is what applies its migrations, which is why there is no dry-run half to offer.
      const stores = migrate();
      return { ok: stores.every((store) => store.ok), stores };
    },

    purgeRepo({ repoFullName }) {
      return purge(repoFullName);
    },
  };
}
