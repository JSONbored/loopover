// End-of-life runtime regression analyzer (#1504). Parses runtime/base-image/engine version pins a PR changes
// (Dockerfile FROM, .nvmrc, go.mod) and checks endoflife.date (free, no key) — flagging a pin onto a release that
// is already past end-of-support or goes EOL within 90 days. The no-checkout reviewer has no EOL calendar; this does.
import type { EnrichRequest, EolFinding } from "../types.js";

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

const MAX_EOL_FILES = 40;
const MAX_EOL_PATCH_LINES = 1_000;
const MAX_EOL_PINS = 80;

// Leading numeric version from a tag/value: "3.8-slim" → "3.8", "18" → "18", "latest" → null.
function leadingVersion(value: string): string | null {
  return /^v?(\d+(?:\.\d+)*)/.exec(value.trim())?.[1] ?? null;
}

function isDockerfile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return base === "Dockerfile" || /\.dockerfile$/i.test(base);
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
    for (const raw of file.patch.split("\n")) {
      if (linesScanned >= MAX_EOL_PATCH_LINES || pins.length >= MAX_EOL_PINS)
        return pins;
      linesScanned += 1;
      if (raw[0] !== "+" || raw.startsWith("+++")) continue;
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
      } else if (base === ".nvmrc") {
        const version = leadingVersion(line);
        if (version) pins.push({ file: file.path, product: "nodejs", version });
      } else if (base === "go.mod") {
        const match = /^go\s+(\d+\.\d+)/.exec(line);
        if (match)
          pins.push({ file: file.path, product: "go", version: match[1]! });
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
): Promise<Cycle[] | null> {
  const response = await fetchImpl(
    `https://endoflife.date/api/${product}.json`,
  );
  if (!response.ok) return null;
  const data = (await response.json()) as Cycle[];
  return Array.isArray(data) ? data : null;
}

/** Analyzer entrypoint: changed runtime pins → endoflife.date → only the EOL / EOL-soon ones. `now` injectable. */
export async function scanEol(
  req: EnrichRequest,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<EolFinding[]> {
  const findings: EolFinding[] = [];
  const seen = new Set<string>();
  const cyclesByProduct = new Map<string, Cycle[] | null>();
  for (const pin of extractVersionPins(req.files ?? [])) {
    const key = `${pin.product}:${pin.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cyclesByProduct.has(pin.product))
      cyclesByProduct.set(pin.product, await fetchCycles(pin.product, fetchImpl));
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
