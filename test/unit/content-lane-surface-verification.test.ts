import { describe, expect, it } from "vitest";
import {
  FUNCTIONAL_INCONCLUSIVE_REASON,
  FUNCTIONAL_NOT_SERVED_REASON,
  GROUNDING_INCONCLUSIVE_REASON,
  GROUNDING_UNCONFIRMED_REASON,
  MAX_PROBE_BODY_CHARS,
  SURFACE_GROUNDING_MIN_STRONG,
  fetchSurfaceProbe,
  makeSurfaceEntryVerifier,
  probeToEvidence,
  verifySurfaceEntry,
} from "../../src/review/content-lane/surface-verification";

// ── fetch stubs ───────────────────────────────────────────────────────────────────────────────
// A Response-shaped stub. Built by hand rather than with `new Response()` so a body-read FAILURE (a broken
// stream on an otherwise-2xx response) is expressible — that arm is a real degraded-fetch case the gate must
// treat as inconclusive, and a genuine Response can't be made to reject from text().
const res = (init: { status?: number; headers?: Record<string, string>; body?: string; textThrows?: boolean }): Response => {
  const status = init.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(init.headers ?? {}),
    text: init.textThrows ? () => Promise.reject(new Error("stream broken")) : () => Promise.resolve(init.body ?? ""),
  } as unknown as Response;
};

/** A fetch stub routing on the exact request URL; an unmapped URL fails the test loudly rather than silently. */
const routes = (map: Record<string, Response | "throw">): typeof fetch =>
  ((url: string | URL): Promise<Response> => {
    const hit = map[String(url)];
    if (hit === undefined) return Promise.reject(new Error(`unexpected fetch: ${String(url)}`));
    if (hit === "throw") return Promise.reject(new Error("network down"));
    return Promise.resolve(hit);
  }) as unknown as typeof fetch;

const html = (body: string) => res({ headers: { "content-type": "text/html" }, body });
const json = (body: string) => res({ headers: { "content-type": "application/json" }, body });

const TARGET = "https://sn14.example.ai/docs";
const SOURCE = "https://github.com/acme/sn14";
/** A website entry whose source page names the subnet → one grounding signal → verifies clean. */
const groundedEntry = { netuid: 14, kind: "website", url: TARGET, source_url: SOURCE, public_safe: true };

