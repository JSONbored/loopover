import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { handleAnalyticsProxy, type PostHogAssetContext } from "./lib/analytics-proxy";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    // First-party proxy for cookieless analytics collection (/stats/*, PostHog).
    // Runs ahead of SSR and returns undefined for every other path.
    //
    // The try/catch is a top-level safety net, not belt-and-braces: this is a
    // public unauthenticated route, and the sibling implementation had a real
    // production incident (JSONbored/metagraphed#7794) where an unguarded
    // background cache failure escaped as an unhandled rejection and corrupted
    // the response for every asset request. Analytics must never be able to
    // take down request handling -- catch anything it throws and treat it as
    // "not handled" so the request falls through to the real SSR app below.
    let analytics: Response | undefined;
    try {
      analytics = await handleAnalyticsProxy(request, ctx as PostHogAssetContext);
    } catch (error) {
      console.error("[analytics-proxy] request handling failed:", error);
    }
    if (analytics) return analytics;

    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(response);
    } catch (error) {
      console.error(error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
