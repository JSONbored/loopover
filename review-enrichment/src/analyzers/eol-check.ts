// End-of-life runtime regression analyzer (#1504). Parses runtime/base-image/engine version pins a PR changes
// (Dockerfile FROM, .nvmrc, go.mod) and checks endoflife.date (free, no key) — flagging a pin onto a release that
// is already past end-of-support or goes EOL within 90 days. The no-checkout reviewer has no EOL calendar; this does.
import type {
  AnalyzerDiagnostics,
  EnrichRequest,
  EolFinding,
} from "../types.js";
import type { AnalysisContext } from "../analysis-context.js";
import { boundedFetchJson } from "../external-fetch.js";

// Docker image / source → endoflife.date product slug.
const DOCKER_PRODUCT: Record<string, string> = {
  node: "nodejs",
  python: "python",
  golang: "go",
  ruby: "ruby",
  php: "php",
  debian: "debian",
  ubuntu: "ubuntu",
  alpine: "alpine",
};

interface VersionPin {
  file: string;
  product: string;
  version: string;
}

interface ScanOptions {
  signal?: AbortSignal;
  analysis?: Pick<AnalysisContext, "fetchJson">;
  diagnostics?: AnalyzerDiagnostics;
}

const MAX_EOL_FILES = 40;
const MAX_EOL_PATCH_LINES = 1_000;
const MAX_EOL_PINS = 80;

// Leading numeric version from a tag/value: "3.8-slim" → "3.8", "18" → "18", "latest" → null.
function leadingVersion(value: string): string | null {
  return /^v?(\d+(?:\.\d+)*)/.exec(value.trim())?.[1] ?? null;
}

// asdf `.tool-versions` plugin name → endoflife.date product slug. Includes common aliases (`node`, `golang`).
const TOOL_VERSION_PRODUCT: Record<string, string> = {
  nodejs: "nodejs",
  node: "nodejs",
  python: "python",
  ruby: "ruby",
  golang: "go",
  go: "go",
  php: "php",
  java: "oracle-jdk",
  rust: "rust",
  terraform: "terraform",
  elixir: "elixir",
  kotlin: "kotlin",
  swift: "swift",
  perl: "perl",
  erlang: "erlang",
};

// Heroku `runtime.txt` runtime prefix → endoflife.date product slug.
const RUNTIME_TXT_PRODUCT: Record<string, string> = {
  python: "python",
  ruby: "ruby",
  nodejs: "nodejs",
  node: "nodejs",
};

/** Parse one Heroku `runtime.txt` line (`python-3.11.6`, `ruby-3.2.2`) into an EOL product + version. Pure. */
export function parseRuntimeTxtLine(
  line: string,
): { product: string; version: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([a-z]+)-(.+)$/.exec(trimmed);
  if (!match) return null;
  const product = RUNTIME_TXT_PRODUCT[match[1]!.toLowerCase()];
  const version = leadingVersion(match[2]!);
  if (!product || !version) return null;
  return { product, version };
}

/** Parse one Gemfile `ruby` directive into an EOL product + version. Pure. */
export function parseGemfileRubyLine(
  line: string,
): { product: string; version: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^ruby\s+["']([^"']+)["']/.exec(trimmed);
  if (!match) return null;
  const version = leadingVersion(match[1]!.replace(/^[^0-9v]+/, ""));
  if (!version) return null;
  return { product: "ruby", version };
};

/** Whether `path` is a runtime-pin location the EOL analyzer parses. Exported so the scheduler gate shares
 *  ONE predicate and cannot drift from what this analyzer scans. */
export function isRuntimePinPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return (
    isDockerfile(path) ||
    base === ".nvmrc" ||
    base === ".node-version" ||
    base === ".python-version" ||
    base === ".ruby-version" ||
    base === ".php-version" ||
    base === ".go-version" ||
    base === ".rust-version" ||
    base === ".java-version" ||
    base === ".terraform-version" ||
    base === ".elixir-version" ||
    base === ".kotlin-version" ||
    base === ".swift-version" ||
    base === ".perl-version" ||
    base === ".erlang-version" ||
    base === ".tool-versions" ||
    base === "runtime.txt" ||
    base === "Gemfile" ||
    base === "go.mod"
  );
}