describe("fetchSurfaceProbe", () => {
  it("returns an ok probe carrying the served status, content-type and body", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: json('{"a":1}') }));
    expect(probe.ok).toBe(true);
    expect(probe.httpStatus).toBe(200);
    expect(probe.contentType).toBe("application/json");
    expect(probe.body).toBe('{"a":1}');
    expect(probe.crossOriginRedirect).toBe(false);
    expect(probe.error).toBeNull();
  });

  it("refuses a non-public URL without ever fetching (SSRF guard)", async () => {
    // routes({}) rejects ANY fetch, so reaching the network at all would surface as probe_fetch_failed.
    for (const url of ["http://insecure.example/x", "https://127.0.0.1/x", "https://localhost/x", "not a url"]) {
      const probe = await fetchSurfaceProbe(url, routes({}));
      expect(probe.error).toBe("probe_url_not_public");
      expect(probe.ok).toBe(false);
    }
  });

  it("re-applies the SSRF guard on every redirect hop (an https origin cannot 302 into loopback)", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ status: 302, headers: { location: "https://127.0.0.1/admin" } }) }));
    expect(probe.error).toBe("probe_url_not_public");
    expect(probe.ok).toBe(false);
  });

  it("follows a same-domain redirect without flagging a cross-origin hop", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({
      [TARGET]: res({ status: 301, headers: { location: "https://docs.example.ai/v2" } }),
      "https://docs.example.ai/v2": html("<p>hi</p>"),
    }));
    expect(probe.ok).toBe(true);
    expect(probe.crossOriginRedirect).toBe(false);
  });

  it("flags a redirect that lands on a DIFFERENT registrable domain (bait-and-switch)", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({
      [TARGET]: res({ status: 302, headers: { location: "https://elsewhere.test/landing" } }),
      "https://elsewhere.test/landing": html("<p>hi</p>"),
    }));
    expect(probe.ok).toBe(true);
    expect(probe.crossOriginRedirect).toBe(true);
  });

  it("gives up on a redirect with no Location header", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ status: 302 }) }));
    expect(probe.error).toBe("probe_redirect_without_location");
    expect(probe.httpStatus).toBe(302);
  });

  it("gives up on an unparseable Location header", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ status: 302, headers: { location: "http://[bad" } }) }));
    expect(probe.error).toBe("probe_redirect_without_location");
  });

  it("gives up after too many redirect hops", async () => {
    // A self-redirect loop: every hop is safe + parseable, so only the hop cap can stop it.
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ status: 302, headers: { location: TARGET } }) }));
    expect(probe.error).toBe("probe_too_many_redirects");
  });

  it("reports a non-2xx as an http error carrying the status", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ status: 404, body: "nope" }) }));
    expect(probe.error).toBe("probe_http_error");
    expect(probe.httpStatus).toBe(404);
    expect(probe.ok).toBe(false);
  });

  it("never throws when the fetch itself throws", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: "throw" }));
    expect(probe.error).toBe("probe_fetch_failed");
    expect(probe.ok).toBe(false);
  });

  it("treats a 2xx whose body cannot be read as unreadable, NOT as an empty pass", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: res({ textThrows: true }) }));
    expect(probe.error).toBe("probe_body_unreadable");
    expect(probe.ok).toBe(false);
  });

  // #9490: the old read was `(await response.text()).slice(...)` -- the FULL hostile body buffered before the
  // slice, so a streamed multi-hundred-MB response OOMed the isolate before any fail-closed path could run.
  it("REGRESSION (#9490): a streamed over-limit body is CANCELLED at the cap, never buffered whole", async () => {
    let chunksServed = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(16_000));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksServed += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(endless, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    const probe = await fetchSurfaceProbe(TARGET, fetchImpl);

    expect(probe.ok).toBe(true);
    expect(probe.body.length).toBeLessThanOrEqual(64_000);
    expect(cancelled).toBe(true);
    // The stream is infinite; reaching here at all proves the read stopped at the cap. The chunk count pins
    // it quantitatively: ~4 chunks reach the cap, so anything this side of a dozen means bounded reading.
    expect(chunksServed).toBeLessThan(12);
  });

  it("INVARIANT (#9490): a cancel() that itself rejects is swallowed — the bounded read still returns the capped body", async () => {
    const chunk = new TextEncoder().encode("x".repeat(70_000));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        throw new Error("cancel exploded");
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const probe = await fetchSurfaceProbe(TARGET, fetchImpl);
    expect(probe.ok).toBe(true);
    expect(probe.body.length).toBe(64_000);
  });

  it("INVARIANT (#9490): a small streamed body is read whole through the bounded reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"openapi":"3.0.0"}'));
        controller.close();
      },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const probe = await fetchSurfaceProbe(TARGET, fetchImpl);
    expect(probe.ok).toBe(true);
    expect(probe.body).toBe('{"openapi":"3.0.0"}');
  });

  it("truncates an oversized body to the probe cap", async () => {
    const probe = await fetchSurfaceProbe(TARGET, routes({ [TARGET]: json("x".repeat(MAX_PROBE_BODY_CHARS + 500)) }));
    expect(probe.body).toHaveLength(MAX_PROBE_BODY_CHARS);
  });
});

