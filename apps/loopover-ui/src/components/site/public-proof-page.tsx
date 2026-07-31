import { useQuery } from "@tanstack/react-query";

import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { Card, Section } from "@/components/site/primitives";
import { StateBoundary } from "@/components/site/state-views";
import { Skeleton } from "@/components/ui/skeleton";

// #9569: the public, shareable twin of the in-app trust panel.
//
// This component RENDERS; it computes nothing. Every figure comes from `/v1/public/repos/:owner/:repo/proof`,
// which is built by `buildProofSummary` -- the same composition the in-app panel reads. A percentage derived
// here would be a second implementation free to disagree with the first, which would undermine the exact
// property the page exists to demonstrate. The only arithmetic below is multiplying an already-computed rate
// by 100 for display.
//
// NEVER A BARE SCALAR. The accuracy figure is only ever shown with its denominator and its Wilson interval,
// because that is the difference between a claim someone can argue with and marketing. Below the sample floor
// the API sends `insufficient_data` WITH the decision count, and this renders exactly that -- "7 decisions,
// too few to claim a rate" -- rather than hiding the count along with the figure or printing a 0%.
//
// BOUNDARY STATES ARE NEUTRAL, NOT ERRORS. A repo that has not been anchored yet, or whose ledger is empty,
// is not a failing repo. Rendering either as an error would be lying in the more damaging direction, so they
// get their own neutral treatment and only a genuinely BROKEN ledger is styled as a problem.

export type ProofAccuracy =
  | {
      state: "published";
      accuracy: number;
      decided: number;
      confirmed: number;
      interval: { lo: number; hi: number };
    }
  | { state: "insufficient_data"; decided: number; minimumDecisions: number };

export type ProofLedgerStatus =
  | { state: "verified"; tipSeq: number; totalCount: number; checkedAt: string }
  | {
      state: "broken";
      tipSeq: number;
      totalCount: number;
      checkedAt: string;
      brokenAtSeq: number;
      brokenKind: string;
    }
  | { state: "empty"; checkedAt: string }
  | { state: "unavailable"; checkedAt: string };

export type ProofAnchorStatus =
  | { state: "anchored"; backend: string; seq: number; rowHash: string; at: string }
  | { state: "not_yet_anchored" };

export type ProofSampleRecord = {
  pullNumber: number;
  action: string;
  reasonCode: string;
  decidedAt: string;
  recordDigest: string;
};

export type ProofSummary = {
  schemaVersion: 1;
  repoFullName: string;
  decisionCount: number;
  accuracy: ProofAccuracy;
  ledger: ProofLedgerStatus;
  anchor: ProofAnchorStatus;
  sampleRecords: ProofSampleRecord[];
  boundary: string;
};

const pctFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });
const countFmt = new Intl.NumberFormat("en");
const asPct = (rate: number): string => `${pctFmt.format(rate * 100)}%`;

/** A digest is 64 hex characters. Shown head-and-tail so it stays recognisable at a glance while remaining
 *  copyable in full from the title attribute — a truncated digest with no way back to the whole value cannot
 *  be checked against anything. */
function shortDigest(digest: string): string {
  return digest.length <= 20 ? digest : `${digest.slice(0, 10)}…${digest.slice(-6)}`;
}

async function fetchProofSummary(owner: string, repo: string): Promise<ProofSummary | null> {
  const result = await apiFetch<ProofSummary>(
    `${getApiOrigin()}/v1/public/repos/${owner}/${repo}/proof`,
    {
      label: "Public proof summary",
      timeoutMs: 8000,
      silentStatus: true,
    },
  );
  // Same distinction the sibling quality page draws (#6821): a transport/HTTP failure must reach ErrorState
  // with a retry, while a successful 404 -- the repo has not opted in, or the surface is off -- is an
  // EmptyState. Collapsing the two would tell an opted-out repo that something is broken.
  if (!result.ok) {
    if (result.status === 404) return null;
    throw new Error(result.message || "Proof summary unavailable");
  }
  return result.data ?? null;
}