/** Parse one asdf `.tool-versions` line (`tool version [system]`) into an EOL product + version. Pure. */
export function parseToolVersionLine(
  line: string,
): { product: string; version: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = /^([A-Za-z0-9_-]+)\s+(\S+)/.exec(trimmed);
  if (!match) return null;
  const product = TOOL_VERSION_PRODUCT[match[1]!.toLowerCase()];
  const version = leadingVersion(match[2]!);
  if (!product || !version) return null;
  return { product, version };
}

/** True for a Dockerfile the FROM-pin parser understands: the bare name `Dockerfile` (any casing),
 *  a suffixed variant like `Dockerfile.prod` / `Dockerfile.dev` (the prior scheduler gate was
 *  `/^Dockerfile(?:\..*)?$/` and must not regress), or a `*.dockerfile` (e.g. `web.dockerfile`).
 *  Exported so the scheduler's runtime-pin gate shares ONE predicate and cannot drift from what
 *  this analyzer parses. */
export function isDockerfile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return /^Dockerfile(?:\..*)?$/i.test(base) || /\.dockerfile$/i.test(base);
}

/** Pull (product, version) pins out of the added lines of changed Dockerfile / .nvmrc / go.mod. Pure. */
export function extractVersionPins(
  files: NonNullable<EnrichRequest["files"]>,
): VersionPin[] {
  const pins: VersionPin[] = [];
  let filesScanned = 0;
  let linesScanned = 0;
  for (const file of files) {
    if (!file.patch) continue;
    if (filesScanned >= MAX_EOL_FILES) break;
    filesScanned += 1;
    const base = file.path.split("/").pop() ?? file.path;
    let inHunk = false;
    for (const raw of file.patch.split("\n")) {
      if (linesScanned >= MAX_EOL_PATCH_LINES || pins.length >= MAX_EOL_PINS)
        return pins;
      linesScanned += 1;
      if (raw.startsWith("@@")) {
        inHunk = true;
        continue;
      }
      // Only added content inside a hunk; the `+++ ` header precedes the first hunk.
      if (!inHunk || raw[0] !== "+") continue;
      const line = raw.slice(1).trim();
      if (isDockerfile(file.path)) {
        const match =
          /^FROM\s+(?:--platform=\S+\s+)?([a-z0-9._/-]+):([a-zA-Z0-9._-]+)/i.exec(
            line,
          );
        if (match) {
          const product =
            DOCKER_PRODUCT[(match[1]!.split("/").pop() ?? "").toLowerCase()];
          const version = leadingVersion(match[2]!);
          if (product && version)
            pins.push({ file: file.path, product, version });
        }
      } else if (base === ".nvmrc" || base === ".node-version") {
        // `.node-version` (nodenv/asdf) carries the same leading-version pin as `.nvmrc`.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "nodejs", version });
      } else if (base === ".python-version") {
        // pyenv/asdf pin file — same leading-version format, product is Python.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "python", version });
      } else if (base === ".ruby-version") {
        // rbenv/asdf pin file — same leading-version format, product is Ruby.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "ruby", version });
      } else if (base === ".php-version") {
        // phpenv/asdf pin file — same leading-version format, product is PHP.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "php", version });
      } else if (base === ".go-version") {
        // goenv/asdf pin file — same leading-version format, product is Go.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "go", version });
      } else if (base === ".rust-version") {
        // rustup/asdf pin file — same leading-version format, product is Rust.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "rust", version });
      } else if (base === ".java-version") {
        // jenv/asdf pin file — same leading-version format; endoflife.date slug is `oracle-jdk`.
        const version = leadingVersion(line);
        if (version)
          pins.push({ file: file.path, product: "oracle-jdk", version });
      } else if (base === ".terraform-version") {
        // tfenv/asdf pin file — same leading-version format, product is Terraform.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "terraform", version });
      } else if (base === ".elixir-version") {
        // asdf/exenv pin file — same leading-version format, product is Elixir.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "elixir", version });
      } else if (base === ".kotlin-version") {
        // asdf/kotlin pin file — same leading-version format, product is Kotlin.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "kotlin", version });
      } else if (base === ".swift-version") {
        // swiftenv/asdf pin file — same leading-version format, product is Swift.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "swift", version });
      } else if (base === ".perl-version") {
        // plenv/asdf pin file — same leading-version format, product is Perl.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "perl", version });
      } else if (base === ".erlang-version") {
        // kerl/asdf pin file — same leading-version format, product is Erlang.
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "erlang", version });
      } else if (base === "runtime.txt") {
        // Heroku stack runtime pin — `python-3.11.6`, `ruby-3.2.2`, etc.
        const parsed = parseRuntimeTxtLine(line);
        if (parsed)
          pins.push({
            file: file.path,
            product: parsed.product,
            version: parsed.version,
          });
      } else if (base === "Gemfile") {
        // Bundler `ruby "X.Y.Z"` directive — the repo's declared Ruby runtime.
        const parsed = parseGemfileRubyLine(line);
        if (parsed)
          pins.push({
            file: file.path,
            product: parsed.product,
            version: parsed.version,
          });
      } else if (base === ".tool-versions") {
        // asdf multi-tool pin file — one `tool version` pair per line.
        const parsed = parseToolVersionLine(line);
        if (parsed)
          pins.push({
            file: file.path,
            product: parsed.product,
            version: parsed.version,
          });
      } else if (base === "go.mod") {
        // Module language version (`go 1.21`) and optional toolchain pin (`toolchain go1.22.0`).
        const match = /^go\s+(\d+\.\d+)/.exec(line);
        if (match)
          pins.push({ file: file.path, product: "go", version: match[1]! });
        // `toolchain go1.22.0` — no space after `go`; capture full leading version (may include patch).
        const toolchain = /^toolchain\s+go(\d+(?:\.\d+)*)/.exec(line);
        if (toolchain)
          pins.push({ file: file.path, product: "go", version: toolchain[1]! });
      }
    }
  }
  return pins;
}

