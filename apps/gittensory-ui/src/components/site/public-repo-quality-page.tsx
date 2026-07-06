import { useQuery } from "@tanstack/react-query";

import { getApiOrigin } from "@/lib/api/origin";
import { apiFetch } from "@/lib/api/request";
import { Card, Section, SectionTitle } from "@/components/site/primitives";

export type PublicQualityMetrics = {
  repoFullName: string;
  generatedAt: string;
  gate: {
    blocked: number;
    blockedThenMerged: number;
    falsePositiveRate: number | null;
    precisionPct: number | null;
    topGateTypes: Array<{
      gateType: string;
      blocked: number;
      blockedThenMerged: number;
      falsePositiveRate: number | null;
      precisionPct: number | null;
    }>;
  };
  outcomes: { merged: number; closed: number; mergeRatioPct: number | null };
  slop: { totalResolved: number; overallMergeRate: number | null; discriminates: boolean | null };
  trend: Array<{
    weekStart: string;
    gateBlocked: number;
    gateBlockedThenMerged: number;
    gateFalsePositiveRate: number | null;
    outcomesMerged: number;
    outcomesClosed: number;
    mergeRatioPct: number | null;
  }>;
};

const pctFmt = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

async function fetchPublicQualityMetrics(
  owner: string,
  repo: string,
): Promise<PublicQualityMetrics | null> {
  const result = await apiFetch<PublicQualityMetrics>(
    `${getApiOrigin()}/v1/public/repos/${owner}/${repo}/quality`,
    {
      label: "Public quality metrics",
      timeoutMs: 8000,
      silentStatus: true,
    },
  );
  if (!result.ok || !result.data) return null;
  return result.data;
}

function slopCalibrationHint(discriminates: boolean | null): string {
  if (discriminates === true) return " · discriminating";
  if (discriminates === false) return " · recalibrate";
  return "";
}

export function PublicRepoQualityPage({ owner, repo }: { owner: string; repo: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-quality", owner, repo],
    queryFn: () => fetchPublicQualityMetrics(owner, repo),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <Section className="pt-16 pb-16">
        <p className="text-muted-foreground">Loading review-quality metrics…</p>
      </Section>
    );
  }

  if (!data || isError) {
    return (
      <Section className="pt-16 pb-16">
        <SectionTitle title="Review quality unavailable" />
        <p className="mt-4 max-w-2xl text-token-sm text-muted-foreground">
          This repository has not opted in to public review-quality metrics, or the metrics are
          temporarily unavailable.
        </p>
      </Section>
    );
  }

  return (
    <Section className="pt-16 pb-16">
      <div className="max-w-4xl">
        <div className="text-token-xs text-muted-foreground">Public review quality</div>
        <h1 className="mt-4 text-token-2xl font-medium tracking-tight text-foreground">
          {data.repoFullName}
        </h1>
        <p className="mt-3 text-token-sm text-muted-foreground">
          Aggregate counts only — no raw trust scores, rewards, or contributor rankings. Updated{" "}
          {new Date(data.generatedAt).toLocaleString()}.
        </p>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <Card className="p-5">
            <div className="text-token-xs text-muted-foreground">Gate precision</div>
            <div className="mt-2 text-token-xl font-medium">
              {data.gate.precisionPct != null ? `${pctFmt.format(data.gate.precisionPct)}%` : "—"}
            </div>
            <p className="mt-2 text-token-sm text-muted-foreground">
              {data.gate.blocked} blocks, {data.gate.blockedThenMerged} later merged
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-token-xs text-muted-foreground">Merge ratio</div>
            <div className="mt-2 text-token-xl font-medium">
              {data.outcomes.mergeRatioPct != null
                ? `${pctFmt.format(data.outcomes.mergeRatioPct)}%`
                : "—"}
            </div>
            <p className="mt-2 text-token-sm text-muted-foreground">
              {data.outcomes.merged} merged / {data.outcomes.closed} closed
            </p>
          </Card>
          <Card className="p-5">
            <div className="text-token-xs text-muted-foreground">Slop calibration</div>
            <div className="mt-2 text-token-xl font-medium">
              {data.slop.overallMergeRate != null
                ? `${pctFmt.format(data.slop.overallMergeRate)}% merge`
                : "—"}
            </div>
            <p className="mt-2 text-token-sm text-muted-foreground">
              {data.slop.totalResolved} resolved PRs{slopCalibrationHint(data.slop.discriminates)}
            </p>
          </Card>
        </div>

        {data.gate.topGateTypes.length > 0 ? (
          <div className="mt-10">
            <h2 className="text-token-lg font-medium">Top gate types</h2>
            <ul className="mt-4 space-y-2 text-token-sm">
              {data.gate.topGateTypes.map((row) => (
                <li key={row.gateType} className="rounded-token border-hairline px-4 py-3">
                  <span className="font-mono text-foreground">{row.gateType}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    — {row.blocked} blocks, {row.blockedThenMerged} merged anyway
                    {row.precisionPct != null
                      ? ` (${pctFmt.format(row.precisionPct)}% precision)`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-10">
          <h2 className="text-token-lg font-medium">Weekly trend</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-token-sm">
              <thead className="text-token-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Week</th>
                  <th className="pb-2 pr-4 font-medium">Gate FP rate</th>
                  <th className="pb-2 pr-4 font-medium">Merge ratio</th>
                  <th className="pb-2 font-medium">Blocks</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.map((row) => (
                  <tr key={row.weekStart} className="border-t border-hairline">
                    <td className="py-2 pr-4 font-mono text-token-xs">{row.weekStart}</td>
                    <td className="py-2 pr-4">
                      {row.gateFalsePositiveRate != null
                        ? `${pctFmt.format(row.gateFalsePositiveRate * 100)}%`
                        : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {row.mergeRatioPct != null ? `${pctFmt.format(row.mergeRatioPct)}%` : "—"}
                    </td>
                    <td className="py-2">{row.gateBlocked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Section>
  );
}
