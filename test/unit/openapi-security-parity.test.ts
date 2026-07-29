// The published security stanzas must describe what the app actually enforces (#9531).
//
// This replaces `isProtectedPath`, which was a SECOND model of the same policy living in the spec
// builder -- a path-prefix approximation that treated every `/v1/*` route as protected bar a short
// literal list. It had already drifted from the real gate: the whole `/v1/public/decision-ledger/*`
// family answers 200 to an anonymous caller and was published as requiring a bearer.
//
// There is now one model (src/auth/route-auth.ts) that both the middleware and the document read.
// These tests guard the two ways that can still go wrong: a route whose declared stanza contradicts
// the gate, and the gate quietly changing which routes are open.
import { describe, expect, it } from "vitest";
import { buildOpenApiSpec } from "../../src/openapi/spec";
import { requiresApiToken } from "../../src/auth/route-auth";

type Operation = { security?: Array<Record<string, string[]>>; responses?: Record<string, unknown> };

function operations(): Array<{ path: string; method: string; operation: Operation }> {
  const spec = buildOpenApiSpec();
  const rows: Array<{ path: string; method: string; operation: Operation }> = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = (item as Record<string, unknown>)[method] as Operation | undefined;
      if (operation) rows.push({ path, method, operation });
    }
  }
  return rows;
}

/** The document writes `{param}`; the gate matches a concrete path. */
const concrete = (path: string): string => path.replace(/\{[^}]+\}/g, "_");

describe("OpenAPI security parity with the real gate (#9531)", () => {
  // `requiresApiToken` is ONE gate, not the only one, and reading it as "needs no credential at all"
  // is the mistake this test originally made -- twice. Four route families are exempt from it
  // precisely because they carry their own credential:
  //
  //   - `/v1/internal/*`, gated by its own INTERNAL_JOB_TOKEN middleware (`app.use("/v1/internal/*")`);
  //   - the ORB ingress, presenting an ORB-issued bearer;
  //   - the ORB webhook, verified by a body signature;
  //   - `POST /v1/auth/github/token`, gated IN THE HANDLER on a browser session (it 403s a
  //     bearer-only caller), which is why it declares LoopOverSessionCookie alone.
  //
  // Naming the actual scheme is more accurate than silence in every one of those cases, so what
  // this hunts is narrower: a route with no gate of any kind still advertising a credential.
  const SELF_GATED_SCHEMES = ["OrbBearer", "OrbWebhookSignature", "LoopOverSessionCookie"];
  const selfGated = (path: string, operation: Operation): boolean =>
    path.startsWith("/v1/internal/") ||
    // A session-cookie-ONLY stanza means handler-gated; the generic bearer+cookie PAIR is what the
    // legacy fill-in emits, and that is the thing worth catching on an ungated route.
    (operation.security?.length === 1 && SELF_GATED_SCHEMES.some((scheme) => scheme in operation.security![0]!));

  it("never advertises a credential requirement on a route no gate protects", () => {
    const contradictions = operations()
      .filter(({ path, operation }) => !requiresApiToken(concrete(path)) && !selfGated(path, operation) && (operation.security?.length ?? 0) > 0)
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`);
    expect(contradictions).toEqual([]);
  });

  it("never publishes a gated route as needing no credential", () => {
    const silent = operations()
      .filter(({ path, operation }) => requiresApiToken(concrete(path)) && operation.security !== undefined && operation.security.length === 0)
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`);
    expect(silent).toEqual([]);
  });

  it("never declares a 401 while stating no credential at all (#9707)", () => {
    // The class both assertions above are blind to: they filter on `operation.security` being PRESENT, so
    // an ABSENT stanza satisfies neither. `[]` and undefined are not the same claim -- `[]` is OpenAPI's
    // explicit "this operation needs no credential", undefined is "not stated" -- and an operation that
    // publishes a 401 while saying nothing leaves a generated client with no credential to send and a
    // reader unable to tell it apart from a genuinely open route.
    const silent = operations()
      .filter(({ operation }) => operation.responses?.["401"] !== undefined && operation.security === undefined)
      .map(({ path, method }) => `${method.toUpperCase()} ${path}`);
    expect(silent).toEqual([]);
  });

  it("names the header the webhook handlers actually read (#9707)", () => {
    // This published `x-loopover-signature`, a string that appears nowhere else in src/. Both handlers
    // read `x-hub-signature-256`, so a client generated from the document signed the right body and sent
    // it under a header the server never looks at.
    const document = buildOpenApiSpec() as { components?: { securitySchemes?: Record<string, { name?: string }> } };
    expect(document.components?.securitySchemes?.OrbWebhookSignature?.name).toBe("x-hub-signature-256");
  });

  it("distinguishes the auth levels rather than collapsing them to one stanza", () => {
    // The defect this replaced: every operation emitted the same LoopOverBearer+SessionCookie pair,
    // so the document could not tell a caller which routes need nothing, which need an internal
    // token, and which need the ORB's own credential.
    const shapes = new Set(operations().map(({ operation }) => JSON.stringify(operation.security ?? null)));
    expect(shapes.size).toBeGreaterThan(3);
    expect(shapes).toContain(JSON.stringify([]));
    expect(shapes).toContain(JSON.stringify([{ OrbBearer: [] }]));
    expect(shapes).toContain(JSON.stringify([{ LoopOverBearer: [] }]));
  });

  it("declares every security scheme it references", () => {
    const spec = buildOpenApiSpec();
    const declared = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
    const referenced = new Set(operations().flatMap(({ operation }) => (operation.security ?? []).flatMap((entry) => Object.keys(entry))));
    expect([...referenced].filter((name) => !declared.has(name))).toEqual([]);
  });
});
