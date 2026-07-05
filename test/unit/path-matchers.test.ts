import { describe, expect, it } from "vitest";
import {
  classifyChangedFile,
  isDependencyManifestFile,
  isConfigFile,
  isDocsFile,
  isGeneratedFile,
  isLockfile,
  isMinifiedFile,
  isNonSubstantivePaddingFile,
  isVendoredFile,
} from "../../src/signals/path-matchers";

describe("isGeneratedFile", () => {
  it("matches generated output by directory, suffix, codegen, and source maps", () => {
    for (const path of [
      "src/__generated__/schema.ts",
      "app/generated/client.ts",
      "src/api.generated.ts",
      "src/types.gen.ts",
      "proto/service.pb.go",
      "proto/service.pb.ts",
      "gen/service_pb2.py",
      "gen/service_pb2.pyi",
      "lib/models.g.dart",
      "dist/app.js.map",
      "styles/site.css.map",
      "worker-configuration.d.ts",
      "C:\\repo\\src\\api.generated.ts",
    ]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
  });

  it("does not match hand-authored files that merely contain the word", () => {
    for (const path of ["src/generated-helpers.ts", "src/regenerated.ts", "src/codegen.ts", "src/app.ts"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
  });

  it("matches source maps for JS/TS, MDX, HTML, SVG, WASM, Sass/SCSS/Less, and front-end framework extensions", () => {
    // `.mjs`/`.cjs` are recognized code extensions (isCodeFile), so their bundlers' source
    // maps are generated output too — the same as `.js.map` / `.tsx.map`.
    for (const path of [
      "dist/bundle.mjs.map",
      "dist/bundle.cjs.map",
      "lib/index.jsx.map",
      "dist/loader.mts.map",
      "dist/setup.cts.map",
      "dist/App.vue.map",
      "dist/Card.svelte.map",
      "dist/page.astro.map",
      "dist/page.mdx.map",
      "dist/styles.scss.map",
      "dist/theme.sass.map",
      "dist/theme.less.map",
      "dist/index.html.map",
      "dist/icon.svg.map",
      "dist/pkg.wasm.map",
    ]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    expect(classifyChangedFile("dist/pkg.wasm.map")).toBe("generated");
  });

  it("matches C++ protobuf output alongside the Go/TS/JS plugins", () => {
    for (const path of ["proto/service.pb.cc", "proto/service.pb.h", "gen/messages.pb.cc"]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    // The `.pb` infix keeps hand-written headers/sources from matching.
    for (const path of ["src/service.h", "include/foo.h", "src/service.cc"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
  });

  it("matches Python gRPC protobuf stubs alongside the message stubs", () => {
    for (const path of ["gen/service_pb2_grpc.py", "gen/service_pb2_grpc.pyi"]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
  });

  it("matches Ruby, PHP, Rust, Elixir, and Swift gRPC protobuf stubs alongside the other protoc plugins", () => {
    for (const path of [
      "gen/service_pb.rb",
      "gen/service_services_pb.rb",
      "gen/service_pb.php",
      "gen/service_grpc_pb.php",
      "proto/messages.pb.rs",
      "lib/my_proto.pb.ex",
      "proto/service.grpc.swift",
    ]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    for (const path of ["lib/service.rb", "src/api.php", "src/main.rs", "lib/my_app.ex"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
    expect(classifyChangedFile("gen/service_grpc_pb.php")).toBe("generated");
    expect(classifyChangedFile("lib/my_proto.pb.ex")).toBe("generated");
    expect(classifyChangedFile("proto/service.grpc.swift")).toBe("generated");
  });

  it("matches Erlang gpb protobuf output alongside the other protoc plugins", () => {
    for (const path of ["proto/messages.pb.erl", "proto/messages.pb.hrl"]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    for (const path of ["src/server.erl", "include/records.hrl"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
    expect(classifyChangedFile("proto/messages.pb.erl")).toBe("generated");
    expect(classifyChangedFile("proto/messages.pb.hrl")).toBe("generated");
  });

  it("matches Crystal protobuf output alongside the other protoc plugins", () => {
    for (const path of ["proto/messages.pb.cr"]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    for (const path of ["src/server.cr"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
    expect(classifyChangedFile("proto/messages.pb.cr")).toBe("generated");
  });

  it("matches Haskell protobuf output alongside the other protoc plugins", () => {
    expect(isGeneratedFile("proto/messages.pb.hs")).toBe(true);
    expect(isGeneratedFile("src/Main.hs")).toBe(false);
    expect(classifyChangedFile("proto/messages.pb.hs")).toBe("generated");
  });

  it("matches Nim protobuf output alongside the other protoc plugins", () => {
    expect(isGeneratedFile("gen/service_pb.nim")).toBe(true);
    expect(isGeneratedFile("src/main.nim")).toBe(false);
    expect(classifyChangedFile("gen/service_pb.nim")).toBe("generated");
  });

  it("matches Lua protobuf output alongside the other protoc plugins", () => {
    expect(isGeneratedFile("gen/service_pb.lua")).toBe(true);
    expect(isGeneratedFile("src/main.lua")).toBe(false);
    expect(classifyChangedFile("gen/service_pb.lua")).toBe("generated");
  });

  it("matches Swift protobuf, Dart freezed/retrofit, C# designer/XAML, and Objective-C protoc output", () => {
    for (const path of [
      "proto/messages.pb.swift",
      "proto/messages.pb.dart",
      "proto/messages.pb.kt",
      "proto/messages.pb.cs",
      "proto/messages.pbobjc.h",
      "proto/messages.pbobjc.m",
      "proto/messages.pbrpc.h",
      "proto/messages.pbrpc.m",
      "lib/user.freezed.dart",
      "lib/api_client.gr.dart",
      "ui/MainForm.Designer.cs",
      "views/App.g.cs",
    ]) {
      expect(isGeneratedFile(path)).toBe(true);
    }
    // hand-written siblings must NOT match (the codegen infix is required).
    for (const path of ["src/MainForm.cs", "lib/user.dart", "src/service.kt", "net/message.swift", "src/App.h", "src/App.m"]) {
      expect(isGeneratedFile(path)).toBe(false);
    }
  });
});

describe("isVendoredFile", () => {
  it("matches vendored / third-party directories", () => {
    for (const path of [
      "vendor/lib.go",
      "vendored/x.js",
      "third_party/y.py",
      "third-party/z.ts",
      "node_modules/pkg/index.js",
      "bower_components/jquery/dist/jquery.js", // Bower
      "jspm_packages/npm/lodash/index.js", // JSPM
    ]) {
      expect(isVendoredFile(path)).toBe(true);
    }
  });

  it("does not match files that only resemble vendor names", () => {
    for (const path of ["src/vendor.ts", "src/vendoring.ts"]) {
      expect(isVendoredFile(path)).toBe(false);
    }
  });
});

describe("isLockfile", () => {
  it("matches known lockfiles regardless of directory or case", () => {
    for (const path of [
      "package-lock.json",
      "frontend/yarn.lock",
      "pnpm-lock.yaml",
      "Cargo.lock",
      "go.sum",
      "go.work.sum",
      "uv.lock",
      "poetry.lock",
      "bun.lock",
      "deno.lock",
      "pubspec.lock",
      "Podfile.lock",
      "mix.lock",
      "Package.resolved",
      "gradle.lockfile",
      "pdm.lock",
      "conan.lock",
      "pixi.lock",
      "Cartfile.resolved",
      "ios/Cartfile.resolved",
      "Gopkg.lock",
      "shard.lock",
      "rebar.lock",
      "renv.lock",
      "charts/app/Chart.lock",
    ]) {
      expect(isLockfile(path)).toBe(true);
    }
  });

  it("does not match dependency manifests or other json", () => {
    for (const path of ["package.json", "tsconfig.json", "data/values.json"]) {
      expect(isLockfile(path)).toBe(false);
    }
  });
});

describe("isMinifiedFile", () => {
  it("matches minified bundles", () => {
    for (const path of ["dist/app.min.js", "public/styles.min.css", "vendor/lib.min.mjs"]) {
      expect(isMinifiedFile(path)).toBe(true);
    }
  });

  it("does not match unminified files", () => {
    for (const path of ["src/app.js", "src/minify.ts", "src/app.minify.js"]) {
      expect(isMinifiedFile(path)).toBe(false);
    }
  });
});

describe("isDocsFile", () => {
  it("matches docs by extension or a docs directory", () => {
    for (const path of ["README.md", "guide.mdx", "notes.rst", "manual.adoc", "docs/architecture.ts", "doc/legacy.md"]) {
      expect(isDocsFile(path)).toBe(true);
    }
  });

  it("does not match source, config, or extensionless files outside docs", () => {
    for (const path of ["src/app.ts", "config.json", "notes.txt", "LICENSE", ".gitignore"]) {
      expect(isDocsFile(path)).toBe(false);
    }
  });
});

describe("defensive input handling", () => {
  it("treats null/undefined paths as non-matching, uncategorized input", () => {
    for (const path of [null, undefined] as unknown as string[]) {
      expect(isLockfile(path)).toBe(false);
      expect(isGeneratedFile(path)).toBe(false);
      expect(classifyChangedFile(path)).toBe("other");
    }
  });
});

describe("isDependencyManifestFile", () => {
  it("matches dependency manifests", () => {
    for (const path of [
      "package.json",
      "Cargo.toml",
      "go.mod",
      "requirements.txt",
      "pyproject.toml",
      "build.gradle.kts",
      "deno.json",
      "apps/web/deno.jsonc",
      "pubspec.yaml",
      "backend/mix.exs",
      "go.work",
      "conanfile.txt",
      "libs/native/conanfile.py",
      "build.sbt",
      "setup.py",
      "packages/py/setup.cfg",
      "shard.yml",
      "erlang/rebar.config",
      "elm.json",
      "deps.edn",
      "project.clj",
      "conda/environment.yml",
    ]) {
      expect(isDependencyManifestFile(path)).toBe(true);
    }
  });

  it("does not match lockfiles or arbitrary config", () => {
    for (const path of ["package-lock.json", "tsconfig.json"]) {
      expect(isDependencyManifestFile(path)).toBe(false);
    }
  });
});

describe("isNonSubstantivePaddingFile", () => {
  it("flags generated / vendored / minified output as padding", () => {
    for (const path of ["src/api.generated.ts", "vendor/lib.go", "dist/app.min.js"]) {
      expect(isNonSubstantivePaddingFile(path)).toBe(true);
    }
  });

  it("does not flag lockfiles, manifests, docs, tests, or real source as padding", () => {
    for (const path of ["package-lock.json", "package.json", "README.md", "test/unit/app.test.ts", "src/app.ts"]) {
      expect(isNonSubstantivePaddingFile(path)).toBe(false);
    }
  });
});

describe("isConfigFile", () => {
  it("matches config files by exact basename (case-insensitive)", () => {
    for (const path of [
      "Dockerfile",
      "frontend/Makefile",
      ".editorconfig",
      "ci/.nvmrc",
      ".node-version",
      ".npmrc",
      ".python-version",
      ".ruby-version",
    ]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("matches monorepo, linter, and VCS/build config by exact basename", () => {
    for (const path of [
      "turbo.json",
      "nx.json",
      "lerna.json",
      "pnpm-workspace.yaml",
      "biome.json",
      "biome.jsonc",
      "packages/app/.gitignore",
      ".gitattributes",
      "services/api/.dockerignore",
      ".npmignore",
      "libs/ui/.stylelintignore",
      ".vercelignore",
      "charts/app/.helmignore",
      ".gcloudignore",
    ]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("matches Cloudflare Workers deploy config by the wrangler prefix", () => {
    for (const path of ["wrangler.toml", "wrangler.jsonc", "apps/ui/wrangler.vitest.jsonc"]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("does not treat names that merely start with wrangler as config", () => {
    for (const path of ["docs/wranglers-guide.md", "src/wrangler-helpers.ts"]) {
      expect(isConfigFile(path)).toBe(false);
    }
  });

  it("matches automation, toolchain, and hosted CI config files", () => {
    for (const path of [
      "renovate.json",
      ".github/dependabot.yml",
      ".tool-versions",
      "mise.toml",
      "lefthook.yml",
      ".pre-commit-config.yaml",
      ".gitleaks.toml",
      ".codecov.yml",
      ".codecov.yaml",
      "codecov.yml",
      "codecov.yaml",
      "Taskfile.yml",
      "Taskfile.yaml",
      "justfile",
      "deploy/docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
      "docker-compose.override.yml",
      "docker-compose.override.yaml",
      "compose.override.yml",
      "compose.override.yaml",
      "Caddyfile",
      "netlify.toml",
      "vercel.json",
      "railway.json",
      "render.yaml",
      "fly.toml",
      "skaffold.yaml",
      "Earthfile",
      "Procfile",
      ".gitlab-ci.yml",
      "Jenkinsfile",
      "azure-pipelines.yml",
      "buf.yaml",
      "buf.gen.yaml",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      ".circleci/config.yml",
      "native/CMakeLists.txt",
      "libs/core/meson.build",
      "services/api/BUILD.bazel",
      "MODULE.bazel",
    ]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("does not treat source names or doc near-misses as config", () => {
    for (const path of [
      "src/renovate-helpers.ts",
      "docs/dependabot-notes.md",
      "src/compose.ts",
      "docs/codecov.yml.md",
      "docs/docker-compose.yml.md",
      "src/justfile.ts",
      "docs/Jenkinsfile.md",
      "locks/deno.json.lock",
    ]) {
      expect(isConfigFile(path)).toBe(false);
    }
  });

  it("matches config files by known filename prefix", () => {
    for (const path of ["tsconfig.build.json", "vitest.config.ts", ".env.local", ".eslintrc.json", ".prettierrc.js"]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("matches config files by the .config.ext or .rc.ext pattern", () => {
    for (const path of ["babel.config.cjs", "stylelint.config.mjs", "lint-staged.rc.js"]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("matches bare .rc suffix config files", () => {
    for (const path of [".stylelintrc", ".huskyrc", "config/custom.rc"]) {
      expect(isConfigFile(path)).toBe(true);
    }
  });

  it("does not classify source, test, doc, or lockfiles as config", () => {
    for (const path of ["src/app.ts", "README.md", "package.json", "package-lock.json", "test/unit/app.test.ts"]) {
      expect(isConfigFile(path)).toBe(false);
    }
  });
});

describe("classifyChangedFile", () => {
  it("classifies each representative path into its category", () => {
    const cases: Array<[string, ReturnType<typeof classifyChangedFile>]> = [
      ["dist/app.min.js", "minified"],
      ["src/api.generated.ts", "generated"],
      ["gen/service_grpc_pb.php", "generated"],
      ["lib/my_proto.pb.ex", "generated"],
      ["proto/service.grpc.swift", "generated"],
      ["proto/messages.pb.erl", "generated"],
      ["proto/messages.pb.hrl", "generated"],
      ["proto/messages.pb.cr", "generated"],
      ["dist/pkg.wasm.map", "generated"],
      ["proto/messages.pb.hs", "generated"],
      ["gen/service_pb.nim", "generated"],
      ["gen/service_pb.lua", "generated"],
      ["vendor/lib.go", "vendored"],
      ["package-lock.json", "lockfile"],
      ["bun.lock", "lockfile"],
      ["deno.lock", "lockfile"],
      ["pubspec.lock", "lockfile"],
      ["ios/Podfile.lock", "lockfile"],
      ["pdm.lock", "lockfile"],
      ["conan.lock", "lockfile"],
      ["pixi.lock", "lockfile"],
      ["package.json", "dependency_manifest"],
      ["deno.json", "dependency_manifest"],
      ["apps/web/deno.jsonc", "dependency_manifest"],
      ["pubspec.yaml", "dependency_manifest"],
      ["mix.exs", "dependency_manifest"],
      ["go.work", "dependency_manifest"],
      ["MyApp/Package.swift", "dependency_manifest"], // Swift PM manifest (package.resolved lockfile already recognized)
      ["ios/Podfile", "dependency_manifest"], // CocoaPods manifest (Podfile.lock already recognized)
      ["tsconfig.json", "config"],
      ["vitest.config.ts", "config"],
      ["wrangler.jsonc", "config"],
      ["turbo.json", "config"],
      ["renovate.json", "config"],
      ["Taskfile.yml", "config"],
      ["Taskfile.yaml", "config"],
      ["justfile", "config"],
      ["docker-compose.yml", "config"],
      ["docker-compose.yaml", "config"],
      ["compose.yml", "config"],
      ["compose.yaml", "config"],
      ["docker-compose.override.yml", "config"],
      ["compose.override.yaml", "config"],
      ["Caddyfile", "config"],
      ["netlify.toml", "config"],
      ["vercel.json", "config"],
      ["railway.json", "config"],
      ["render.yaml", "config"],
      ["fly.toml", "config"],
      ["skaffold.yaml", "config"],
      ["Earthfile", "config"],
      ["Procfile", "config"],
      ["native/CMakeLists.txt", "config"],
      ["libs/meson.build", "config"],
      ["services/BUILD.bazel", "config"],
      ["MODULE.bazel", "config"],
      [".codecov.yml", "config"],
      ["codecov.yml", "config"],
      ["codecov.yaml", "config"],
      [".gitleaks.toml", "config"],
      ["Jenkinsfile", "config"],
      [".github/workflows/ci.yml", "config"],
      ["test/unit/app.test.ts", "test"],
      ["README.md", "docs"],
      ["src/app.ts", "source"],
      ["src/integration/auth.ts", "source"],
      ["data/values.json", "other"],
    ];
    for (const [path, expected] of cases) {
      expect(classifyChangedFile(path)).toBe(expected);
    }
  });

  it("prioritizes padding categories over config/test/source so they are never counted as effort", () => {
    expect(classifyChangedFile("__generated__/schema.test.ts")).toBe("generated");
    expect(classifyChangedFile("vendor/pkg/index.test.js")).toBe("vendored");
    expect(classifyChangedFile("dist/bundle.min.js")).toBe("minified");
    expect(classifyChangedFile("vendor/tsconfig.json")).toBe("vendored");
  });
});

describe("path normalization (#2109)", () => {
  it("classifies Windows-style backslash paths identically to POSIX paths", () => {
    expect(classifyChangedFile("src\\app.ts")).toBe("source");
    expect(classifyChangedFile("src\\api.generated.ts")).toBe("generated");
    expect(classifyChangedFile("frontend\\yarn.lock")).toBe("lockfile");
    expect(classifyChangedFile("dist\\app.min.js")).toBe("minified");
    expect(classifyChangedFile("C:\\repo\\src\\README.md")).toBe("docs");
  });

  it("classifies mixed-case paths identically (normalize is case-insensitive)", () => {
    expect(classifyChangedFile("Package.json")).toBe("dependency_manifest");
    expect(classifyChangedFile("YARN.LOCK")).toBe("lockfile");
    expect(classifyChangedFile("Dockerfile")).toBe("config");
    expect(classifyChangedFile("APP.MIN.JS")).toBe("minified");
  });

  it("classifies paths with both Windows slashes and mixed case identically", () => {
    expect(classifyChangedFile("src\\Components\\App.TSX")).toBe("source");
    expect(classifyChangedFile("packages\\api\\dist\\bundle.MIN.js")).toBe("minified");
  });

  it("classifies nullish and empty-string paths as 'other' (defensive)", () => {
    expect(classifyChangedFile("")).toBe("other");
    expect(classifyChangedFile(null as unknown as string)).toBe("other");
    expect(classifyChangedFile(undefined as unknown as string)).toBe("other");
  });

  it("isConfigFile handles both nullish short-circuits (base === 'dockerfile' vs base.startsWith prefix)", () => {
    expect(isConfigFile("Dockerfile")).toBe(true);
    expect(isConfigFile("dockerfile")).toBe(true);
    expect(isConfigFile(".env")).toBe(true);
    expect(isConfigFile(".env.local")).toBe(true);
    expect(isConfigFile(".stylelintrc")).toBe(true);
    expect(isConfigFile("custom.rc")).toBe(true);
  });
});

describe("path-matchers perf benchmark (#2109)", () => {
  it("classifies 500 mixed paths in well under the pre-refactor budget (no correctness assertions)", () => {
    const mixedPaths = [
      "src/app.ts",
      "src/components/Button.tsx",
      "test/unit/app.test.ts",
      "test/integration/auth.test.ts",
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "vitest.config.ts",
      "README.md",
      "docs/architecture.md",
      "dist/app.min.js",
      "vendor/lib.go",
      "src/api.generated.ts",
      "node_modules/pkg/index.js",
      "Dockerfile",
      ".env.local",
      "frontend/yarn.lock",
      "Cargo.lock",
      "wrangler.jsonc",
      "src/__generated__/schema.ts",
    ];
    const corpus: string[] = [];
    for (let i = 0; i < 500; i++) corpus.push(mixedPaths[i % mixedPaths.length]!);
    const start = Date.now();
    let sink = 0;
    for (const path of corpus) {
      sink += classifyChangedFile(path) === "source" ? 1 : 0;
    }
    const elapsedMs = Date.now() - start;
    expect(sink).toBeGreaterThanOrEqual(0);
    expect(elapsedMs).toBeLessThan(50);
  });
});
