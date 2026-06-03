import type { FetchLike } from "../lib/types";

export const VALID_SESSION_TOKEN = `gts_${"a".repeat(64)}`;

export function mockFetch(handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handler = Object.entries(handlers).find(([pattern]) => url.includes(pattern))?.[1];
    if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return handler(init);
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
