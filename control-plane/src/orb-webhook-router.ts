// Request-time routing of incoming GitHub webhook deliveries to the correct hosted ORB tenant's container
// (#7181, part of #7173's shared control-plane). ORB's central GitHub App delivers every installation's
// webhooks to ONE configured URL -- self-host has exactly one deployment per installation already, so nothing
// routes there today; a hosted, multi-tenant fleet needs this thin layer in front of it to find which
// container an incoming delivery actually belongs to. Verification/parsing/dispatch all happen HERE (this
// service has no D1 of its own, unlike the main app's src/orb/webhook.ts -- see http-app.ts's own header
// comment on why credentials/state live in this Worker's KV registry instead of the main app's database), then
// the verified, unmodified request is proxied straight through to that tenant's own container, which runs the
// SAME self-host webhook-handling code unmodified and re-verifies independently -- this layer changes WHERE a
// webhook gets dispatched, not how it's authenticated (mirrors the main app's own handleOrbWebhook contract).
import type { Product } from "./tenant-provisioning-driver.js";
import type { TenantRegistry } from "./tenant-registry.js";

/** The slice of a real Container DO's RPC surface this module actually calls -- a SEPARATE small local
 *  interface from container-driver.ts's `ContainerStubLike` (that one starts/stops/tracks provisioning; this
 *  one only proxies an HTTP request) and ams-wake.ts's `WakeStubLike` (that one starts a one-shot CLI run and
 *  polls for completion; ORB's container is a persistent HTTP server, so a plain `fetch()` is enough --
 *  @cloudflare/containers' `Container.fetch()` already starts the container if it's asleep and waits for its
 *  `defaultPort` to be ready before resolving, so "wake if asleep" needs no extra code here). Mirrors this
 *  package's established "local interface, no SDK import" convention. */
export type RouterStubLike = {
  fetch(request: Request): Promise<Response>;
};

export type RouterNamespaceLike = {
  getByName(name: string): RouterStubLike;
};

export type OrbWebhookRouterConfig = {
  binding: RouterNamespaceLike;
  registry: TenantRegistry;
  /** The hosted fleet's own GitHub App webhook secret -- a control-plane Worker secret, independent of the
   *  main app's `ORB_GITHUB_WEBHOOK_SECRET` (a different physical service, same verification shape). Absent/
   *  blank ⇒ every delivery fails closed with 401, matching http-app.ts's own `adminToken` convention and the
   *  main app's own "inert until the secret is injected" comment on this exact check. */
  webhookSecret: string | undefined;
};

/** Same `${product}:${name}` composite container-driver.ts's own `instanceNameFor` derives -- duplicated (not
 *  imported) for the same reason ams-wake.ts's own copy is: this module has no `TenantProvisioningRequest` to
 *  construct, just a name/product pair already in hand from the registry lookup below. */
function instanceNameFor(name: string, product: Product): string {
  return `${product}:${name}`;
}

/** Verifies a GitHub webhook's `x-hub-signature-256` HMAC-SHA256 against the raw request body -- the exact
 *  same algorithm as the main app's `src/utils/crypto.ts#verifyGitHubSignature` (this package can't import
 *  that file; it's a separate workspace with no dependency on the main app), duplicated locally rather than
 *  published as a shared package purely for this one call site. Timing-safe comparison so a malformed/invalid
 *  signature can't leak byte-by-byte match information through response-time differences. */
async function verifyGitHubSignature(rawBody: string, signatureHeader: string | null, secret: string | undefined): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  if (!secret) return false;

  const expectedHex = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));

  // `actualBytes` comes straight from our own HMAC computation -- always a well-formed byte array, never in
  // need of the malformed-hex handling `hexToBytes` exists for. Only `expectedHex` (attacker-controlled, off
  // the request header) can ever be malformed, so it's the only side parsed through that nullable path.
  return timingSafeEqualBytes(new Uint8Array(signature), expectedHex);
}

function timingSafeEqualBytes(actualBytes: Uint8Array, expectedHex: string): boolean {
  const expectedBytes = hexToBytes(expectedHex);
  if (!expectedBytes || actualBytes.length !== expectedBytes.length) return false;
  let result = 0;
  for (let index = 0; index < actualBytes.length; index += 1) result |= actualBytes[index]! ^ expectedBytes[index]!;
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

/** Routes one incoming webhook `Request` to its owning ORB tenant's container, or answers an error itself if
 *  it can't. `request` is consumed for signature verification (its raw body text) but a `.clone()` taken
 *  BEFORE that read is what actually gets forwarded -- the tenant's container re-verifies the same signature
 *  against the same untouched body, so a body-reconstruction bug here can't silently diverge from what GitHub
 *  actually signed. */
export async function routeOrbWebhook(config: OrbWebhookRouterConfig, request: Request): Promise<Response> {
  const forwardRequest = request.clone();
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  const verified = await verifyGitHubSignature(rawBody, signature, config.webhookSecret);
  if (!verified) return Response.json({ error: "invalid_signature" }, { status: 401 });

  let payload: { installation?: { id?: unknown } };
  try {
    payload = JSON.parse(rawBody) as { installation?: { id?: unknown } };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const installationId = payload.installation?.id;
  if (typeof installationId !== "number") {
    return Response.json({ error: "missing_installation_id" }, { status: 400 });
  }

  const record = await config.registry.getByOrbInstallationId(installationId);
  if (!record || record.product !== "orb" || record.state !== "active") {
    return Response.json({ error: "unknown_installation" }, { status: 404 });
  }

  try {
    const stub = config.binding.getByName(instanceNameFor(record.tenant.name, record.product));
    // Cloudflare's own `Request<Cf, ...>` generic (carrying edge metadata this module never reads) infers
    // differently between Hono's `c.req.raw` and `@cloudflare/containers`' own `Container.fetch` signature
    // under `cf:typecheck`'s real workers-types -- a structural, not a runtime, mismatch; the cast is scoped to
    // exactly this one boundary, same "local interface, no SDK type import" posture as ContainerStubLike's own
    // header comment describes for the rest of this package.
    return await stub.fetch(forwardRequest as unknown as Request);
  } catch {
    return Response.json({ error: "container_unreachable" }, { status: 502 });
  }
}
