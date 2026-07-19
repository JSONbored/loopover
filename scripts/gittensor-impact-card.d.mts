// Deliberately not `typeof fetch`: the global fetch type (in a Cloudflare Workers-typed environment) is
// overloaded to accept URL/RequestInfo/CfProperties, which a plainly-typed vi.fn() mock can't satisfy under
// strict function-type checking (see scripts/load-test-worker.d.mts's identical note). Both functions here
// only ever call fetchImpl with a string URL and a plain {headers?, signal} init.
export type ImpactCardFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok?: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }>;

export declare const GITTENSOR_IMPACT_CARD_FETCH_TIMEOUT_MS: number;

export declare function fetchJson(url: string, fetchImpl?: ImpactCardFetch): Promise<unknown>;

export declare function fetchGtLogoSvg(fetchImpl?: ImpactCardFetch): Promise<string>;
