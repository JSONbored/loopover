// Shared AI-call usage estimation and response extraction (#10169).
//
// Both helpers below existed as private copies in several services -- estimateNeurons in four places,
// extractAiText in three, byte-identical to each other. They had already drifted in the way copy-paste always
// does: ai-review.ts's copy grew a `calls` multiplier when it needed one, and the three copies that had been
// pasted earlier did not follow.
//
// That drift was not cosmetic. `estimatedNeurons` is BOTH the pre-flight budget check and the value recorded
// into ai_usage_events, which sumAiEstimatedNeuronsSince adds up as the shared daily neuron budget -- so a
// service that retried its provider call reported half the neurons it actually spent, into the counter meant
// to notice exactly that. See ai-chat-qa's retry loop.
//
// Kept in its own leaf module rather than imported from ai-review.ts: that file is 3.6k lines, and three
// small services should not take a dependency on the review engine to divide a number by four.

/**
 * PURE. Rough neuron cost of an AI call, or of `calls` identical ones.
 *
 * Chars/4 is the usual token approximation and 0.035 the Workers-AI neuron factor; both are estimates by
 * construction -- the point is a consistent, comparable number across every feature that shares the budget,
 * not accuracy against a bill.
 *
 * `calls` is the parameter the private copies dropped. Passing the ACTUAL number of provider calls made is
 * what keeps the recorded figure honest when a service retries.
 */
export function estimateNeurons(promptChars: number, maxOutputTokens: number, calls = 1): number {
  const inputTokens = Math.ceil(promptChars / 4);
  return Math.max(1, Math.ceil((inputTokens + maxOutputTokens) * 0.035) * Math.max(1, calls));
}

/** Pull usable text out of a provider response whose shape varies by provider/model. Fail-soft: anything
 *  unrecognised yields "" so the caller's own empty-answer handling decides, rather than throwing here. */
export function extractAiText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  if (typeof record.text === "string") return record.text;
  if (typeof record.result === "string") return record.result;
  return "";
}
