import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Regression check (#5812): docker-compose.yml's header comment banner is the documented entry point for
// "which --profile flags does this file support", but nothing kept it in sync with the services that
// actually declare a `profiles: [...]` array -- ams-observability and backup silently drifted out of it.
// Scans both sides (the real profiles: declarations, and the --profile <name> tokens in the header banner
// preceding `services:`) and asserts they're the same set, so a future profile addition/removal that
// forgets the banner fails CI instead of shipping silent doc drift.

interface ComposeService {
  profiles?: string[];
}
interface ComposeDoc {
  services: Record<string, ComposeService>;
}

const HEADER_PROFILE_TOKEN_PATTERN = /--profile ([a-z0-9-]+)/g;

/** Every profile name any service in `doc` actually declares via `profiles: [...]`. */
function declaredProfiles(doc: ComposeDoc): Set<string> {
  const profiles = new Set<string>();
  for (const service of Object.values(doc.services)) {
    for (const profile of service.profiles ?? []) profiles.add(profile);
  }
  return profiles;
}

/** Every `--profile <name>` token mentioned in the header comment block (everything before the first
 *  `services:` key -- the file's `#`-comment banner, not the machine-readable compose structure). */
function headerBannerProfiles(fileText: string): Set<string> {
  const servicesIndex = fileText.indexOf("\nservices:");
  const header = servicesIndex === -1 ? fileText : fileText.slice(0, servicesIndex);
  return new Set([...header.matchAll(HEADER_PROFILE_TOKEN_PATTERN)].map((match) => match[1]!));
}

function assertHeaderMatchesDeclared(doc: ComposeDoc, fileText: string): void {
  const declared = [...declaredProfiles(doc)].sort();
  const documented = [...headerBannerProfiles(fileText)].sort();
  expect(documented).toEqual(declared);
}

describe("docker-compose.yml PROFILES header (#5812)", () => {
  it("documents exactly the set of profiles services actually declare in the real file", () => {
    const fileText = readFileSync("docker-compose.yml", "utf8");
    const doc = parse(fileText) as ComposeDoc;
    assertHeaderMatchesDeclared(doc, fileText);
  });

  it("fails when a service declares a profile missing from the header banner", () => {
    const doc: ComposeDoc = { services: { foo: { profiles: ["postgres"] }, bar: { profiles: ["undocumented-profile"] } } };
    const fileText = "#   --profile postgres  a database\nservices:\n  foo:\n";
    expect(() => assertHeaderMatchesDeclared(doc, fileText)).toThrow();
  });

  it("fails when the header banner mentions a profile no service declares", () => {
    const doc: ComposeDoc = { services: { foo: { profiles: ["postgres"] } } };
    const fileText = "#   --profile postgres  a database\n#   --profile phantom  never declared\nservices:\n  foo:\n";
    expect(() => assertHeaderMatchesDeclared(doc, fileText)).toThrow();
  });
});
