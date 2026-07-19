// Detect + defang prompt-injection / agent-manipulation text in UNTRUSTED third-party repo content (a
// customer's own issue title/body) before it reaches the coding agent's own instructions (#4795). Such
// content is DATA, never instructions -- but a coding agent operating with real write authority on a
// customer's repository can still be steered by it, so we both flag it (a strong negative signal) and
// redact the literal manipulation so it can't be obeyed verbatim.
//
// SELF-CONTAINED NATIVE PORT: byte-faithful to src/review/prompt-injection.ts's proven regex (the same
// reviewer-manipulation shape, now defending the coding agent's own instructions instead of the AI
// reviewer's prompt). No cross-package import -- packages/loopover-miner never depends on root src/ (a
// separate Cloudflare Worker deployable, see package.json's own dependency list), so the pattern is
// duplicated here rather than shared, matching how src/review/prompt-injection.ts itself documents being
// a self-contained port of its own upstream (reviewbot's src/core/prompt-injection.ts). Keep the two
// regex sources in sync by hand if either evolves.

const INJECTION_SOURCE = [
  "\\b(?:ignore|disregard|forget)\\b[^.]{0,40}\\b(?:previous|prior|above|earlier|all|the|any)\\b[^.]{0,24}\\b(?:instructions?|prompts?|rules?|rubric|policy|guidelines?|directions?)\\b",
  "\\b(?:override|bypass)\\b[^.]{0,40}\\b(?:previous|prior|above|earlier|all|any)\\b[^.]{0,24}\\b(?:instructions?|prompts?)\\b|\\b(?:override|bypass)\\s+the\\s+(?:rules?|rubric|policy|guidelines?|directions?)\\b[^.]{0,40}\\b(?:approve|merge|accept|whitelist|allow|pass|scor(?:e|ing))\\b",
  "\\byou are now\\s+(?:an?\\s+(?:\\w+\\s+)?(?:ai|assistant|language model|reviewer|maintainer|admin|moderator|bot|developer|owner|system)|(?:unrestricted|uncensored|unfiltered|unbound|jailbroken))\\b",
  "\\b(?:this is|here is|below is)\\s+the\\s+(?:system|developer)\\s+prompt\\b|\\b(?:system|developer)\\s+prompt\\s*:",
  "\\b(?:approve|merge|accept|whitelist|allow|pass)\\s+this\\s+(?:submission|pr|pull[ -]?request|entry|request|content|review)\\b|\\b(?:please|kindly|just)\\s+(?:approve|merge|accept|whitelist|allow|pass)\\s+the\\s+(?:submission|pr|pull[ -]?request|entry|request|content|review)\\b",
  "\\bas an?\\s+(?:ai|assistant|language model)\\b[^.]{0,30}\\b(?:you must\\s+(?:ignore|approve|obey|disregard|comply)|ignore\\s+(?:previous|prior|all|the|any)|approve\\s+(?:this|the))\\b",
  "\\b(?:print|reveal|output|repeat|leak)\\b[^.]{0,30}\\byour\\s+(?:system prompt|rubric|instructions?)\\b|\\b(?:print|reveal|output|repeat|leak)\\b[^.]{0,30}\\bthe\\s+(?:system|developer)\\s+prompt\\b[^.]{0,40}\\byou\\s+(?:were\\s+)?(?:given|sent|provided|received)\\b",
  "\\b(?:pretend|roleplay)\\b[^.]{0,24}\\byou\\s+are\\b",
].join("|");

export const PROMPT_INJECTION_RE = new RegExp(INJECTION_SOURCE, "i");

/** True when the text contains an agent-manipulation / prompt-injection pattern. */
export function hasPromptInjection(text: string | null | undefined): boolean {
  return !!text && PROMPT_INJECTION_RE.test(text);
}

/**
 * Replace injection-like spans with a defanged marker so the literal manipulation never reaches the
 * coding agent verbatim. Returns the neutralized text + whether anything was flagged.
 */
export function neutralizePromptInjection(text: string | null | undefined): { text: string; injected: boolean } {
  if (!text) return { text: text ?? "", injected: false };
  let injected = false;
  const cleaned = text.replace(new RegExp(INJECTION_SOURCE, "gi"), () => {
    injected = true;
    return "[external-instruction-redacted]";
  });
  return { text: cleaned, injected };
}
