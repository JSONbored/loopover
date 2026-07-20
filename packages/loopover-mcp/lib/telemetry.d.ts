export type RecordMcpToolCallOptions = {
    telemetryEnabled?: boolean;
};
export type RecordMcpToolCallEvent = {
    tool: string;
    callerType?: "local";
    ok: boolean;
    durationMs: number;
};
/**
 * Record a single local MCP tool call to PostHog. Safe no-op unless `telemetryEnabled` is explicitly
 * `true` (the caller's resolved, persisted opt-in flag, default OFF -- #6236) AND
 * LOOPOVER_MCP_POSTHOG_API_KEY is configured; never throws.
 */
export declare function recordMcpToolCall(options: RecordMcpToolCallOptions | null | undefined, event: RecordMcpToolCallEvent): void;