interface Cycle {
  cycle: string;
  eol: string | boolean;
}

// Match a version to its release cycle — most specific (longest) cycle prefix wins (so "18.17" → "18", "3.8" → "3.8").
function matchCycle(cycles: Cycle[], version: string): Cycle | undefined {
  const sorted = [...cycles].sort((a, b) => b.cycle.length - a.cycle.length);
  return (
    sorted.find(
      (c) => version === c.cycle || version.startsWith(c.cycle + "."),
    ) ?? sorted.find((c) => version.split(".")[0] === c.cycle)
  );
}

function eolStatus(
  eol: string | boolean,
  now: number,
): EolFinding["status"] | null {
  if (eol === false) return null;
  if (eol === true) return "eol";
  const eolMs = new Date(eol).getTime();
  if (!Number.isFinite(eolMs)) return null;
  if (eolMs < now) return "eol";
  if (eolMs < now + 90 * 86_400_000) return "soon";
  return null;
}

async function fetchCycles(
  product: string,
  fetchImpl: typeof fetch,
  options: ScanOptions = {},
): Promise<Cycle[] | null> {
  const url = `https://endoflife.date/api/${product}.json`;
  const fetchOptions = {
    endpointCategory: "endoflife",
    signal: options.signal,
    fetchImpl,
    diagnostics: options.diagnostics,
    phase: "eol",
    subcall: "endoflife",
    maxBytes: 256 * 1024,
    maxCallsPerCategory: MAX_EOL_PINS,
  };
  const response = options.analysis
    ? await options.analysis.fetchJson<Cycle[]>(url, fetchOptions)
    : await boundedFetchJson<Cycle[]>(url, fetchOptions);
  return response.ok && Array.isArray(response.data) ? response.data : null;
}

/** Analyzer entrypoint: changed runtime pins → endoflife.date → only the EOL / EOL-soon ones. `now` injectable. */
export async function scanEol(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
  options: ScanOptions = {},
): Promise<EolFinding[]> {
  const findings: EolFinding[] = [];
  const seen = new Set<string>();
  const cyclesByProduct = new Map<string, Cycle[] | null>();
  for (const pin of extractVersionPins(req.files ?? [])) {
    const key = `${pin.product}:${pin.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cyclesByProduct.has(pin.product))
      cyclesByProduct.set(
        pin.product,
        await fetchCycles(pin.product, fetchImpl, options),
      );
    const cycles = cyclesByProduct.get(pin.product);
    if (!cycles) continue;
    const cycle = matchCycle(cycles, pin.version);
    if (!cycle) continue;
    const status = eolStatus(cycle.eol, now);
    if (status)
      findings.push({
        file: pin.file,
        product: pin.product,
        version: pin.version,
        eol: String(cycle.eol),
        status,
      });
  }
  return findings;
}
