// Units for the shared binary extension inventory. Keeps asset-weight and provenance parity testable in one place.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BINARY_EXT_RE,
  BINARY_FILE_EXTENSIONS,
  isBinaryFileExtension,
} from "../dist/analyzers/binary-extensions.js";

test("isBinaryFileExtension and BINARY_EXT_RE agree on known binary paths", () => {
  for (const path of [
    "assets/logo.png",
    "cache/model.zst",
    "dist/bundle.tar.br",
    "snapshots/data.lz4",
    "models/weights.safetensors",
    "models/llama.gguf",
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
    "native/mod.pyd",
    "build/Release/addon.node",
  ]) {
    const ext = path.slice(path.lastIndexOf(".") + 1);
    assert.equal(isBinaryFileExtension(ext), true, path);
    assert.equal(BINARY_EXT_RE.test(path), true, path);
  }
});

test("isBinaryFileExtension is case-insensitive", () => {
  assert.equal(isBinaryFileExtension("PNG"), true);
  assert.equal(isBinaryFileExtension("Parquet"), true);
  assert.equal(BINARY_EXT_RE.test("data/TRAIN.H5"), true);
});

test("isBinaryFileExtension rejects text and extensionless paths", () => {
  for (const path of [
    "src/index.ts",
    "icons/logo.svg",
    "data/config.json",
    "Makefile",
    "src/parquet.ts",
    "lib/npy_utils.py",
  ]) {
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot + 1) : "";
    if (ext) assert.equal(isBinaryFileExtension(ext), false, path);
    assert.equal(BINARY_EXT_RE.test(path), false, path);
  }
});

test("BINARY_FILE_EXTENSIONS includes ML checkpoint and scientific data formats", () => {
  for (const ext of [
    "safetensors",
    "gguf",
    "onnx",
    "h5",
    "hdf5",
    "parquet",
    "feather",
    "arrow",
    "orc",
    "msgpack",
    "lz4",
    "br",
  ]) {
    assert.ok(BINARY_FILE_EXTENSIONS.includes(ext), ext);
  }
});
