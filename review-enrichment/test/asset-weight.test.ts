// Units for the asset-weight analyzer's pure helpers (#1506). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isBinaryAsset,
  basePathForGrowth,
  encodeRepoPath,
} from "../dist/analyzers/asset-weight.js";

test("isBinaryAsset flags genuine binary extensions and ignores text/case", () => {
  // Genuine binary assets (image / font / media / archive / native binary).
  for (const p of [
    "ui/logo.png",
    "fonts/Inter.woff2",
    "media/demo.mp4",
    "vendor/lib.wasm",
    "dist/app.zip",
  ]) {
    assert.equal(isBinaryAsset(p), true, p);
  }
  // Apple HEIC/HEIF photos are binary image assets (siblings of webp/avif) — their bytes are not in the textual diff.
  assert.equal(isBinaryAsset("photos/IMG_0001.heic"), true);
  assert.equal(isBinaryAsset("photos/scan.heif"), true);
  assert.equal(isBinaryAsset("photos/IMG_0001.HEIC"), true);
  // Zstandard blobs are binary compressed assets (siblings of gz/bz2/xz) — only the last extension is matched,
  // so a compound `.tar.zst` resolves to `zst`, and the match is case-insensitive.
  assert.equal(isBinaryAsset("cache/model.zst"), true);
  assert.equal(isBinaryAsset("dist/bundle.tar.zst"), true);
  assert.equal(isBinaryAsset("cache/model.ZST"), true);
  // Serialized ML model / checkpoint weight formats are heavy binary blobs (siblings of the other binaries),
  // and the match stays case-insensitive.
  for (const p of [
    "models/llama.safetensors",
    "models/llama.gguf",
    "models/resnet.onnx",
    "models/model.pt",
    "checkpoints/epoch10.pth",
    "checkpoints/state.ckpt",
    "models/LLAMA.SAFETENSORS",
  ]) {
    assert.equal(isBinaryAsset(p), true, p);
  }
  // Scientific / ML data artifacts and additional compression formats from the shared inventory.
  for (const p of [
    "data/train.h5",
    "data/features.hdf5",
    "models/saved_model.pb",
    "data/embeddings.npy",
    "data/batch.npz",
    "warehouse/events.parquet",
    "warehouse/snapshot.feather",
    "lake/part-000.arrow",
    "lake/part-000.orc",
    "wire/msg.msgpack",
    "cache/snapshot.lz4",
    "dist/bundle.br",
    "data/TRAIN.H5",
  ]) {
    assert.equal(isBinaryAsset(p), true, p);
  }
  assert.equal(isBinaryAsset("src/parquet.ts"), false);
  assert.equal(isBinaryAsset("lib/npy_utils.py"), false);
  // Extension match is case-insensitive.
  assert.equal(isBinaryAsset("assets/HERO.PNG"), true);
  // Text formats whose bytes are already in the diff are NOT binary assets.
  for (const p of [
    "icons/logo.svg",
    "data/config.json",
    "src/index.ts",
    "README.md",
  ]) {
    assert.equal(isBinaryAsset(p), false, p);
  }
  // A path with no extension, or a dotfile with no real extension after the dot, is not a binary asset.
  assert.equal(isBinaryAsset("Makefile"), false);
  assert.equal(isBinaryAsset("noext"), false);
});

test("basePathForGrowth resolves the base-side path per file status", () => {
  assert.equal(
    basePathForGrowth({ path: "a.png", status: "modified" }),
    "a.png",
  );
  assert.equal(
    basePathForGrowth({ path: "a.png", status: "changed" }),
    "a.png",
  );
  assert.equal(
    basePathForGrowth({
      path: "new.png",
      previousPath: "old.png",
      status: "renamed",
    }),
    "old.png",
  );
  // A rename with no previousPath has no comparable base.
  assert.equal(basePathForGrowth({ path: "new.png", status: "renamed" }), null);
  // Added/removed files have no base size to grow from.
  assert.equal(basePathForGrowth({ path: "a.png", status: "added" }), null);
  assert.equal(basePathForGrowth({ path: "a.png", status: "removed" }), null);
});

test("encodeRepoPath percent-encodes segments and rejects traversal", () => {
  assert.equal(encodeRepoPath("assets/logo.png"), "assets/logo.png");
  // Spaces and other unsafe characters are percent-encoded per segment (the '/' separators are preserved).
  assert.equal(encodeRepoPath("my assets/a b.png"), "my%20assets/a%20b.png");
  // An empty path, or any empty / "." / ".." segment, is rejected so a crafted path can't traverse the tree.
  assert.equal(encodeRepoPath(""), null);
  assert.equal(encodeRepoPath("a/../b"), null);
  assert.equal(encodeRepoPath("a/./b"), null);
  assert.equal(encodeRepoPath("a//b"), null);
  assert.equal(encodeRepoPath(".."), null);
});