function LedgerCard({ ledger }: { ledger: ProofLedgerStatus }): React.JSX.Element {
  if (ledger.state === "verified") {
    return (
      <Card>
        <h3 className="text-token-sm font-medium">Ledger verified</h3>
        <p className="text-muted-foreground mt-1 text-token-sm">
          The hash chain recomputed cleanly over all {countFmt.format(ledger.totalCount)} rows, to
          sequence {countFmt.format(ledger.tipSeq)}.
        </p>
        <p className="text-muted-foreground mt-2 text-token-xs">
          Checked {new Date(ledger.checkedAt).toLocaleString()}
        </p>
      </Card>
    );
  }
  if (ledger.state === "broken") {
    // The one state that IS a problem, and it is stated rather than softened -- including which row and what
    // kind of break, because the kind is the actionable half.
    return (
      <Card>
        <h3 className="text-destructive text-token-sm font-medium">Ledger verification failed</h3>
        <p className="text-muted-foreground mt-1 text-token-sm">
          The chain broke at sequence {countFmt.format(ledger.brokenAtSeq)} of{" "}
          {countFmt.format(ledger.totalCount)} ({ledger.brokenKind}).
        </p>
        <p className="text-muted-foreground mt-2 text-token-xs">
          Checked {new Date(ledger.checkedAt).toLocaleString()}
        </p>
      </Card>
    );
  }
  if (ledger.state === "empty") {
    return (
      <Card>
        <h3 className="text-token-sm font-medium">No decisions recorded yet</h3>
        <p className="text-muted-foreground mt-1 text-token-sm">
          The ledger for this repository is empty. That is a new repository, not a failing one.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <h3 className="text-token-sm font-medium">Ledger state unavailable</h3>
      <p className="text-muted-foreground mt-1 text-token-sm">
        The verification could not be run just now. This says nothing about the ledger itself — it
        is not a claim that anything is wrong.
      </p>
    </Card>
  );
}

function AccuracyCard({ accuracy }: { accuracy: ProofAccuracy }): React.JSX.Element {
  if (accuracy.state === "insufficient_data") {
    return (
      <Card>
        <h3 className="text-token-sm font-medium">Accuracy</h3>
        <p className="text-muted-foreground mt-1 text-token-sm">
          {countFmt.format(accuracy.decided)} decision{accuracy.decided === 1 ? "" : "s"} so far —
          fewer than the {countFmt.format(accuracy.minimumDecisions)} needed to publish a rate. A
          percentage over this few would be noise wearing a number&apos;s clothes.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <h3 className="text-token-sm font-medium">Accuracy</h3>
      <p className="mt-1 text-token-2xl font-semibold tabular-nums">{asPct(accuracy.accuracy)}</p>
      <p className="text-muted-foreground mt-1 text-token-sm">
        {countFmt.format(accuracy.confirmed)} of {countFmt.format(accuracy.decided)} decisions
        confirmed by what actually happened. 95% interval {asPct(accuracy.interval.lo)}–
        {asPct(accuracy.interval.hi)}.
      </p>
    </Card>
  );
}

function AnchorCard({ anchor }: { anchor: ProofAnchorStatus }): React.JSX.Element {
  if (anchor.state === "not_yet_anchored") {
    return (
      <Card>
        <h3 className="text-token-sm font-medium">Not yet anchored</h3>
        <p className="text-muted-foreground mt-1 text-token-sm">
          No external anchor has been published for this ledger yet. The chain is still
          self-verifying; an anchor adds third-party evidence of when it existed.
        </p>
      </Card>
    );
  }
  return (
    <Card>
      <h3 className="text-token-sm font-medium">Externally anchored</h3>
      <p className="text-muted-foreground mt-1 text-token-sm">
        Sequence {countFmt.format(anchor.seq)} anchored to {anchor.backend} on{" "}
        {new Date(anchor.at).toLocaleDateString()}.
      </p>
      <p
        className="text-muted-foreground mt-2 font-mono text-token-xs break-all"
        title={anchor.rowHash}
      >
        {shortDigest(anchor.rowHash)}
      </p>
    </Card>
  );
}

/** Content-shaped placeholder matching the card grid, so the page does not jump once data arrives. */
function ProofSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-28 w-full" />
      ))}
    </div>
  );
}

export function PublicProofPage({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["public-proof", owner, repo],
    queryFn: () => fetchProofSummary(owner, repo),
  });

  return (
    <Section className="max-w-4xl">
      <header className="mb-8 space-y-2">
        <p className="text-muted-foreground text-token-xs tracking-wide uppercase">Review proof</p>
        <h1 className="text-token-2xl font-semibold">
          {owner}/{repo}
        </h1>
        <p className="text-muted-foreground text-token-sm">
          Every figure here is read from a public endpoint and can be re-derived independently.
          Nothing on this page is asserted without a source.
        </p>
      </header>
      <StateBoundary
        isLoading={query.isLoading}
        isError={query.isError}
        isEmpty={!query.isLoading && !query.isError && query.data === null}
        onRetry={() => void query.refetch()}
        loadingSkeleton={<ProofSkeleton />}
        emptyTitle="No public proof page"
        emptyDescription="This repository has not opted in to a public proof page, or the surface is not enabled for this deployment."
        errorTitle="Proof summary unavailable"
        errorDescription="The proof summary could not be loaded just now. This says nothing about the repository's ledger."
      >
        {query.data ? (
          <div className="flex flex-col gap-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card>
                <h3 className="text-token-sm font-medium">Decisions</h3>
                <p className="mt-1 text-token-2xl font-semibold tabular-nums">
                  {countFmt.format(query.data.decisionCount)}
                </p>
                <p className="text-muted-foreground mt-1 text-token-sm">
                  Published, digest-committed verdicts.
                </p>
              </Card>
              <AccuracyCard accuracy={query.data.accuracy} />
              <LedgerCard ledger={query.data.ledger} />
              <AnchorCard anchor={query.data.anchor} />
            </div>

            {query.data.sampleRecords.length > 0 ? (
              <Card>
                <h3 className="text-token-sm font-medium">Sample decision records</h3>
                <p className="text-muted-foreground mt-1 text-token-sm">
                  A few of the published records, with the digest each one commits to. Recompute any
                  digest from the record&apos;s own contents — it is a hash of the record minus the
                  digest field.
                </p>
                <ul className="mt-3 flex flex-col gap-2">
                  {query.data.sampleRecords.map((record) => (
                    <li
                      key={record.recordDigest}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-token-sm"
                    >
                      <span className="font-medium">#{record.pullNumber}</span>
                      <span className="text-muted-foreground">{record.action}</span>
                      <span className="text-muted-foreground">{record.reasonCode}</span>
                      <span
                        className="text-muted-foreground font-mono text-token-xs"
                        title={record.recordDigest}
                      >
                        {shortDigest(record.recordDigest)}
                      </span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {/* Rendered from the payload, never hardcoded here: the API carries the boundary statement so a
                screenshot or an embed cannot shed it the way a page footer can. */}
            <Card>
              <h3 className="text-token-sm font-medium">What this does not prove</h3>
              <p className="text-muted-foreground mt-1 text-token-sm">{query.data.boundary}</p>
            </Card>
          </div>
        ) : null}
      </StateBoundary>
    </Section>
  );
}
