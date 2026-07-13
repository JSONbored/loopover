import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { listDiscoveredRankedCandidates } from "../../packages/gittensory-miner/lib/discovered-candidates.js";
import { initEventLedger, type EventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";

function discovered(repoFullName: unknown, payload: unknown) {
  return { type: "discovered_issue", repoFullName, payload };
}

// The reader only ever calls `readEvents`/`close`, so the stand-in implements just those (the reader's option is
// cast to the full ledger type). `closed`/`calls` expose what was invoked so ownership + repo-filter threading can
// be asserted without SQLite; `readEvents` returns deliberately loose data so the malformed-event cases can feed
// entries a real ledger's typed API would reject.
type FakeLedger = EventLedger & { readonly closed: boolean; readonly calls: Array<{ repoFullName: unknown }> };

function fakeLedger(events: unknown[]): FakeLedger {
  const calls: Array<{ repoFullName: unknown }> = [];
  let closed = false;
  return {
    readEvents(filter: { repoFullName: unknown }) {
      calls.push(filter);
      return events;
    },
    close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
    get calls() {
      return calls;
    },
  } as unknown as FakeLedger;
}

describe("listDiscoveredRankedCandidates (#4859)", () => {
  it("returns the latest ranked candidate per issue, newest write wins, sorted by rankScore descending", () => {
    const ledger = fakeLedger([
      discovered("acme/widgets", { issueNumber: 7, rankScore: 0.2, title: "Old score", labels: ["a"] }),
      discovered("acme/widgets", { issueNumber: 7, rankScore: 0.9, title: "Re-ranked", labels: ["a", "b"] }),
      discovered("acme/widgets", { issueNumber: 12, rankScore: 0.5, title: "Second", labels: [] }),
    ]);

    const result = listDiscoveredRankedCandidates({ eventLedger: ledger });

    expect(result).toEqual([
      { repoFullName: "acme/widgets", issueNumber: 7, title: "Re-ranked", labels: ["a", "b"], rankScore: 0.9 },
      { repoFullName: "acme/widgets", issueNumber: 12, title: "Second", labels: [], rankScore: 0.5 },
    ]);
  });

  it("uses an injected open ledger without closing it and reads unscoped when no repo filter is passed", () => {
    const ledger = fakeLedger([]);
    listDiscoveredRankedCandidates({ eventLedger: ledger });
    expect(ledger.closed).toBe(false);
    expect(ledger.calls).toEqual([{ repoFullName: null }]);
  });

  it("opens (via the injected opener) and closes its own ledger, threading the repo filter through", () => {
    const ledger = fakeLedger([discovered("acme/widgets", { issueNumber: 3, rankScore: 0.7, title: "Scoped" })]);
    const result = listDiscoveredRankedCandidates({
      initEventLedger: () => ledger,
      repoFullName: "acme/widgets",
    });
    expect(result).toHaveLength(1);
    expect(ledger.closed).toBe(true);
    expect(ledger.calls).toEqual([{ repoFullName: "acme/widgets" }]);
  });

  it("keeps a candidate whose title is absent, defaulting title to '' and labels to []", () => {
    const ledger = fakeLedger([discovered("acme/widgets", { issueNumber: 4, rankScore: 0.3 })]);
    const result = listDiscoveredRankedCandidates({ eventLedger: ledger });
    expect(result).toEqual([
      { repoFullName: "acme/widgets", issueNumber: 4, title: "", labels: [], rankScore: 0.3 },
    ]);
  });

  it("filters non-string/blank labels while keeping valid ones", () => {
    const ledger = fakeLedger([
      discovered("acme/widgets", { issueNumber: 5, rankScore: 0.4, title: "T", labels: ["keep", "  ", 3, null, " trim "] }),
    ]);
    const [candidate] = listDiscoveredRankedCandidates({ eventLedger: ledger });
    expect(candidate?.labels).toEqual(["keep", "trim"]);
  });

  it("ignores non-discovered_issue events and nullish ledger entries", () => {
    const ledger = fakeLedger([
      null,
      { type: "plan_built", repoFullName: "acme/widgets", payload: { issueNumber: 1, rankScore: 0.9 } },
      discovered("acme/widgets", { issueNumber: 2, rankScore: 0.6, title: "Only this one" }),
    ]);
    const result = listDiscoveredRankedCandidates({ eventLedger: ledger });
    expect(result).toEqual([
      { repoFullName: "acme/widgets", issueNumber: 2, title: "Only this one", labels: [], rankScore: 0.6 },
    ]);
  });

  it("drops every malformed discovered_issue event", () => {
    const ledger = fakeLedger([
      discovered("acme/widgets", null), // payload not an object
      discovered("acme/widgets", "nope"), // payload not an object (non-null)
      discovered(42, { issueNumber: 1, rankScore: 0.5, title: "T" }), // repoFullName not a string
      discovered("", { issueNumber: 1, rankScore: 0.5, title: "T" }), // repoFullName has no owner
      discovered("owner", { issueNumber: 1, rankScore: 0.5, title: "T" }), // repoFullName has no repo
      discovered("a/b/c", { issueNumber: 1, rankScore: 0.5, title: "T" }), // repoFullName has an extra segment
      discovered("acme/widgets", { issueNumber: 1.5, rankScore: 0.5, title: "T" }), // issueNumber not an integer
      discovered("acme/widgets", { issueNumber: 0, rankScore: 0.5, title: "T" }), // issueNumber not positive
      discovered("acme/widgets", { issueNumber: 1, rankScore: "high", title: "T" }), // rankScore not a number
      discovered("acme/widgets", { issueNumber: 1, rankScore: Number.POSITIVE_INFINITY, title: "T" }), // not finite
      discovered("acme/widgets", { issueNumber: 1, rankScore: -0.1, title: "T" }), // rankScore negative
    ]);
    expect(listDiscoveredRankedCandidates({ eventLedger: ledger })).toEqual([]);
  });

  it("tie-breaks equal rankScore by repoFullName then issueNumber for a stable order", () => {
    const ledger = fakeLedger([
      discovered("acme/beta", { issueNumber: 9, rankScore: 0.5, title: "B9" }),
      discovered("acme/beta", { issueNumber: 2, rankScore: 0.5, title: "B2" }),
      discovered("acme/alpha", { issueNumber: 4, rankScore: 0.5, title: "A4" }),
    ]);
    const result = listDiscoveredRankedCandidates({ eventLedger: ledger });
    expect(result.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`)).toEqual([
      "acme/alpha#4",
      "acme/beta#2",
      "acme/beta#9",
    ]);
  });
});

describe("listDiscoveredRankedCandidates against a real event ledger (#4859)", () => {
  const roots: string[] = [];
  const previousEnv = process.env.GITTENSORY_MINER_EVENT_LEDGER_DB;

  afterEach(() => {
    if (previousEnv === undefined) delete process.env.GITTENSORY_MINER_EVENT_LEDGER_DB;
    else process.env.GITTENSORY_MINER_EVENT_LEDGER_DB = previousEnv;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempLedgerPath() {
    const root = mkdtempSync(join(tmpdir(), "gittensory-miner-discovered-candidates-"));
    roots.push(root);
    return join(root, "event-ledger.sqlite3");
  }

  it("opens and closes its OWN default ledger, reading back what discover persisted", () => {
    const dbPath = tempLedgerPath();
    process.env.GITTENSORY_MINER_EVENT_LEDGER_DB = dbPath;
    const writer = initEventLedger(dbPath);
    writer.appendEvent({
      type: "discovered_issue",
      repoFullName: "JSONbored/gittensory",
      payload: { issueNumber: 4859, rankScore: 0.88, title: "Live fetch", labels: ["help wanted"] },
    });
    writer.appendEvent({ type: "plan_built", repoFullName: "JSONbored/gittensory", payload: { issueNumber: 4859 } });
    writer.close();

    // No options at all: exercises the module's default `initEventLedger()` open (env-resolved path) + its close.
    const result = listDiscoveredRankedCandidates();
    expect(result).toEqual([
      { repoFullName: "JSONbored/gittensory", issueNumber: 4859, title: "Live fetch", labels: ["help wanted"], rankScore: 0.88 },
    ]);
  });
});
