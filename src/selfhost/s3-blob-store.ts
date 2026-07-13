// Self-host blob store, S3-compatible-bucket-backed variant. A minimal R2Bucket-compatible store (same
// get/put/delete surface as ./blob-store.ts's filesystem-backed one) that talks to an operator's OWN
// S3-compatible bucket -- Cloudflare R2 (https://<account_id>.r2.cloudflarestorage.com, region "auto"), or any
// other S3-compatible provider -- via signed REST calls (AWS SigV4, aws4fetch).
//
// Why this exists: the filesystem-backed store (REVIEW_AUDIT_DIR) persists screenshots on the SAME host that
// runs the review container, so the images embedded in a public GitHub PR comment are only reachable through
// that host's own public origin (PUBLIC_API_ORIGIN) and the /loopover/shot proxy route -- if an operator
// keeps their instance behind a private network (Tailscale, a firewall, no public DNS at all), those images
// are unreachable for anyone outside that network, GitHub's own servers included. Storing in a genuinely
// public bucket instead decouples "does my review pipeline run on my own infrastructure" from "are the
// resulting public-facing images reachable by anyone" -- this store still only does get/put/delete; making the
// resulting keys PUBLICLY SERVABLE (a public r2.dev URL, or a custom domain connected to the bucket) is the
// operator's own one-time bucket setup, and `resolveShotUrl` (capture.ts) is what points served links directly
// at REVIEW_AUDIT_S3_PUBLIC_URL instead of this instance's own /loopover/shot proxy once it's configured.
//
// MODULAR + off by default: unset REVIEW_AUDIT_S3_BUCKET (+ _ENDPOINT/_ACCESS_KEY_ID/_SECRET_ACCESS_KEY) ⇒ no
// REVIEW_AUDIT_S3 binding ⇒ server.ts falls back to REVIEW_AUDIT_DIR (or, if that's unset too, on-demand
// rendering) exactly as before -- see server.ts's REVIEW_AUDIT wiring.
import { AwsClient } from "aws4fetch";

export type S3BlobStoreConfig = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2's S3-compatible API always uses "auto" -- see https://developers.cloudflare.com/r2/api/s3/api/#bucket-region.
   *  Configurable for other S3-compatible providers that expect a real AWS region string. Default "auto". */
  region?: string | undefined;
};

// aws4fetch retries a failed request internally (default: 10 attempts, exponential backoff from
// initRetryMs=50 -- 10 attempts can take 30+ seconds to finally give up). Every call site into this store is
// already best-effort (wrapped in `.catch()` -- a cache miss/write failure just means "re-render instead"),
// so a bounded, fast-failing retry budget matters more here than aws4fetch's own resilience-first default:
// 3 attempts is enough to ride out a genuinely transient blip without risking a multi-second stall in the
// review pipeline over a persistently misconfigured or down bucket.
const S3_CLIENT_RETRIES = 3;

/** Build an S3-compatible-bucket-backed REVIEW_AUDIT store. Keys are app-generated
 *  (`loopover/shots/<hash>.png`, already validated by the /loopover/shot serve route's own prefix +
 *  traversal check) and passed straight through as the S3 object key -- no additional encoding beyond the
 *  URL-path escaping every S3 REST call needs regardless of key shape. */
export function createS3BlobStore(config: S3BlobStoreConfig): R2Bucket {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    retries: S3_CLIENT_RETRIES,
    service: "s3",
    region: config.region ?? "auto",
  });
  const base = config.endpoint.replace(/\/+$/, "");
  const urlFor = (key: string): string => `${base}/${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const store = {
    /** Stream a stored object's bytes, or null on a miss (404) or any request failure. */
    async get(key: string): Promise<R2ObjectBody | null> {
      try {
        const response = await client.fetch(urlFor(key), { method: "GET" });
        if (!response.ok) return null;
        return { body: response.body } as unknown as R2ObjectBody;
      } catch {
        return null;
      }
    },
    /** Persist `value` (the captured PNG/GIF) under `key`. Throws on a non-2xx response or request failure --
     *  every call site already wraps `.put(...)` in `.catch(() => undefined)` (best-effort caching), matching
     *  the filesystem store's own let-it-throw-and-let-the-caller-degrade contract. */
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<R2Object> {
      const body = await new Response(value ?? "").arrayBuffer();
      const headers: Record<string, string> = {};
      if (options?.httpMetadata?.contentType) headers["content-type"] = options.httpMetadata.contentType;
      const response = await client.fetch(urlFor(key), { method: "PUT", headers, body });
      if (!response.ok) throw new Error(`S3 put failed: ${response.status} ${await response.text().catch(() => "")}`);
      return { key } as unknown as R2Object;
    },
    /** Delete a stored object. Best-effort semantics live with the caller (see actions-fallback.ts's dispatch
     *  marker cleanup) -- this itself just reports whether the DELETE request succeeded. */
    async delete(key: string): Promise<void> {
      const response = await client.fetch(urlFor(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`S3 delete failed: ${response.status} ${await response.text().catch(() => "")}`);
      }
    },
  };
  return store as unknown as R2Bucket;
}
