// Units for the EOL analyzer's version-pin parser (#2097). Kept separate so analyzer PRs avoid collisions.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractVersionPins,
  isDockerfile,
  isRuntimePinPath,
  parseGemfileRubyLine,
  parseRuntimeTxtLine,
  parseToolVersionLine,
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

test("extractVersionPins reads .java-version pins as oracle-jdk", () => {
  // jenv/asdf use `.java-version`; endoflife.date tracks Oracle JDK release cycles.
  assert.deepEqual(extractVersionPins([added(".java-version", "21.0.2")]), [
    { file: ".java-version", product: "oracle-jdk", version: "21.0.2" },
  ]);
});

test("extractVersionPins reads .terraform-version pins as Terraform", () => {
  // tfenv/asdf use `.terraform-version` with the same leading-version format.
  assert.deepEqual(extractVersionPins([added(".terraform-version", "1.5.7")]), [
    { file: ".terraform-version", product: "terraform", version: "1.5.7" },
  ]);
});

test("extractVersionPins reads .swift-version, .perl-version, and .erlang-version pins", () => {
  assert.deepEqual(extractVersionPins([added(".swift-version", "5.9.2")]), [
    { file: ".swift-version", product: "swift", version: "5.9.2" },
  ]);
  assert.deepEqual(extractVersionPins([added(".perl-version", "5.38.0")]), [
    { file: ".perl-version", product: "perl", version: "5.38.0" },
  ]);
  assert.deepEqual(extractVersionPins([added(".erlang-version", "26.2.1")]), [
    { file: ".erlang-version", product: "erlang", version: "26.2.1" },
  ]);
});

test("parseRuntimeTxtLine maps Heroku runtime.txt prefixes to endoflife.date products", () => {
  assert.deepEqual(parseRuntimeTxtLine("python-3.11.6"), {
    product: "python",
    version: "3.11.6",
  });
  assert.deepEqual(parseRuntimeTxtLine("ruby-3.2.2"), {
    product: "ruby",
    version: "3.2.2",
  });
  assert.deepEqual(parseRuntimeTxtLine("nodejs-18.17.0"), {
    product: "nodejs",
    version: "18.17.0",
  });
  assert.deepEqual(parseRuntimeTxtLine("node-20.11.0"), {
    product: "nodejs",
    version: "20.11.0",
  });
  assert.equal(parseRuntimeTxtLine("# python-3.10.0"), null);
  assert.equal(parseRuntimeTxtLine("unknown-1.2.3"), null);
  assert.equal(parseRuntimeTxtLine(""), null);
});

test("extractVersionPins reads Heroku runtime.txt pins from added lines", () => {
  assert.deepEqual(
    extractVersionPins([added("runtime.txt", "python-3.11.6", "# ruby-3.2.2")]),
    [{ file: "runtime.txt", product: "python", version: "3.11.6" }],
  );
});

test("parseGemfileRubyLine maps Bundler ruby directives to Ruby runtime pins", () => {
  assert.deepEqual(parseGemfileRubyLine('ruby "3.2.2"'), {
    product: "ruby",
    version: "3.2.2",
  });
  assert.deepEqual(parseGemfileRubyLine("ruby '~> 3.2.2'"), {
    product: "ruby",
    version: "3.2.2",
  });
  assert.deepEqual(parseGemfileRubyLine('ruby ">= 3.2.0"'), {
    product: "ruby",
    version: "3.2.0",
  });
  assert.equal(parseGemfileRubyLine("# ruby \"2.7.0\""), null);
  assert.equal(parseGemfileRubyLine('source "https://rubygems.org"'), null);
});

test("extractVersionPins reads Gemfile ruby directives from added lines", () => {
  assert.deepEqual(
    extractVersionPins([
      added("Gemfile", 'source "https://rubygems.org"', 'ruby "3.2.2"'),
    ]),
    [{ file: "Gemfile", product: "ruby", version: "3.2.2" }],
  );
});

test("parseToolVersionLine maps swift, perl, and erlang asdf plugin names", () => {
  assert.deepEqual(parseToolVersionLine("swift 5.9.2"), {
    product: "swift",
    version: "5.9.2",
  });
  assert.deepEqual(parseToolVersionLine("perl 5.38.0"), {
    product: "perl",
    version: "5.38.0",
  });
  assert.deepEqual(parseToolVersionLine("erlang 26.2.1"), {
    product: "erlang",
    version: "26.2.1",
  });
});

test("isRuntimePinPath recognizes new pin locations and rejects unrelated paths", () => {
  assert.equal(isRuntimePinPath("runtime.txt"), true);
  assert.equal(isRuntimePinPath("Gemfile"), true);
  assert.equal(isRuntimePinPath(".swift-version"), true);
  assert.equal(isRuntimePinPath(".perl-version"), true);
  assert.equal(isRuntimePinPath(".erlang-version"), true);
  assert.equal(isRuntimePinPath("deploy/runtime.txt"), true);
  assert.equal(isRuntimePinPath("src/app.ts"), false);
  assert.equal(isRuntimePinPath("Gemfile.lock"), false);
});

test("extractVersionPins reads .elixir-version and .kotlin-version pins", () => {
  assert.deepEqual(extractVersionPins([added(".elixir-version", "1.16.2")]), [
    { file: ".elixir-version", product: "elixir", version: "1.16.2" },
  ]);
  assert.deepEqual(extractVersionPins([added(".kotlin-version", "2.0.21")]), [
    { file: ".kotlin-version", product: "kotlin", version: "2.0.21" },
  ]);
});

test("parseToolVersionLine maps asdf plugin names to endoflife.date products", () => {
  assert.deepEqual(parseToolVersionLine("python 3.11.0"), {
    product: "python",
    version: "3.11.0",
  });
  assert.deepEqual(parseToolVersionLine("nodejs 20.11.0"), {
    product: "nodejs",
    version: "20.11.0",
  });
  // Common asdf aliases.
  assert.deepEqual(parseToolVersionLine("node 18.17.0"), {
    product: "nodejs",
    version: "18.17.0",
  });
  assert.deepEqual(parseToolVersionLine("golang 1.22.0"), {
    product: "go",
    version: "1.22.0",
  });
  assert.deepEqual(parseToolVersionLine("java 21.0.2"), {
    product: "oracle-jdk",
    version: "21.0.2",
  });
  // Optional trailing system column is ignored.
  assert.deepEqual(parseToolVersionLine("ruby 3.2.2 linux"), {
    product: "ruby",
    version: "3.2.2",
  });
  // Comments and unknown tools are skipped.
  assert.equal(parseToolVersionLine("# python 3.10.0"), null);
  assert.equal(parseToolVersionLine("unknown-tool 1.2.3"), null);
  assert.equal(parseToolVersionLine(""), null);
});

test("extractVersionPins reads multi-tool .tool-versions pins from added lines", () => {
  assert.deepEqual(
    extractVersionPins([
      added(
        ".tool-versions",
        "python 3.11.0",
        "nodejs 20.11.0",
        "# elixir 1.15.0",
        "terraform 1.5.7",
        "kotlin 2.0.21",
      ),
    ]),
    [
      { file: ".tool-versions", product: "python", version: "3.11.0" },
      { file: ".tool-versions", product: "nodejs", version: "20.11.0" },
      { file: ".tool-versions", product: "terraform", version: "1.5.7" },
      { file: ".tool-versions", product: "kotlin", version: "2.0.21" },
    ],
  );
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
