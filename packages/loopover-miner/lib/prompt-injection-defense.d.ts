export declare const PROMPT_INJECTION_RE: RegExp;
/** True when the text contains an agent-manipulation / prompt-injection pattern. */
export declare function hasPromptInjection(text: string | null | undefined): boolean;
/**
 * Replace injection-like spans with a defanged marker so the literal manipulation never reaches the
 * coding agent verbatim. Returns the neutralized text + whether anything was flagged.
 */
export declare function neutralizePromptInjection(text: string | null | undefined): {
    text: string;
    injected: boolean;
};
