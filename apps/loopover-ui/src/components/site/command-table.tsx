import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const DEFAULT_ROLE_SUMMARY: Record<string, string> = {
  help: "maintainer, collaborator, confirmed_miner (default policy)",
  ask: "maintainer, collaborator, confirmed_miner",
  preflight: "maintainer, collaborator, confirmed_miner",
  blockers: "maintainer, collaborator, confirmed_miner",
  "duplicate-check": "maintainer, collaborator, confirmed_miner",
  "miner-context": "maintainer, collaborator, confirmed_miner",
  "next-action": "maintainer, collaborator, confirmed_miner",
  reviewability: "maintainer, collaborator, confirmed_miner",
  "repo-fit": "maintainer, collaborator, confirmed_miner",
  packet: "maintainer, collaborator, confirmed_miner",
  "queue-summary": "maintainer, collaborator",
  "confirmed-miners": "maintainer, collaborator",
  "review-now": "maintainer, collaborator",
  "needs-author": "maintainer, collaborator",
  "duplicate-clusters": "maintainer, collaborator",
  "burden-forecast": "maintainer, collaborator",
  "intake-health": "maintainer, collaborator",
  "outcome-patterns": "maintainer, collaborator",
  "noise-report": "maintainer, collaborator",
  "gate-override": "maintainer, collaborator",
  review: "maintainer, collaborator, confirmed_miner",
  pause: "maintainer, collaborator",
  resume: "maintainer, collaborator",
  resolve: "maintainer, collaborator",
  configuration: "maintainer, collaborator",
  explain: "maintainer, collaborator",
};

export function CommandTable({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<{ id: string; title: string; description: string }>;
}) {
  return (
    <>
      <h2>{title}</h2>
      <div className="not-prose overflow-x-auto">
        <Table className="border-collapse text-token-sm">
          <TableHeader>
            <TableRow className="border-hairline text-left text-token-xs text-muted-foreground">
              <TableHead className="py-2 pr-4 font-medium">Syntax</TableHead>
              <TableHead className="py-2 pr-4 font-medium">Effect</TableHead>
              <TableHead className="py-2 font-medium">Default roles</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-hairline">
            {entries.map((entry) => (
              <TableRow key={entry.id} className="align-top">
                <TableCell className="py-2 pr-4 font-mono text-token-xs whitespace-nowrap">
                  @loopover {entry.id}
                </TableCell>
                <TableCell className="py-2 pr-4 text-muted-foreground">
                  {entry.description}
                </TableCell>
                <TableCell className="py-2 text-muted-foreground">
                  {DEFAULT_ROLE_SUMMARY[entry.id] ?? "see policy"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
