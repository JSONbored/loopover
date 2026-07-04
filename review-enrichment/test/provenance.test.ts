import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyAddedFile } from "../dist/analyzers/provenance.js";

test("classifyAddedFile treats bower_components and jspm_packages as vendored, like node_modules (#2777 parity)", () => {
  // Installed-dependency directories are vendored artifacts, not contributor source. Before this, a committed
  // bower/jspm tree fell through to null (ordinary source) while node_modules/vendor were already caught.
  for (const path of [
    "bower_components/jquery/dist/jquery.js",
    "web/bower_components/angular/angular.js",
    "jspm_packages/npm/lodash@4.17.21/lodash.js",
    "frontend/jspm_packages/github/x.js",
  ]) {
    assert.equal(classifyAddedFile(path), "vendored", path);
  }
  // Existing vendored directories still classify (control).
  for (const path of ["node_modules/x/index.js", "vendor/foo.rb", "third_party/lib.c", "third-party/lib.c", "vendors/a.js"]) {
    assert.equal(classifyAddedFile(path), "vendored", path);
  }
  // Directory-segment anchored: a source file merely NAMED like the dir is not vendored; plain source is null.
  assert.equal(classifyAddedFile("src/bower_components.ts"), null);
  assert.equal(classifyAddedFile("src/app.ts"), null);
});

test("classifyAddedFile flags prebuilt native-addon binaries (.node/.pyd) as binary artifacts", () => {
  // Compiled Node native addons and Windows Python extension DLLs are unauditable prebuilt binaries — the
  // same category as the exe/dll/so/wasm entries already flagged. A committed `*.node` fell through to null.
  for (const path of ["build/Release/bcrypt_lib.node", "prebuilds/darwin-x64/foo.node", "native/mod.pyd"]) {
    assert.equal(classifyAddedFile(path), "binary", path);
  }
  // Extension is `$`-anchored: a source file merely named like one is still ordinary source (null).
  assert.equal(classifyAddedFile("src/node.ts"), null);
  assert.equal(classifyAddedFile("app/foo.node.js"), null);
});

test("classifyAddedFile flags committed ML checkpoint files as binary artifacts", () => {
  // Serialized model weights are unauditable prebuilt blobs — the same category asset-weight.ts flags for
  // size bloat. A committed checkpoint must ship with reproducible training source, not as opaque binary.
  for (const path of [
    "models/llama/model.gguf",
    "weights/model.safetensors",
    "export/model.onnx",
    "checkpoints/epoch_3.pt",
    "checkpoints/best.pth",
    "checkpoints/final.ckpt",
  ]) {
    assert.equal(classifyAddedFile(path), "binary", path);
  }
  // Extension is `$`-anchored: source files merely named like a checkpoint stay ordinary source.
  assert.equal(classifyAddedFile("src/model.pt.ts"), null);
  assert.equal(classifyAddedFile("lib/onnx.ts"), null);
});
