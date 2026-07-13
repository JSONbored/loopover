// Self-host blob store (#10). A minimal R2Bucket-compatible store backed by the local filesystem — the persistence
// the visual-review screenshot path (src/review/visual/capture.ts + the /loopover/shot serve route) reads/writes
// through `env.REVIEW_AUDIT`. The cloud uses the Cloudflare R2 binding; self-host has none, so visual captures
// previously could not be cached/persisted (they degraded to on-demand re-render). This implements only the get/put
// surface those two paths use; every other R2Bucket method is unused on self-host. Node-only (fs import never
// reaches the Worker bundle — wired in server.ts behind REVIEW_AUDIT_DIR). MODULAR + off by default: unset
// REVIEW_AUDIT_DIR ⇒ no REVIEW_AUDIT binding ⇒ captures degrade to on-demand exactly as before.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/** Build a filesystem-backed REVIEW_AUDIT store rooted at `baseDir`. Keys are app-generated
 *  (`loopover/shots/<hash>.png`) and the serve route already prefix-checks + rejects `..`, but the path is
 *  resolved + boundary-checked here too so a key can never escape the base directory. */
export function createFsBlobStore(baseDir: string): R2Bucket {
  const base = resolve(baseDir);
  const pathFor = (key: string): string => {
    const full = resolve(base, key.replace(/^[/\\]+/, "")); // strip any leading slash so the key stays relative
    if (!full.startsWith(base + sep)) throw new Error("blob key escapes base dir");
    return full;
  };
  const store = {
    /** Stream a stored object's bytes, or null on a miss (ENOENT / unreadable). The serve route reads `.body`. */
    async get(key: string): Promise<R2ObjectBody | null> {
      try {
        const bytes = await readFile(pathFor(key));
        return { body: new Response(bytes).body } as unknown as R2ObjectBody;
      } catch {
        return null;
      }
    },
    /** Persist `value` (the captured PNG) under `key`, creating parent dirs. Accepts any R2 put body type. */
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null): Promise<R2Object> {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(await new Response(value ?? "").arrayBuffer()));
      return { key } as unknown as R2Object;
    },
    /** Remove a stored object. A missing file is not an error (matches R2's own delete-is-idempotent
     *  semantics) -- unlike before this method existed, callers no longer hit a synchronous
     *  "not a function" TypeError (see actions-fallback.ts's dispatch-marker cleanup). */
    async delete(key: string): Promise<void> {
      await rm(pathFor(key), { force: true });
    },
  };
  return store as unknown as R2Bucket;
}
