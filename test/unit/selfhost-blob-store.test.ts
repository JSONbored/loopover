import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsBlobStore } from "../../src/selfhost/blob-store";

describe("createFsBlobStore (#10 — self-host visual screenshot persistence)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "gitt-blob-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a PNG: put then get streams the same bytes back (parent dirs created)", async () => {
    const store = createFsBlobStore(dir);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await store.put("gittensory/shots/abc.png", png);
    const obj = await store.get("gittensory/shots/abc.png");
    expect(obj).not.toBeNull();
    expect(Array.from(new Uint8Array(await new Response(obj!.body).arrayBuffer()))).toEqual(Array.from(png));
  });

  it("returns null on a miss", async () => {
    expect(await createFsBlobStore(dir).get("gittensory/shots/missing.png")).toBeNull();
  });

  it("accepts a string value too (any R2 put body type)", async () => {
    const store = createFsBlobStore(dir);
    await store.put("gittensory/shots/s.png", "hello");
    expect(await new Response((await store.get("gittensory/shots/s.png"))!.body).text()).toBe("hello");
  });

  it("accepts a null value (stores an empty object), satisfying the R2 put body type", async () => {
    const store = createFsBlobStore(dir);
    await store.put("gittensory/shots/empty.png", null);
    expect((await new Response((await store.get("gittensory/shots/empty.png"))!.body).arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects a key that escapes the base dir — put throws, get is a safe miss (no traversal)", async () => {
    const store = createFsBlobStore(dir);
    await expect(store.put("../escape.png", new Uint8Array([1]))).rejects.toThrow(/escapes base dir/);
    expect(await store.get("../../etc/passwd")).toBeNull(); // the pathFor throw is caught inside get → safe miss
  });
});
