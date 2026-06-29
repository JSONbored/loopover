/** Split composed AI advisory notes into prominent review text plus non-blocking nits.
 *
 * The AI review composer emits:
 *   summary/body
 *   optional **Blockers**
 *   optional trailing **Nits (N)**
 *
 * Both legacy and unified PR comments must keep the summary/blockers prominent and demote only
 * the trailing nits into a collapsible section. Keep this parser shared so the two renderers cannot drift.
 */
export function splitAiReviewNits(notes: string): { main: string; nits: string[] } {
  const marker = notes.indexOf("**Nits (");
  if (marker === -1) return { main: notes.trim(), nits: [] };
  const nits = notes
    .slice(marker)
    .split("\n")
    .slice(1)
    .map((line) => line.replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, "").trim())
    .filter(Boolean);
  return { main: notes.slice(0, marker).trim(), nits };
}
