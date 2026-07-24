// The product User-Agent, in its own leaf module (#test-import-cost): several modules (notably
// src/gittensor/api.ts, itself imported by db/repositories) need ONLY this constant, and importing it
// from ./client dragged the whole client ↔ repositories dependency cycle (~1.1s of cold import under
// vitest) into every one of their importers. ./client re-exports it, so existing importers are unchanged.
export const PRODUCT_USER_AGENT = "loopover/0.1";
