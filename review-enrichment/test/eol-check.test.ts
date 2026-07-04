// Units for the EOL analyzer's version-pin parser (#2097). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractVersionPins,
  isDockerfile,
} from "../dist/analyzers/eol-check.js";

function added(path: string, ...lines: string[]) {
  return {
    path,
    patch: [
      "@@ -1 +1," + lines.length + " @@",
      ...lines.map((l) => "+" + l),
    ].join("\n"),
  };
}

test("extractVersionPins reads a Dockerfile FROM tag into (product, leading-version)", () => {
  const pins = extractVersionPins([
    added("Dockerfile", "FROM python:3.8-slim"),
  ]);
  assert.deepEqual(pins, [
    { file: "Dockerfile", product: "python", version: "3.8" },
  ]);
});

test("extractVersionPins maps the node image to nodejs and drops an unknown product", () => {
  const pins = extractVersionPins([
    added("Dockerfile", "FROM node:18.17.0", "FROM mystery:1.2.3"),
  ]);
  assert.deepEqual(pins, [
    { file: "Dockerfile", product: "nodejs", version: "18.17.0" },
  ]);
});

test("extractVersionPins reads .nvmrc and go.mod pins", () => {
  assert.deepEqual(extractVersionPins([added(".nvmrc", "18.17.0")]), [
    { file: ".nvmrc", product: "nodejs", version: "18.17.0" },
  ]);
  assert.deepEqual(extractVersionPins([added("go.mod", "go 1.21")]), [
    { file: "go.mod", product: "go", version: "1.21" },
  ]);
});

test("extractVersionPins reads go.mod toolchain directives", () => {
  // Go 1.21+ `toolchain go1.22.0` pins the toolchain independently of the `go` language line.
  assert.deepEqual(
    extractVersionPins([added("go.mod", "go 1.21", "toolchain go1.22.0")]),
    [
      { file: "go.mod", product: "go", version: "1.21" },
      { file: "go.mod", product: "go", version: "1.22.0" },
    ],
  );
});

test("extractVersionPins reads .node-version pins like .nvmrc", () => {
  // nodenv/asdf use `.node-version` with the same leading-version format as `.nvmrc`.
  assert.deepEqual(extractVersionPins([added(".node-version", "20.11.0")]), [
    { file: ".node-version", product: "nodejs", version: "20.11.0" },
  ]);
});

test("extractVersionPins reads .python-version pins as Python", () => {
  // pyenv/asdf use `.python-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".python-version", "3.11.0")]), [
    { file: ".python-version", product: "python", version: "3.11.0" },
  ]);
});

test("extractVersionPins reads .ruby-version pins as Ruby", () => {
  // rbenv/asdf use `.ruby-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".ruby-version", "3.2.2")]), [
    { file: ".ruby-version", product: "ruby", version: "3.2.2" },
  ]);
});

test("extractVersionPins reads .php-version pins as PHP", () => {
  // phpenv/asdf use `.php-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".php-version", "8.2.0")]), [
    { file: ".php-version", product: "php", version: "8.2.0" },
  ]);
});

test("extractVersionPins reads .go-version pins as Go", () => {
  // goenv/asdf use `.go-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".go-version", "1.22.0")]), [
    { file: ".go-version", product: "go", version: "1.22.0" },
  ]);
});

test("extractVersionPins reads .rust-version pins as Rust", () => {
  // rustup/asdf use `.rust-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".rust-version", "1.75.0")]), [
    { file: ".rust-version", product: "rust", version: "1.75.0" },
  ]);
});

test("extractVersionPins ignores removed/context lines and files with no patch", () => {
  const patch = ["@@ -1 +1,2 @@", "-FROM python:3.7", " FROM python:3.9"].join(
    "\n",
  );
  assert.deepEqual(extractVersionPins([{ path: "Dockerfile", patch }]), []);
  assert.deepEqual(extractVersionPins([{ path: "Dockerfile" }]), []);
});

test("isDockerfile matches the bare name case-insensitively", () => {
  // Docker and case-insensitive filesystems treat `dockerfile` / `DOCKERFILE` as the default Dockerfile;
  // the `*.dockerfile` branch was already case-insensitive, so the bare-name branch must match.
  assert.equal(isDockerfile("Dockerfile"), true);
  assert.equal(isDockerfile("dockerfile"), true);
  assert.equal(isDockerfile("DOCKERFILE"), true);
  assert.equal(isDockerfile("deploy/DOCKERFILE"), true);
  assert.equal(isDockerfile("web.dockerfile"), true);
  assert.equal(isDockerfile("web.Dockerfile"), true);
  assert.equal(isDockerfile("Makefile"), false);
  assert.equal(isDockerfile("NotADockerfile"), false);
});

test("isDockerfile matches suffixed Dockerfile.* variants", () => {
  // Common multi-stage / env-specific names; the prior scheduler gate was `/^Dockerfile(?:\..*)?$/`.
  assert.equal(isDockerfile("Dockerfile.prod"), true);
  assert.equal(isDockerfile("Dockerfile.dev"), true);
  assert.equal(isDockerfile("deploy/Dockerfile.staging"), true);
  assert.equal(isDockerfile("dockerfile.production"), true);
});

test("extractVersionPins reads FROM pins from a lowercase dockerfile path", () => {
  const pins = extractVersionPins([
    added("dockerfile", "FROM python:3.8-slim"),
  ]);
  assert.deepEqual(pins, [
    { file: "dockerfile", product: "python", version: "3.8" },
  ]);
});

test("extractVersionPins reads FROM pins from Dockerfile.prod", () => {
  const pins = extractVersionPins([
    added("Dockerfile.prod", "FROM python:3.8-slim"),
  ]);
  assert.deepEqual(pins, [
    { file: "Dockerfile.prod", product: "python", version: "3.8" },
  ]);
});