describe("probeToEvidence", () => {
  const probe = (over: Partial<ReturnType<typeof probeToEvidence>> & { contentType?: string | null; body?: string; crossOriginRedirect?: boolean }) => ({
    ok: true,
    httpStatus: 200,
    contentType: over.contentType ?? null,
    body: over.body ?? "",
    crossOriginRedirect: over.crossOriginRedirect ?? false,
    error: null,
  });

  it("extracts an HTML title and strips tags from the snippet", () => {
    const ev = probeToEvidence(probe({ contentType: "text/html", body: "<html><title> Subnet  14 </title><body><p>Hello</p></body></html>" }));
    expect(ev.title).toBe("Subnet 14");
    expect(ev.snippet).toContain("Hello");
    expect(ev.snippet).not.toContain("<p>");
  });

  it("drops script/style contents so bundled code cannot forge a grounding signal", () => {
    const ev = probeToEvidence(probe({ contentType: "text/html", body: "<html><body><script>var s='subnet 14';</script><style>.a{}</style><p>real</p></body></html>" }));
    expect(ev.snippet).not.toContain("subnet 14");
    expect(ev.snippet).toContain("real");
  });

  it("detects HTML from the body when the content-type does not say so", () => {
    const ev = probeToEvidence(probe({ contentType: "text/plain", body: "<!doctype html><title>T</title><p>x</p>" }));
    expect(ev.title).toBe("T");
    expect(ev.snippet).not.toContain("<p>");
  });

  it("uses a non-HTML body verbatim and reports no title", () => {
    const ev = probeToEvidence(probe({ contentType: "application/json", body: '{"netuid":14}' }));
    expect(ev.title).toBe("");
    expect(ev.snippet).toBe('{"netuid":14}');
  });

  it("reports an empty title for HTML with no title tag, and for a blank title tag", () => {
    expect(probeToEvidence(probe({ contentType: "text/html", body: "<p>x</p>" })).title).toBe("");
    expect(probeToEvidence(probe({ contentType: "text/html", body: "<title>   </title><p>x</p>" })).title).toBe("");
  });

  it("propagates the cross-origin-redirect flag through to the grounding evidence", () => {
    expect(probeToEvidence(probe({ crossOriginRedirect: true })).cross_origin_redirect).toBe(true);
    expect(probeToEvidence(probe({ crossOriginRedirect: false })).cross_origin_redirect).toBe(false);
  });
});

