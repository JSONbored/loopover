import type { ChatActionRegistry } from "./chat-action-registry.js";
export declare const DISCOVER_CHAT_ACTION: "discover";
export declare const ATTEMPT_CHAT_ACTION: "attempt";
export type DiscoverChatActionInput = {
    targets?: string[];
    search?: string;
    dryRun?: boolean;
    json?: boolean;
    apiBaseUrl?: string;
    tokenEnv?: string;
};
export type AttemptChatActionInput = {
    repoFullName: string;
    issueNumber: number;
    minerLogin: string;
    base?: string;
    live?: boolean;
    dryRun?: boolean;
    json?: boolean;
};
/**
 * `DiscoverActionInput` — every field optional (the CLI defaults them all), so an empty object is a valid
 * "discover with defaults". Unknown keys are rejected rather than ignored: these params can be model-authored,
 * and a typo'd flag must fail loudly instead of silently running a different discovery than intended.
 */
export declare function isDiscoverChatParams(params: unknown): boolean;
/**
 * `AttemptActionInput` — `repoFullName` / `issueNumber` / `minerLogin` are REQUIRED (the CLI has no default
 * for which issue to attempt), so unlike discover there is no valid empty form. `issueNumber` must be a
 * positive integer: a float or 0 would reach the CLI as a nonsense issue reference.
 */
export declare function isAttemptChatParams(params: unknown): boolean;
/**
 * Idempotently register `discover` / `attempt`.
 */
export declare function registerDiscoverAttemptChatActions(options: {
    requestDiscover: (input: DiscoverChatActionInput) => Promise<unknown>;
    requestAttempt: (input: AttemptChatActionInput) => Promise<unknown>;
    registry?: ChatActionRegistry;
    evaluateGate?: () => {
        decision: {
            stage: string;
        };
    };
}): void;
