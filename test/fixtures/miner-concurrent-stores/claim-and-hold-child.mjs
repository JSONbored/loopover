#!/usr/bin/env node
// Cross-process crash-recovery helper for portfolio-queue's stuck-lease sweep (#4868).
// Opens the shared queue, claims the next item via dequeueNext() (stamping a real lease), reports the
// claimed entry, then idles forever without ever marking it done -- simulating a process that claims work
// and then crashes mid-attempt. The test kills this process (SIGKILL) and asserts the item is left
// genuinely stuck 'in_progress' until swept, then reclaimable.
import { initPortfolioQueueStore } from "../../../packages/gittensory-miner/lib/portfolio-queue.js";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  process.stderr.write("usage: claim-and-hold-child.mjs <dbPath>\n");
  process.exit(2);
}

const store = initPortfolioQueueStore(dbPath);
const entry = store.dequeueNext();
// dequeueNext()'s own return shape carries no leasedAt (only listInProgress()'s lease-annotated projection
// does), and the test needs the real stamped lease time to compute expiry windows against.
const lease = entry
  ? store.listInProgress().find((row) => row.repoFullName === entry.repoFullName && row.identifier === entry.identifier)
  : null;
process.stdout.write(`CLAIMED ${JSON.stringify({ ...entry, leasedAt: lease?.leasedAt ?? null })}\n`);

// Idle forever -- never mark done, never close the store, never exit on its own. The test's SIGKILL is
// the only thing that ends this process, mirroring a real crash (no cleanup handler runs).
setInterval(() => {}, 1_000_000);