// ── #8908: evidence-corroboration grounding is now actually consulted ─────────────────────────
describe("verifySurfaceEntry — grounding (#8908)", () => {
  it("merges an entry whose fetched source corroborates the declared netuid", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: html("<p>This repo powers subnet 14 on Bittensor.</p>") }),
    });
    expect(v.grounding.outcome).toBe("pass");
    expect(v.grounding.detail).toContain("netuid");
    expect(v.disposition).toBe("merged");
    expect(v.summary).toBeNull();
    expect(v.reason).toBeNull();
  });

  it("HOLDS (never merges) an entry whose fetched evidence corroborates nothing — the #8908 gap", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>welcome</p>"), [SOURCE]: html("<p>an unrelated project</p>") }),
    });
    expect(v.grounding.outcome).toBe("fail");
    expect(v.disposition).toBe("manual-review");
    expect(v.reason).toBe(GROUNDING_UNCONFIRMED_REASON);
    expect(v.summary).toContain("does not corroborate");
  });

  it("holds as INCONCLUSIVE — distinctly from a fail — when the source URL cannot be fetched", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: "throw" }),
    });
    expect(v.grounding.outcome).toBe("inconclusive");
    expect(v.disposition).toBe("manual-review");
    // The whole point of the tri-state: "we could not check" must never render as "we checked and disliked it".
    expect(v.reason).toBe(GROUNDING_INCONCLUSIVE_REASON);
    expect(v.reason).not.toBe(GROUNDING_UNCONFIRMED_REASON);
    expect(v.summary).toContain("Could not verify");
  });

  it("holds as inconclusive when the source URL returns a non-2xx, naming the status", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: res({ status: 503 }) }),
    });
    expect(v.reason).toBe(GROUNDING_INCONCLUSIVE_REASON);
    expect(v.grounding.detail).toContain("HTTP 503");
  });

  it("holds as inconclusive when the entry declares no fetchable source URL at all", async () => {
    const v = await verifySurfaceEntry({ ...groundedEntry, source_url: undefined }, { fetchImpl: routes({ [TARGET]: html("<p>x</p>") }) });
    expect(v.reason).toBe(GROUNDING_INCONCLUSIVE_REASON);
    expect(v.grounding.detail).toContain("probe_url_not_public");
  });

  it("falls back to source_urls[0] when source_url is absent", async () => {
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "website", url: TARGET, source_urls: [SOURCE], public_safe: true },
      { fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: html("<p>netuid 14</p>") }) },
    );
    expect(v.grounding.outcome).toBe("pass");
    expect(v.disposition).toBe("merged");
  });

  it("ignores a non-string source_urls[0] rather than fetching it", async () => {
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "website", url: TARGET, source_urls: [{ url: SOURCE }], public_safe: true },
      { fetchImpl: routes({ [TARGET]: html("<p>x</p>") }) },
    );
    expect(v.reason).toBe(GROUNDING_INCONCLUSIVE_REASON);
  });

  it("REGRESSION (#9490): a netuid claimed only by the TARGET's own page no longer grounds — that was the self-corroboration loop", async () => {
    // Pre-#9490 this exact shape PASSED ("grounds from the TARGET page too"): the submitter's own page
    // asserting its netuid satisfied MIN_STRONG=1 with the independent source contributing nothing. That is
    // an unbacked claim wearing a grounding pass. It now fails (holds for a human), and the sibling test
    // below pins that a source-corroborated netuid still passes.
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>Docs for subnet 14</p>"), [SOURCE]: html("<p>readme</p>") }),
    });
    expect(v.grounding.outcome).toBe("fail");
  });

  it("still grounds a base-layer wss entry from its source alone (the target is not http-fetchable)", async () => {
    const wssEntry = { netuid: 14, kind: "subtensor-wss", url: "wss://chain.example.ai", source_url: SOURCE, public_safe: true };
    const v = await verifySurfaceEntry(wssEntry, { fetchImpl: routes({ [SOURCE]: html("<p>archive for subnet 14</p>") }) });
    expect(v.grounding.outcome).toBe("pass");
    expect(v.functional.outcome).toBe("pass"); // not a functional kind
    expect(v.disposition).toBe("merged");
  });

  it("discounts a cross-domain redirect and says so when that tips grounding below the threshold", async () => {
    // One positive signal (netuid named) minus the cross-origin penalty ⇒ strong 0 ⇒ below the minimum.
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({
        [TARGET]: html("<p>docs</p>"),
        [SOURCE]: res({ status: 302, headers: { location: "https://elsewhere.test/r" } }),
        "https://elsewhere.test/r": html("<p>subnet 14</p>"),
      }),
    });
    expect(v.grounding.outcome).toBe("fail");
    expect(v.grounding.detail).toContain("cross-domain redirect");
    expect(v.reason).toBe(GROUNDING_UNCONFIRMED_REASON);
  });

  it("grounds on the claimed OWNER token alone, and names it", async () => {
    // The source repo's owner ("acme") appears in the evidence; the netuid never does.
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: html("<p>Built and maintained by acme.</p>") }),
    });
    expect(v.grounding.outcome).toBe("pass");
    expect(v.grounding.detail).toBe("corroborated by owner");
    expect(v.disposition).toBe("merged");
  });

  it("grounds on the target HOST being referenced by the source body, and names every signal that fired", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: html("<p>Docs live at sn14.example.ai today.</p>") }),
    });
    expect(v.grounding.outcome).toBe("pass");
    // All three fire here, and deliberately so: the host string "sn14.example.ai" carries the owner token
    // "sn14" AND satisfies netuidGroundingRegex(14) (the "sn"+"14" subnet-slug form it is built to recognize).
    expect(v.grounding.detail).toBe("corroborated by netuid + owner + host");
  });

  it("treats a blank source_url as absent and falls back to source_urls[0]", async () => {
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "website", url: TARGET, source_url: "   ", source_urls: [SOURCE], public_safe: true },
      { fetchImpl: routes({ [TARGET]: html("<p>docs</p>"), [SOURCE]: html("<p>subnet 14</p>") }) },
    );
    expect(v.grounding.outcome).toBe("pass");
  });

  it("pins the shipped threshold at one independent signal", () => {
    expect(SURFACE_GROUNDING_MIN_STRONG).toBe(1);
  });
});

