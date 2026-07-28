// Shapes reused by three or more tool contracts (#9517).
//
// The bar for hoisting here is deliberate and worth stating, because a "shared" file with no
// admission rule becomes a junk drawer: a shape earns a place here at its THIRD consumer, not its
// second. Two tools that happen to take the same fields today are usually a coincidence, and
// prematurely coupling them means a later divergence has to be un-shared under pressure.
import { z } from "zod";

/** The owner/repo pair virtually every repo-scoped tool takes. */
export const ownerRepoInput = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

/** owner/repo plus a pull-request number. */
export const ownerRepoPullInput = ownerRepoInput.extend({
  number: z.number().int().positive(),
});

/**
 * The freshness marker cached advisory payloads carry.
 *
 * Optional on purpose: a freshly-computed response has no cache metadata to report, and the older
 * REST responses these tools wrap omit the field entirely rather than sending a null.
 */
export const freshnessFields = {
  generatedAt: z.string().optional(),
  cached: z.boolean().optional(),
  stale: z.boolean().optional(),
};

/**
 * Fields an error envelope carries when a tool fails in a way the caller can act on.
 *
 * `code` is drawn from a closed, developer-defined set rather than free text so telemetry can
 * break failures down by cause (#9525) and never ingests a caller-derived string.
 */
export const toolErrorFields = {
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
};
