import type { AgentContextSnapshotPublicProvenance, AgentContextSnapshotRecord } from "../types";

export function publicAgentContextSnapshotProvenance(snapshot: AgentContextSnapshotRecord): AgentContextSnapshotPublicProvenance | null {
  return snapshot.provenance?.publicSafe ?? null;
}