// ── #8909: functional-surface probing is now actually consulted ───────────────────────────────
describe("verifySurfaceEntry — functional probing (#8909)", () => {
  const OPENAPI = "https://api.example.ai/openapi.json";
  const openapiEntry = { netuid: 14, kind: "openapi", url: OPENAPI, source_url: SOURCE, public_safe: true };
  const groundingSource = html("<p>subnet 14 api</p>");

  it("merges an openapi entry whose url really serves a spec", async () => {
    const v = await verifySurfaceEntry(openapiEntry, {
      fetchImpl: routes({ [OPENAPI]: json('{"openapi":"3.0.0","paths":{}}'), [SOURCE]: groundingSource }),
    });
    expect(v.functional.outcome).toBe("pass");
    expect(v.disposition).toBe("merged");
  });

  it("CLOSES an openapi entry whose url serves an HTML page instead — the #8909 gap", async () => {
    const v = await verifySurfaceEntry(openapiEntry, {
      fetchImpl: routes({ [OPENAPI]: html("<h1>We support OpenAPI</h1>"), [SOURCE]: groundingSource }),
    });
    expect(v.functional.outcome).toBe("fail");
    expect(v.disposition).toBe("closed");
    expect(v.reason).toBe(FUNCTIONAL_NOT_SERVED_REASON);
    expect(v.summary).toContain("does not serve the interface");
  });

  it("CLOSES an sse entry that is not an event stream", async () => {
    const SSE = "https://api.example.ai/stream";
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "sse", url: SSE, source_url: SOURCE, public_safe: true },
      { fetchImpl: routes({ [SSE]: json("{}"), [SOURCE]: groundingSource }) },
    );
    expect(v.disposition).toBe("closed");
    expect(v.reason).toBe(FUNCTIONAL_NOT_SERVED_REASON);
  });

  it("merges an sse entry serving text/event-stream", async () => {
    const SSE = "https://api.example.ai/stream";
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "sse", url: SSE, source_url: SOURCE, public_safe: true },
      { fetchImpl: routes({ [SSE]: res({ headers: { "content-type": "text/event-stream" }, body: "data: x" }), [SOURCE]: groundingSource }) },
    );
    expect(v.disposition).toBe("merged");
  });

  it("HOLDS — never closes and never passes — when the functional probe cannot reach the url", async () => {
    const v = await verifySurfaceEntry(openapiEntry, { fetchImpl: routes({ [OPENAPI]: "throw", [SOURCE]: groundingSource }) });
    expect(v.functional.outcome).toBe("inconclusive");
    expect(v.disposition).toBe("manual-review");
    expect(v.reason).toBe(FUNCTIONAL_INCONCLUSIVE_REASON);
    expect(v.summary).toContain("Could not confirm");
  });

  it("holds as inconclusive on a non-2xx, naming the status rather than closing", async () => {
    const v = await verifySurfaceEntry(openapiEntry, { fetchImpl: routes({ [OPENAPI]: res({ status: 502 }), [SOURCE]: groundingSource }) });
    expect(v.reason).toBe(FUNCTIONAL_INCONCLUSIVE_REASON);
    expect(v.functional.detail).toContain("HTTP 502");
  });

  it("holds as inconclusive when the url returns 2xx with an EMPTY body (a json content-type alone proves nothing)", async () => {
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "subnet-api", url: OPENAPI, source_url: SOURCE, public_safe: true },
      { fetchImpl: routes({ [OPENAPI]: json("   "), [SOURCE]: groundingSource }) },
    );
    expect(v.functional.outcome).toBe("inconclusive");
    expect(v.reason).toBe(FUNCTIONAL_INCONCLUSIVE_REASON);
    expect(v.functional.detail).toContain("empty body");
  });

  it("holds as inconclusive when a functional entry's url is not an https URL at all", async () => {
    // Reachable only with sourceUrlValidation disabled upstream; the verifier must not pass an unprobed surface.
    const v = await verifySurfaceEntry(
      { netuid: 14, kind: "openapi", url: "http://api.example.ai/spec", source_url: SOURCE, public_safe: true },
      { fetchImpl: routes({ [SOURCE]: groundingSource }) },
    );
    expect(v.functional.outcome).toBe("inconclusive");
    expect(v.reason).toBe(FUNCTIONAL_INCONCLUSIVE_REASON);
    expect(v.functional.detail).toContain("not a fetchable public HTTPS URL");
  });

  it("skips the probe entirely for a kind that declares no functional surface", async () => {
    const v = await verifySurfaceEntry(groundedEntry, {
      fetchImpl: routes({ [TARGET]: html("<h1>just a website</h1>"), [SOURCE]: html("<p>subnet 14</p>") }),
    });
    expect(v.functional.outcome).toBe("pass");
    expect(v.functional.detail).toContain("n/a");
    expect(v.disposition).toBe("merged");
  });

  it("a confirmed functional failure OUTRANKS an inconclusive grounding check (fail-closed first)", async () => {
    const v = await verifySurfaceEntry(openapiEntry, { fetchImpl: routes({ [OPENAPI]: html("<h1>docs</h1>"), [SOURCE]: "throw" }) });
    expect(v.grounding.outcome).toBe("inconclusive");
    expect(v.disposition).toBe("closed");
    expect(v.reason).toBe(FUNCTIONAL_NOT_SERVED_REASON);
  });

  it("an inconclusive functional probe outranks a failed grounding check", async () => {
    const v = await verifySurfaceEntry(openapiEntry, {
      fetchImpl: routes({ [OPENAPI]: "throw", [SOURCE]: html("<p>unrelated</p>") }),
    });
    expect(v.grounding.outcome).toBe("fail");
    expect(v.disposition).toBe("manual-review");
    expect(v.reason).toBe(FUNCTIONAL_INCONCLUSIVE_REASON);
  });
});

