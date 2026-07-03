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
