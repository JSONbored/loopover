import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";
import { openGovernorState } from "./governor-state.js";
export function evaluateGovernorChokepointGatePersisted(input, options = {}) {
    const ownsGovernorState = options.governorState === undefined;
    const governorState = options.governorState ?? openGovernorState();
    try {
        const persistedRateLimit = governorState.loadRateLimitState();
        const persistedCapUsage = governorState.loadCapUsage();
        const resolvedInput = {
            ...input,
            rateLimitBuckets: input.rateLimitBuckets ?? persistedRateLimit.buckets,
            rateLimitBackoffAttempts: input.rateLimitBackoffAttempts ?? persistedRateLimit.backoffAttempts,
            capUsage: input.capUsage ?? persistedCapUsage,
        };
        const gateOptions = options.append === undefined ? {} : { append: options.append };
        const result = evaluateGovernorChokepointGate(resolvedInput, gateOptions);
        governorState.saveRateLimitState({ buckets: result.rateLimitBuckets, backoffAttempts: result.rateLimitBackoffAttempts });
        return result;
    }
    finally {
        if (ownsGovernorState)
            governorState.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItY2hva2Vwb2ludC1wZXJzaXN0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1jaG9rZXBvaW50LXBlcnNpc3RlZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQUUsOEJBQThCLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUcxRSxPQUFPLEVBQUUsaUJBQWlCLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQTZCeEQsTUFBTSxVQUFVLHVDQUF1QyxDQUNyRCxLQUF1QyxFQUN2QyxVQUEwRCxFQUFFO0lBRTVELE1BQU0saUJBQWlCLEdBQUcsT0FBTyxDQUFDLGFBQWEsS0FBSyxTQUFTLENBQUM7SUFDOUQsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLGFBQWEsSUFBSSxpQkFBaUIsRUFBRSxDQUFDO0lBQ25FLElBQUksQ0FBQztRQUNILE1BQU0sa0JBQWtCLEdBQUcsYUFBYSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFDOUQsTUFBTSxpQkFBaUIsR0FBRyxhQUFhLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDdkQsTUFBTSxhQUFhLEdBQTRCO1lBQzdDLEdBQUcsS0FBSztZQUNSLGdCQUFnQixFQUFFLEtBQUssQ0FBQyxnQkFBZ0IsSUFBSSxrQkFBa0IsQ0FBQyxPQUFPO1lBQ3RFLHdCQUF3QixFQUFFLEtBQUssQ0FBQyx3QkFBd0IsSUFBSSxrQkFBa0IsQ0FBQyxlQUFlO1lBQzlGLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUSxJQUFJLGlCQUFpQjtTQUM5QyxDQUFDO1FBQ0YsTUFBTSxXQUFXLEdBQUcsT0FBTyxDQUFDLE1BQU0sS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBQ25GLE1BQU0sTUFBTSxHQUFHLDhCQUE4QixDQUFDLGFBQWEsRUFBRSxXQUFXLENBQUMsQ0FBQztRQUMxRSxhQUFhLENBQUMsa0JBQWtCLENBQUMsRUFBRSxPQUFPLEVBQUUsTUFBTSxDQUFDLGdCQUFnQixFQUFFLGVBQWUsRUFBRSxNQUFNLENBQUMsd0JBQXdCLEVBQUUsQ0FBQyxDQUFDO1FBQ3pILE9BQU8sTUFBTSxDQUFDO0lBQ2hCLENBQUM7WUFBUyxDQUFDO1FBQ1QsSUFBSSxpQkFBaUI7WUFBRSxhQUFhLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDL0MsQ0FBQztBQUNILENBQUMifQ==