describe("makeSurfaceEntryVerifier", () => {
  it("returns null (the static merged assessment stands) for a clean entry", async () => {
    const verify = makeSurfaceEntryVerifier({ fetchImpl: routes({ [TARGET]: html("<p>x</p>"), [SOURCE]: html("<p>subnet 14</p>") }) });
    expect(await verify(groundedEntry)).toBeNull();
  });

  it("returns an overriding manual-review assessment for an unverified entry", async () => {
    const verify = makeSurfaceEntryVerifier({ fetchImpl: routes({ [TARGET]: html("<p>x</p>"), [SOURCE]: html("<p>nothing</p>") }) });
    const assessment = await verify(groundedEntry);
    expect(assessment?.verdict).toBe("manual-review");
    expect(assessment?.reason).toBe(GROUNDING_UNCONFIRMED_REASON);
    expect(assessment?.candidate).toEqual(groundedEntry);
  });

  it("returns an overriding closed assessment for a functional surface that is not served", async () => {
    const OPENAPI = "https://api.example.ai/openapi.json";
    const verify = makeSurfaceEntryVerifier({ fetchImpl: routes({ [OPENAPI]: html("<h1>hi</h1>"), [SOURCE]: html("<p>subnet 14</p>") }) });
    const assessment = await verify({ netuid: 14, kind: "openapi", url: OPENAPI, source_url: SOURCE, public_safe: true });
    expect(assessment?.verdict).toBe("closed");
    expect(assessment?.reason).toBe(FUNCTIONAL_NOT_SERVED_REASON);
  });

  it("returns null for a non-object entry rather than fetching anything", async () => {
    const verify = makeSurfaceEntryVerifier({ fetchImpl: routes({}) });
    expect(await verify(null)).toBeNull();
    expect(await verify("nope")).toBeNull();
  });
});
