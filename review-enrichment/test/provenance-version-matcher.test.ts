// Units for the provenance analyzer's PyPI distribution-filename matcher and input guard (#2777 area).
// Kept in a separate file so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import { matchesPypiVersion, isSafeToCheck } from "../dist/analyzers/provenance.js";

test("matchesPypiVersion accepts a wheel and both sdist archive extensions at an exact version", () => {
  assert.equal(matchesPypiVersion("requests-2.31.0-py3-none-any.whl", "requests", "2.31.0"), true); // wheel: version + "-"
  assert.equal(matchesPypiVersion("requests-2.31.0.tar.gz", "requests", "2.31.0"), true); // sdist: version + ".tar"
  assert.equal(matchesPypiVersion("requests-2.31.0.zip", "requests", "2.31.0"), true); // sdist: version + ".zip"
});

test("matchesPypiVersion rejects a version that is only a prefix of the filename's version", () => {
  // A post/dev/local suffix is a DIFFERENT release — the version must be followed by a real component boundary.
  assert.equal(matchesPypiVersion("requests-2.31.0.post1-py3-none-any.whl", "requests", "2.31.0"), false);
  assert.equal(matchesPypiVersion("requests-2.31.0.1.tar.gz", "requests", "2.31.0"), false);
  // ...and a longer numeric version that merely contains the target as a trailing substring must not match.
  assert.equal(matchesPypiVersion("requests-12.31.0.tar.gz", "requests", "2.31.0"), false);
});

test("matchesPypiVersion treats -, _, . in the package name as equivalent (PEP 503) and is case-insensitive", () => {
  assert.equal(matchesPypiVersion("my-pkg-1.0.0.tar.gz", "my_pkg", "1.0.0"), true);
  assert.equal(matchesPypiVersion("my.pkg-1.0.0.tar.gz", "my-pkg", "1.0.0"), true);
  assert.equal(matchesPypiVersion("Requests-2.31.0.tar.gz", "requests", "2.31.0"), true);
  // A local-version segment (with the regex-special "+") is escaped and matched literally.
  assert.equal(matchesPypiVersion("pkg-1.0.0+cpu.tar.gz", "pkg", "1.0.0+cpu"), true);
});

test("matchesPypiVersion requires the package name to anchor at the start of the filename", () => {
  assert.equal(matchesPypiVersion("evil-requests-2.31.0.tar.gz", "requests", "2.31.0"), false);
});

test("isSafeToCheck accepts a normal package/version and rejects unsafe or oversized inputs", () => {
  assert.equal(isSafeToCheck("requests", "2.31.0"), true);
  assert.equal(isSafeToCheck("pkg", "1.0.0-beta.1+build_2"), true);
  // Version must start with a digit and contain only [0-9A-Za-z._+-] — injection/space/leading-letter are rejected.
  assert.equal(isSafeToCheck("pkg", "v2.0"), false);
  assert.equal(isSafeToCheck("pkg", "1.0 0"), false);
  assert.equal(isSafeToCheck("pkg", "1.0;rm -rf"), false);
  assert.equal(isSafeToCheck("pkg", ""), false);
  // Length ceilings (pkg <= 200, version <= 100).
  assert.equal(isSafeToCheck("a".repeat(201), "1.0.0"), false);
  assert.equal(isSafeToCheck("pkg", "1" + "0".repeat(100)), false);
});
