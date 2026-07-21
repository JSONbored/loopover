/** Hosted-backend client for a contributor's post-merge PR-outcome history (#7658): a thin, FAIL-LOUD wrapper over
 * `GET /v1/contributors/:login/pr-outcomes` (`src/signals/contributor-pr-outcomes.ts`). Uses the same authenticated
 * loopover-mcp session posture (`resolveLoopoverBackendSession`) every other miner→hosted-API call uses, and throws
 * a clear Error on any failure (no configured session, unreachable host, non-2xx, malformed body) rather than
 * silently degrading -- the CLI on top turns each throw into a non-zero exit with the message. The endpoint is
 * self-scoped via `requireContributorAccess`, so this only ever surfaces the caller's own public-safe attribution
 * data (no reward/wallet fields). */
import { resolveLoopoverBackendSession } from "./github-token-resolution.js";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/**
 * Fetch `login`'s post-merge PR-outcome history from the hosted backend. Requires an authenticated loopover-mcp
 * session (throws `no_loopover_session` otherwise, matching the endpoint's self-scoped access). `limit`, when given,
 * must be an integer in 1..100 -- the same bound the endpoint enforces -- else this throws before any network call.
 */
export async function fetchContributorPrOutcomes(login, options = {}) {
    const normalizedLogin = typeof login === "string" ? login.trim() : "";
    if (!normalizedLogin)
        throw new Error("pr-outcomes requires a non-empty login");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
        throw new Error("pr-outcomes limit must be an integer between 1 and 100");
    }
    const session = resolveLoopoverBackendSession(options.env ?? process.env);
    if (!session)
        throw new Error("no_loopover_session: run `loopover-mcp login` first");
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    const query = options.limit !== undefined ? `?limit=${options.limit}` : "";
    const path = `/v1/contributors/${encodeURIComponent(normalizedLogin)}/pr-outcomes${query}`;
    let response;
    try {
        response = await fetchImpl(`${session.apiUrl}${path}`, {
            method: "GET",
            headers: { accept: "application/json", authorization: `Bearer ${session.sessionToken}` },
            signal: AbortSignal.timeout(timeoutMs),
        });
    }
    catch (error) {
        throw new Error(`pr-outcomes endpoint unreachable for ${normalizedLogin}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        throw new Error(`pr-outcomes endpoint returned http_${response.status} for ${normalizedLogin}`);
    }
    const payload = (await response.json().catch(() => null));
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.outcomes)) {
        throw new Error(`pr-outcomes endpoint returned a malformed response for ${normalizedLogin}`);
    }
    return payload;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZXMtY2xpZW50LmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItb3V0Y29tZXMtY2xpZW50LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7cUNBTXFDO0FBQ3JDLE9BQU8sRUFBRSw2QkFBNkIsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBRTdFLE1BQU0sMEJBQTBCLEdBQUcsTUFBTSxDQUFDO0FBOEIxQzs7OztHQUlHO0FBQ0gsTUFBTSxDQUFDLEtBQUssVUFBVSwwQkFBMEIsQ0FDOUMsS0FBYSxFQUNiLFVBQTZDLEVBQUU7SUFFL0MsTUFBTSxlQUFlLEdBQUcsT0FBTyxLQUFLLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUN0RSxJQUFJLENBQUMsZUFBZTtRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsd0NBQXdDLENBQUMsQ0FBQztJQUNoRixJQUFJLE9BQU8sQ0FBQyxLQUFLLEtBQUssU0FBUyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsSUFBSSxPQUFPLENBQUMsS0FBSyxHQUFHLENBQUMsSUFBSSxPQUFPLENBQUMsS0FBSyxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDbEgsTUFBTSxJQUFJLEtBQUssQ0FBQyx3REFBd0QsQ0FBQyxDQUFDO0lBQzVFLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyw2QkFBNkIsQ0FBQyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxRSxJQUFJLENBQUMsT0FBTztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMscURBQXFELENBQUMsQ0FBQztJQUVyRixNQUFNLFNBQVMsR0FBRyxPQUFPLENBQUMsU0FBUyxJQUFLLEtBQStELENBQUM7SUFDeEcsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUUsT0FBTyxDQUFDLGdCQUEyQixDQUFDLENBQUMsQ0FBQywwQkFBMEIsQ0FBQztJQUNoSSxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsS0FBSyxLQUFLLFNBQVMsQ0FBQyxDQUFDLENBQUMsVUFBVSxPQUFPLENBQUMsS0FBSyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztJQUMzRSxNQUFNLElBQUksR0FBRyxvQkFBb0Isa0JBQWtCLENBQUMsZUFBZSxDQUFDLGVBQWUsS0FBSyxFQUFFLENBQUM7SUFFM0YsSUFBSSxRQUFrQixDQUFDO0lBQ3ZCLElBQUksQ0FBQztRQUNILFFBQVEsR0FBRyxNQUFNLFNBQVMsQ0FBQyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEdBQUcsSUFBSSxFQUFFLEVBQUU7WUFDckQsTUFBTSxFQUFFLEtBQUs7WUFDYixPQUFPLEVBQUUsRUFBRSxNQUFNLEVBQUUsa0JBQWtCLEVBQUUsYUFBYSxFQUFFLFVBQVUsT0FBTyxDQUFDLFlBQVksRUFBRSxFQUFFO1lBQ3hGLE1BQU0sRUFBRSxXQUFXLENBQUMsT0FBTyxDQUFDLFNBQVMsQ0FBQztTQUN2QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLE1BQU0sSUFBSSxLQUFLLENBQUMsd0NBQXdDLGVBQWUsS0FBSyxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQ3hJLENBQUM7SUFDRCxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsRUFBRSxDQUFDO1FBQ2pCLE1BQU0sSUFBSSxLQUFLLENBQUMsc0NBQXNDLFFBQVEsQ0FBQyxNQUFNLFFBQVEsZUFBZSxFQUFFLENBQUMsQ0FBQztJQUNsRyxDQUFDO0lBQ0QsTUFBTSxPQUFPLEdBQUcsQ0FBQyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxLQUFLLENBQUMsR0FBRyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQWlDLENBQUM7SUFDMUYsSUFBSSxPQUFPLEtBQUssSUFBSSxJQUFJLE9BQU8sT0FBTyxLQUFLLFFBQVEsSUFBSSxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDeEYsTUFBTSxJQUFJLEtBQUssQ0FBQywwREFBMEQsZUFBZSxFQUFFLENBQUMsQ0FBQztJQUMvRixDQUFDO0lBQ0QsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQyJ9