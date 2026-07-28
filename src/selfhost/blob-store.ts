// Self-host blob store (#10). A minimal R2Bucket-compatible store backed by the local filesystem — the persistence
// the visual-review screenshot path (src/review/visual/capture.ts + the /loopover/shot serve route) reads/writes
// through `env.REVIEW_AUDIT`. The cloud uses the Cloudflare R2 binding; self-host has none, so visual captures
// previously could not be cached/persisted (they degraded to on-demand re-render). This implements only the get/put
// surface those two paths use; every other R2Bucket method is unused on self-host. Node-only (fs import never
// reaches the Worker bundle — wired in server.ts behind REVIEW_AUDIT_DIR). MODULAR + off by default: unset
// REVIEW_AUDIT_DIR ⇒ no REVIEW_AUDIT binding ⇒ captures degrade to on-demand exactly as before.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
    /** Stream a stored object's bytes, or null on a miss (ENOENT / unreadable). The serve route reads `.body`.
     *  A path-traversal key still returns null (safe miss for `/loopover/shot`), but is logged distinctly from
     *  an ordinary miss so probes are visible (#6283) — put/delete keep throwing the same check unguarded. */
    async get(key: string): Promise<R2ObjectBody | null> {
      let path: string;
      try {
        path = pathFor(key);
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "selfhost_blob_key_escapes_base_dir",
            key: typeof key === "string" ? key.slice(0, 200) : String(key).slice(0, 200),
            message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
          }),
        );
        return null;
      }
      try {
        const bytes = await readFile(path);
        return { body: new Response(bytes).body } as unknown as R2ObjectBody;
      } catch {
        return null;
      }
    },
    /** Persist `value` (the captured PNG) under `key`, creating parent dirs. Accepts any R2 put body type. */
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null): Promise<R2Object> {
      const target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      // #9487: write to a unique temp path, then rename. Keys here are INPUT-HASH-ADDRESSED
      // (`loopover/shots/<hash>.png`), so a half-written file from a mid-write kill is never retried or
      // overwritten -- the next lookup for that same input hits it, finds a file, and serves a truncated PNG
      // as a permanently "valid" cache entry. rename(2) is atomic within a filesystem, so a reader sees
      // either no file or the complete one, never a partial. Same tmp+rename the config writer already does
      // (private-config.ts's atomicWriteWithBackup) -- and the temp name carries a UUID so two concurrent
      // puts of the same key cannot clobber each other's in-progress file.
      const tmpTarget = `${target}.tmp-${randomUUID()}`;
      try {
        await writeFile(tmpTarget, Buffer.from(await new Response(value ?? "").arrayBuffer()));
        await rename(tmpTarget, target);
      } catch (error) {
        // Never leave the temp file behind on a failed write -- otherwise a full disk or a mid-write crash
        // accretes orphans in the same directory the real objects live in. Best-effort: the original error is
        // what the caller needs, not a cleanup failure.
        /* v8 ignore next -- the cleanup's own failure arm: `force: true` already swallows ENOENT, so this only
           fires for something like an unwritable directory, in which case the ORIGINAL write error is what the
           caller needs. Unreachable without mocking fs, and mocking it here would test the mock. */
        await rm(tmpTarget, { force: true }).catch(() => undefined);
        throw error;
      }
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
