import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFsBlobStore } from "../../src/selfhost/blob-store";

describe("createFsBlobStore (#10 — self-host visual screenshot persistence)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gitt-blob-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a PNG: put then get streams the same bytes back (parent dirs created)", async () => {
    const store = createFsBlobStore(dir);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await store.put("loopover/shots/abc.png", png);
    const obj = await store.get("loopover/shots/abc.png");
    expect(obj).not.toBeNull();
    expect(Array.from(new Uint8Array(await new Response(obj!.body).arrayBuffer()))).toEqual(Array.from(png));
  });

  it("returns null on a miss", async () => {
    expect(await createFsBlobStore(dir).get("loopover/shots/missing.png")).toBeNull();
  });

  it("accepts a string value too (any R2 put body type)", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/s.png", "hello");
    expect(await new Response((await store.get("loopover/shots/s.png"))!.body).text()).toBe("hello");
  });

  it("accepts a null value (stores an empty object), satisfying the R2 put body type", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/empty.png", null);
    expect((await new Response((await store.get("loopover/shots/empty.png"))!.body).arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects a key that escapes the base dir — put throws, get is a safe miss (no traversal)", async () => {
    const store = createFsBlobStore(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(store.put("../escape.png", new Uint8Array([1]))).rejects.toThrow(/escapes base dir/);
      expect(await store.get("../../etc/passwd")).toBeNull(); // the pathFor throw is caught inside get → safe miss
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a path-traversal get distinctly from an ordinary miss (#6283)", async () => {
    const store = createFsBlobStore(dir);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await store.get("loopover/shots/missing.png")).toBeNull();
      expect(warn).not.toHaveBeenCalled();

      expect(await store.get("../../etc/passwd")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(warn.mock.calls[0]?.[0]));
      expect(payload).toMatchObject({
        level: "warn",
        event: "selfhost_blob_key_escapes_base_dir",
        key: "../../etc/passwd",
        message: expect.stringMatching(/escapes base dir/i),
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("delete removes a stored object — a subsequent get is a miss", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/gone.png", new Uint8Array([1, 2, 3]));
    expect(await store.get("loopover/shots/gone.png")).not.toBeNull();
    await store.delete("loopover/shots/gone.png");
    expect(await store.get("loopover/shots/gone.png")).toBeNull();
  });

  it("delete on a key that was never written does not throw (idempotent, matches R2)", async () => {
    await expect(createFsBlobStore(dir).delete("loopover/shots/never-existed.png")).resolves.toBeUndefined();
  });
});

// #9487: keys here are INPUT-HASH-ADDRESSED (`loopover/shots/<hash>.png`), so a half-written file from a
// mid-write kill is never retried or overwritten — the next lookup for that same input finds a file and
// serves a truncated PNG as a permanently "valid" cache entry. tmp+rename makes a reader see either no file
// or the complete one; the config writer (private-config.ts's atomicWriteWithBackup) already did this.
//
// HONEST SCOPE: the primary benefit is crash-safety (SIGKILL between the first and last byte), which cannot
// be simulated in-process — nothing here can kill the writer mid-`writeFile`. These tests pin what IS
// observable: that the mechanism is tmp+rename rather than a direct write, that no temp files survive either
// outcome, and that concurrent writers of one key cannot publish each other's bytes.
describe("atomic writes (#9487)", () => {
  /** A body that yields some bytes and then errors — the shape of a source dying mid-write. */
  const erroringStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x89, 0x50]));
        controller.error(new Error("source died mid-write"));
      },
    });

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gitt-blob-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // The mechanism itself, pinned at the source. A direct `writeFile(target, ...)` is the bug; without this
  // assertion nothing in this file would notice a revert, because the crash window it protects is exactly the
  // part an in-process test cannot reach.
  it("REGRESSION: writes via a unique temp path and renames — never a direct write to the target key", () => {
    const source = readFileSync("src/selfhost/blob-store.ts", "utf8");
    expect(source).toContain("await rename(tmpTarget, target)");
    expect(source).toContain(".tmp-${randomUUID()}");
    expect(source).not.toContain("await writeFile(target,");
  });

  it("INVARIANT: a successful put leaves the object and NO temp leftovers", async () => {
    const store = createFsBlobStore(dir);
    await store.put("loopover/shots/abc.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    expect(readdirSync(join(dir, "loopover", "shots"))).toEqual(["abc.png"]);
  });

  it("INVARIANT: a failed put leaves no object at the key and no temp leftovers", async () => {
    const store = createFsBlobStore(dir);
    await expect(store.put("loopover/shots/broken.png", erroringStream())).rejects.toThrow();

    expect(await store.get("loopover/shots/broken.png")).toBeNull();
    const shotsDir = join(dir, "loopover", "shots");
    expect(existsSync(shotsDir) ? readdirSync(shotsDir) : []).toEqual([]);
  });

  it("INVARIANT: two concurrent puts of the SAME key both complete, and the object is one of them INTACT", async () => {
    // Unique temp names are what make this safe: a shared temp path would let one writer's rename publish the
    // other's partially-written file.
    const store = createFsBlobStore(dir);
    const a = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
    const b = new Uint8Array([2, 2, 2, 2]);
    await Promise.all([store.put("loopover/shots/race.png", a), store.put("loopover/shots/race.png", b)]);

    const obj = await store.get("loopover/shots/race.png");
    const bytes = Array.from(new Uint8Array(await new Response(obj!.body).arrayBuffer()));
    expect([Array.from(a), Array.from(b)]).toContainEqual(bytes); // intact, never interleaved or truncated
    expect(readdirSync(join(dir, "loopover", "shots"))).toEqual(["race.png"]);
  });
});
