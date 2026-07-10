/**
 * Issue-centric RAG query composition (#2320), extracted to `@jsonbored/gittensory-engine` (#4254) so the
 * miner analyze phase can compose the identical retrieval query from an issue's title/body/labels without
 * importing the review stack. Retrieval wiring for the miner MCP tool lives in `./issue-rag-retrieval.ts`
 * and `src/mcp/issue-rag.ts` (#4293); the Vectorize/D1 backend itself stays in `./rag`.
 *
 * packages/gittensory-engine/src/issue-rag-query.ts (imported via relative source path, not the published
 * module, matching the #2278/#2282 extraction shims) is the source of truth.
 */
export { buildIssueRagQuery, type IssueRagQueryInput } from "../../packages/gittensory-engine/src/issue-rag-query";
