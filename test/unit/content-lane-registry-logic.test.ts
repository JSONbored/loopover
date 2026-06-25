import { describe, expect, it } from "vitest";
import {
  assessCandidateDocument,
  assessSurfaceEntry,
  assessSubnetDocument,
  assessFreshness,
  assessProviderDocument,
  candidateRegistryKey,
  classifyPrScope,
  classifyRegistryPrScope,
  isRegistrySubmissionScope,
  METAGRAPHED_LANE_SPEC,
  type RegistryLaneSpec,
  computeGrounding,
  containsSecretLikeText,
  deriveRegistryIdentityTokens,
  functionalRequired,
  isAllowedChain,
  isBaseLayerKind,
  isDirectSubmissionScope,
  isInternalAutomationBranch,
  isNonEmptyStructuredBody,
  netuidGroundingRegex,
  normalizePublicUrl,
  probeFunctionalSurface,
  registrableDomain,
  registryDedupKeys,
  registryUrls,
  surfaceMatchesRegistryIdentity,
  toCoreVerdict,
} from "../../src/review/content-lane/registry-logic";

describe("toCoreVerdict", () => {
  it("maps the live verdict vocabulary onto the core verdict", () => {
    expect(toCoreVerdict("merged")).toBe("merge");
    expect(toCoreVerdict("closed")).toBe("close");
    expect(toCoreVerdict("manual-review")).toBe("manual");
  });
});

describe("containsSecretLikeText", () => {
  it("detects PATs / private keys / wallet terms", () => {
    expect(containsSecretLikeText("ghp_" + "a".repeat(25))).toBe(true);
    expect(containsSecretLikeText("BEGIN PRIVATE KEY")).toBe(true);
    expect(containsSecretLikeText("my coldkey is ...")).toBe(true);
    expect(containsSecretLikeText("totally benign text")).toBe(false);
  });
});

describe("normalizePublicUrl", () => {
  it("canonicalizes trivial variants to the same key", () => {
    const a = normalizePublicUrl("https://www.Example.com:443/app/?utm_source=x#frag");
    const b = normalizePublicUrl("https://example.com/app");
    expect(a).toBe(b);
  });
  it("returns null for non-web protocols / junk", () => {
    expect(normalizePublicUrl("ftp://example.com")).toBeNull();
    expect(normalizePublicUrl("not a url")).toBeNull();
    expect(normalizePublicUrl(42)).toBeNull();
  });
});

describe("netuidGroundingRegex", () => {
  it("matches digit-bounded netuid/subnet/sn forms", () => {
    expect(netuidGroundingRegex(14).test("This is Subnet #14 (Cacheon)")).toBe(true);
    expect(netuidGroundingRegex(14).test("SN14 docs")).toBe(true);
    expect(netuidGroundingRegex(14).test("subnet-14")).toBe(true);
  });
  it("does NOT let subnet 70 satisfy netuid 7 (digit boundary)", () => {
    expect(netuidGroundingRegex(7).test("subnet 70")).toBe(false);
    expect(netuidGroundingRegex(7).test("subnet 7")).toBe(true);
  });
});

describe("registrableDomain", () => {
  it("collapses subdomains to eTLD+1 but keeps multi-tenant suffix tenants distinct", () => {
    expect(registrableDomain("https://api.acme.example/x")).toBe("acme.example");
    expect(registrableDomain("https://alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("https://bob.github.io")).toBe("bob.github.io");
  });
});

describe("computeGrounding", () => {
  it("counts an independent source that names the netuid + shares the host", () => {
    const candidate = { netuid: 14, url: "https://cacheon.ai/api", source_url: "https://github.com/cacheon/repo" };
    const target = { title: "Cacheon", snippet: "Subnet 14 live API" };
    const source = { title: "cacheon repo", snippet: "cacheon.ai is subnet 14" };
    const g = computeGrounding(candidate, target, source);
    expect(g.netuidMentioned).toBe(true);
    expect(g.strong).toBeGreaterThanOrEqual(1);
  });

  it("does not count a self-referential source (url === source_url)", () => {
    const candidate = { netuid: 7, url: "https://repo.example/x", source_url: "https://repo.example/x" };
    const evidence = { title: "x", snippet: "no netuid here" };
    const g = computeGrounding(candidate, evidence, evidence);
    expect(g.ownerMentioned).toBe(false);
    expect(g.hostMatchesClaim).toBe(false);
  });

  it("penalizes a cross-origin redirect", () => {
    const candidate = { netuid: 14, url: "https://a.example", source_url: "https://b.example" };
    const target = { title: "t", snippet: "subnet 14", cross_origin_redirect: true };
    const g = computeGrounding(candidate, target, { title: "s", snippet: "subnet 14" });
    expect(g.crossOriginRedirect).toBe(true);
    expect(g.strong).toBe(Math.max(0, [g.netuidMentioned, g.ownerMentioned, g.hostMatchesClaim].filter(Boolean).length - 1));
  });
});

describe("assessCandidateDocument", () => {
  const ok = {
    candidate: { netuid: 14, kind: "subnet-api", url: "https://api.cacheon.ai", source_url: "https://github.com/cacheon/x", public_safe: true },
  };

  it("merges a clean public candidate", () => {
    expect(assessCandidateDocument(ok).verdict).toBe("merged");
  });

  it("closes when not exactly one candidate", () => {
    expect(assessCandidateDocument({ candidates: [] }).verdict).toBe("closed");
  });

  it("closes a secret-bearing candidate", () => {
    const r = assessCandidateDocument({ candidate: { ...ok.candidate, note: "ghp_" + "a".repeat(25) } });
    expect(r.verdict).toBe("closed");
    expect(r.reason).toBe("secret-or-credential");
  });

  it("closes an observed-state claim", () => {
    const r = assessCandidateDocument({ candidate: { ...ok.candidate, uptime: "99.9%" } });
    expect(r.reason).toBe("observed-state-claim");
  });

  it("closes a non-public_safe candidate", () => {
    const r = assessCandidateDocument({ candidate: { ...ok.candidate, public_safe: false } });
    expect(r.verdict).toBe("closed");
  });

  it("routes an auth_required candidate to manual-review", () => {
    const r = assessCandidateDocument({ candidate: { ...ok.candidate, auth_required: true } });
    expect(r.verdict).toBe("manual-review");
  });

  it("closes an unsafe (private/loopback) candidate URL", () => {
    const r = assessCandidateDocument({ candidate: { ...ok.candidate, url: "https://127.0.0.1" } });
    expect(r.reason).toBe("unsafe-url");
  });

  it("can skip security checks when toggles are off", () => {
    const r = assessCandidateDocument(
      { candidate: { netuid: 14, kind: "website", url: "http://insecure.example", public_safe: true } },
      { sourceUrlValidation: false },
    );
    expect(r.verdict).toBe("merged");
  });
});

describe("assessSurfaceEntry (surface model — netuid supplied from the document root)", () => {
  // A surface entry OMITS netuid (it lives at the subnet-document root); the validator receives it as a param.
  const ok = { kind: "subnet-api", url: "https://api.example.ai", source_url: "https://github.com/x/y", public_safe: true };

  it("merges a clean public surface entry", () => {
    expect(assessSurfaceEntry(ok, 14).verdict).toBe("merged");
  });

  it("rejects a non-object entry (null and primitive)", () => {
    expect(assessSurfaceEntry(null, 14).reason).toBe("unsupported-shape");
    expect(assessSurfaceEntry("nope", 14).reason).toBe("unsupported-shape");
  });

  it("closes a secret-bearing entry, unless the secrets toggle is off", () => {
    const dirty = { ...ok, note: "ghp_" + "a".repeat(25) };
    expect(assessSurfaceEntry(dirty, 14).reason).toBe("secret-or-credential");
    expect(assessSurfaceEntry(dirty, 14, { secretsScan: false }).verdict).toBe("merged");
  });

  it("closes an observed-state claim", () => {
    expect(assessSurfaceEntry({ ...ok, latency: "12ms" }, 14).reason).toBe("observed-state-claim");
  });

  it("tolerates an omitted, null, or matching entry netuid but rejects a conflicting one", () => {
    expect(assessSurfaceEntry(ok, 14).verdict).toBe("merged"); // omitted
    expect(assessSurfaceEntry({ ...ok, netuid: null }, 14).verdict).toBe("merged"); // null
    expect(assessSurfaceEntry({ ...ok, netuid: 14 }, 14).verdict).toBe("merged"); // matching
    expect(assessSurfaceEntry({ ...ok, netuid: 99 }, 14).reason).toBe("unsupported-shape"); // conflicting
  });

  it("closes an unsupported kind", () => {
    expect(assessSurfaceEntry({ ...ok, kind: "totally-unknown" }, 14).reason).toBe("unsupported-shape");
  });

  it("accepts a base-layer (wss) endpoint but closes an unsafe one", () => {
    const base = { kind: "subtensor-rpc", url: "wss://rpc.example.ai", source_url: "https://github.com/x/y", public_safe: true };
    expect(assessSurfaceEntry(base, 14).verdict).toBe("merged");
    const baseBad = assessSurfaceEntry({ ...base, url: "wss://127.0.0.1" }, 14);
    expect(baseBad.reason).toBe("unsafe-url");
    expect(baseBad.summary).toContain("HTTPS or WSS");
    expect(assessSurfaceEntry({ ...base, url: undefined }, 14).reason).toBe("unsafe-url"); // base-layer, missing url
  });

  it("closes an unsafe / missing content URL with the HTTPS message", () => {
    expect(assessSurfaceEntry({ ...ok, url: "https://127.0.0.1" }, 14).summary).toContain("public HTTPS URL");
    expect(assessSurfaceEntry({ ...ok, url: undefined }, 14).reason).toBe("unsafe-url");
  });

  it("falls back to source_urls[0] and closes when no safe source URL is present", () => {
    expect(assessSurfaceEntry({ kind: "subnet-api", url: "https://api.example.ai", source_urls: ["https://github.com/a/b"], public_safe: true }, 14).verdict).toBe("merged");
    expect(assessSurfaceEntry({ kind: "subnet-api", url: "https://api.example.ai", public_safe: true }, 14).reason).toBe("unsafe-url");
  });

  it("can skip URL checks when the toggle is off", () => {
    expect(assessSurfaceEntry({ kind: "website", url: "http://insecure.example", public_safe: true }, 14, { sourceUrlValidation: false }).verdict).toBe("merged");
  });

  it("closes a non-public_safe entry and escalates an auth_required one", () => {
    expect(assessSurfaceEntry({ ...ok, public_safe: false }, 14).verdict).toBe("closed");
    expect(assessSurfaceEntry({ ...ok, auth_required: true }, 14).verdict).toBe("manual-review");
  });
});

describe("assessSubnetDocument (whole-file gate: root netuid + exactly-one appended entry)", () => {
  const entry = { kind: "subnet-api", url: "https://api.example.ai", source_url: "https://github.com/x/y", public_safe: true };
  const doc = { netuid: 14, surfaces: [entry] };

  it("merges a valid document whose single appended entry is clean", () => {
    expect(assessSubnetDocument(doc, { appendedEntry: entry }).verdict).toBe("merged");
  });

  it("rejects a non-object document as malformed", () => {
    expect(assessSubnetDocument(null, { appendedEntry: entry }).reason).toBe("malformed-json");
    expect(assessSubnetDocument(42, { appendedEntry: entry }).reason).toBe("malformed-json");
  });

  it("rejects a non-integer root netuid", () => {
    expect(assessSubnetDocument({ netuid: "abc", surfaces: [entry] }, { appendedEntry: entry }).reason).toBe("unsupported-shape");
    expect(assessSubnetDocument({ surfaces: [entry] }, { appendedEntry: entry }).reason).toBe("unsupported-shape");
  });

  it("rejects a document without a surfaces[] array", () => {
    expect(assessSubnetDocument({ netuid: 14 }, { appendedEntry: entry }).reason).toBe("unsupported-shape");
  });

  it("rejects when the orchestrator found zero-or-many appended entries (sentinel null/undefined)", () => {
    expect(assessSubnetDocument(doc, { appendedEntry: null }).reason).toBe("unsupported-shape");
    expect(assessSubnetDocument(doc, { appendedEntry: undefined }).reason).toBe("unsupported-shape");
  });

  it("catches a secret in the document envelope (outside the entry), unless the toggle is off", () => {
    const dirty = { netuid: 14, surfaces: [entry], maintainer_token: "ghp_" + "b".repeat(25) };
    expect(assessSubnetDocument(dirty, { appendedEntry: entry }).reason).toBe("secret-or-credential");
    expect(assessSubnetDocument(dirty, { appendedEntry: entry, secretsScan: false }).verdict).toBe("merged");
  });

  it("threads the normalized root netuid to the entry (string root coerces; conflicting entry netuid rejected)", () => {
    expect(assessSubnetDocument({ netuid: "14", surfaces: [entry] }, { appendedEntry: entry }).verdict).toBe("merged");
    expect(assessSubnetDocument(doc, { appendedEntry: { ...entry, netuid: 99 } }).reason).toBe("unsupported-shape");
  });
});

describe("assessProviderDocument", () => {
  it("accepts a well-formed enveloped provider", () => {
    const r = assessProviderDocument({ provider: { id: "acme", name: "Acme", website_url: "https://acme.example" } });
    expect(r.ok).toBe(true);
  });
  it("rejects a provider missing id/name", () => {
    const r = assessProviderDocument({ provider: { name: "Acme", website_url: "https://acme.example" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported-shape");
  });
  it("rejects a non-https website_url", () => {
    const r = assessProviderDocument({ provider: { id: "a", name: "A", website_url: "http://x" } });
    expect(r.reason).toBe("unsafe-url");
  });
});

describe("dedup keys + cross-kind urls", () => {
  it("keys on netuid|kind per url AND schema_url", () => {
    const keys = registryDedupKeys({ netuid: 14, kind: "openapi", url: "https://a/swagger", schema_url: "https://a/swagger-json" });
    expect(keys.size).toBe(2);
  });
  it("registryUrls is kind-agnostic", () => {
    const urls = registryUrls({ netuid: 1, kind: "openapi", url: "https://a/x", schema_url: "https://a/y" });
    expect(urls.size).toBe(2);
  });
});

describe("freshness", () => {
  it("flags an archived or very stale repo", () => {
    const now = Date.parse("2026-06-22T00:00:00Z");
    expect(assessFreshness({ archived: true, pushedAt: "2026-06-01T00:00:00Z" }, now).stale).toBe(true);
    expect(assessFreshness({ archived: false, pushedAt: "2024-01-01T00:00:00Z" }, now).stale).toBe(true);
    expect(assessFreshness({ archived: false, pushedAt: "2026-06-01T00:00:00Z" }, now).stale).toBe(false);
  });
  it("an unreadable meta is known:false, not stale", () => {
    expect(assessFreshness(null, Date.now())).toMatchObject({ known: false, stale: false });
  });
});

describe("identity tokens + surface match", () => {
  it("derives identity tokens from a registry record (excluding aggregators)", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Cacheon",
      website_url: "https://cacheon.ai",
      source_repo: "https://github.com/cacheon/core",
      dashboard_url: "https://taomarketcap.com/sn14",
    });
    expect(tokens).toContain("cacheon");
    expect(tokens).not.toContain("taomarketcap");
  });
  it("matches a candidate surface against the subnet identity", () => {
    expect(surfaceMatchesRegistryIdentity("https://api.cacheon.ai", ["cacheon"])).toBe(true);
    expect(surfaceMatchesRegistryIdentity("https://unrelated.example", ["cacheon"])).toBe(false);
    expect(surfaceMatchesRegistryIdentity("https://api.cacheon.ai", [])).toBe(false);
  });
});

describe("probeFunctionalSurface", () => {
  it("requires an actual openapi/swagger version key", () => {
    expect(probeFunctionalSurface("openapi", "application/json", '{"openapi":"3.0.0","paths":{}}').served).toBe(true);
    expect(probeFunctionalSurface("openapi", "text/html", "<h1>We support OpenAPI</h1>").served).toBe(false);
  });
  it("requires a json body for subnet-api and event-stream for sse", () => {
    expect(probeFunctionalSurface("subnet-api", "application/json", "{}").served).toBe(true);
    expect(probeFunctionalSurface("sse", "text/event-stream", "data: x").served).toBe(true);
    expect(probeFunctionalSurface("sse", "text/html", "x").served).toBe(false);
  });
  it("is n/a (served) for non-functional kinds", () => {
    expect(probeFunctionalSurface("website", "text/html", "x").served).toBe(true);
  });
});

describe("classifyPrScope", () => {
  it("recognizes a direct candidate PR with allowed companions", () => {
    const r = classifyPrScope(["registry/candidates/community/foo.json", "public/metagraph/index.json"]);
    expect(r.scope).toBe("direct-candidate");
    expect(r.directFile).toBe("registry/candidates/community/foo.json");
  });
  it("recognizes a direct provider PR", () => {
    const r = classifyPrScope(["registry/providers/community/acme.json"]);
    expect(r.scope).toBe("direct-provider");
    expect(r.isProvider).toBe(true);
  });
  it("flags out-of-scope code files as mixed", () => {
    const r = classifyPrScope(["registry/candidates/community/foo.json", "src/index.ts"]);
    expect(r.scope).toBe("mixed-files");
  });
  it("is not-direct when no submission file is present", () => {
    expect(classifyPrScope(["README.md"]).scope).toBe("not-direct-submission");
  });
});

describe("classifyRegistryPrScope (generic surface model, metagraphed spec)", () => {
  const spec = METAGRAPHED_LANE_SPEC;
  it("recognizes a subnet entry-submission with an allowed generated-artifact companion", () => {
    const r = classifyRegistryPrScope(spec, ["registry/subnets/actual.json", "public/metagraph/index.json"]);
    expect(r.scope).toBe("entry-submission");
    expect(r.directFile).toBe("registry/subnets/actual.json");
    expect(r.isProvider).toBe(false);
    expect(isRegistrySubmissionScope(r.scope)).toBe(true);
  });

  it("recognizes an entry-submission whose flat debut provider is an allowed companion", () => {
    const r = classifyRegistryPrScope(spec, ["registry/subnets/allways.json", "registry/providers/allways.json"]);
    expect(r.scope).toBe("entry-submission");
    expect(r.directFile).toBe("registry/subnets/allways.json");
  });

  it("recognizes a standalone flat provider-submission (no subnet file)", () => {
    const r = classifyRegistryPrScope(spec, ["registry/providers/cacheon.json"]);
    expect(r.scope).toBe("provider-submission");
    expect(r.directFile).toBe("registry/providers/cacheon.json");
    expect(r.isProvider).toBe(true);
  });

  it("is mixed-files when an out-of-scope file rides along", () => {
    expect(classifyRegistryPrScope(spec, ["registry/subnets/actual.json", "src/index.ts"]).scope).toBe("mixed-files");
  });

  it("does NOT adopt the retired candidate path or the retired providers/community/ subdir", () => {
    // a lone retired candidate file is not an entry/provider → not a direct submission
    expect(classifyRegistryPrScope(spec, ["registry/candidates/community/foo.json"]).scope).toBe("not-direct-submission");
    // a retired-subdir provider is not the flat pattern → not adopted as a provider submission
    expect(classifyRegistryPrScope(spec, ["registry/providers/community/foo.json"]).scope).toBe("not-direct-submission");
    // and riding alongside a real subnet entry, the retired path makes it mixed-files
    expect(classifyRegistryPrScope(spec, ["registry/subnets/actual.json", "registry/candidates/community/foo.json"]).scope).toBe("mixed-files");
  });

  it("is not-direct for no submission, and >1 entry file", () => {
    expect(classifyRegistryPrScope(spec, ["README.md"]).scope).toBe("not-direct-submission");
    expect(classifyRegistryPrScope(spec, ["registry/subnets/a.json", "registry/subnets/b.json"]).scope).toBe("not-direct-submission");
    expect(isRegistrySubmissionScope("not-direct-submission")).toBe(false);
  });

  it("tolerates a nullish file list and falsy entries (the ?? [] / || '' guards)", () => {
    expect(classifyRegistryPrScope(spec, undefined as unknown as string[]).scope).toBe("not-direct-submission");
    expect(classifyRegistryPrScope(spec, [null as unknown as string, "registry/subnets/actual.json"]).scope).toBe("entry-submission");
  });

  it("works for a minimal spec with no provider/artifact patterns (a bare registry)", () => {
    const bare: RegistryLaneSpec = { entryFilePattern: /^data\/[a-z]+\.json$/, collectionField: "entries" };
    expect(classifyRegistryPrScope(bare, ["data/x.json"]).scope).toBe("entry-submission");
    expect(classifyRegistryPrScope(bare, ["data/x.json", "data/y.json"]).scope).toBe("not-direct-submission");
    expect(classifyRegistryPrScope(bare, ["data/x.json", "other.json"]).scope).toBe("mixed-files");
  });
});

describe("isBaseLayerKind", () => {
  it("recognizes the chain base-layer kinds", () => {
    expect(isBaseLayerKind("subtensor-wss")).toBe(true);
    expect(isBaseLayerKind("website")).toBe(false);
  });
});

describe("isInternalAutomationBranch", () => {
  it("recognizes noise-bot branch prefixes (case/whitespace-insensitive)", () => {
    expect(isInternalAutomationBranch("renovate/lock-file-maintenance")).toBe(true);
    expect(isInternalAutomationBranch("  Dependabot/npm_and_yarn/x  ")).toBe(true);
    expect(isInternalAutomationBranch("github-actions/sync")).toBe(true);
    expect(isInternalAutomationBranch("reviewbot/auto")).toBe(true);
  });
  it("treats human + codex branches (and undefined) as NOT automation", () => {
    expect(isInternalAutomationBranch("feature/add-subnet")).toBe(false);
    expect(isInternalAutomationBranch("codex/fix-bug")).toBe(false);
    expect(isInternalAutomationBranch(undefined)).toBe(false);
  });
});

describe("isNonEmptyStructuredBody", () => {
  it("is false for a blank body or non-string body", () => {
    expect(isNonEmptyStructuredBody("application/json", "   ")).toBe(false);
    expect(isNonEmptyStructuredBody("application/json", 42)).toBe(false);
    expect(isNonEmptyStructuredBody(123, "{}")).toBe(false); // non-string content-type → ct ""
  });
  it("treats a non-empty JSON object/array/scalar as substantive", () => {
    expect(isNonEmptyStructuredBody("application/json", '{"a":1}')).toBe(true);
    expect(isNonEmptyStructuredBody("application/vnd.api+json", "[1,2]")).toBe(true);
    expect(isNonEmptyStructuredBody("application/json", "42")).toBe(true); // a JSON scalar
  });
  it("treats an EMPTY JSON object/array as not substantive", () => {
    expect(isNonEmptyStructuredBody("application/json", "{}")).toBe(false);
    expect(isNonEmptyStructuredBody("application/json", "[]")).toBe(false);
    expect(isNonEmptyStructuredBody("application/json", "null")).toBe(false);
  });
  it("returns false when a JSON content-type carries invalid JSON", () => {
    expect(isNonEmptyStructuredBody("application/json", "<<not json>>")).toBe(false);
  });
  it("accepts non-blank xml/yaml/csv/event-stream bodies by content-type", () => {
    expect(isNonEmptyStructuredBody("application/xml", "<root/>")).toBe(true);
    expect(isNonEmptyStructuredBody("text/csv", "a,b")).toBe(true);
    expect(isNonEmptyStructuredBody("text/event-stream", "data: x")).toBe(true);
    expect(isNonEmptyStructuredBody("text/html", "<p>x</p>")).toBe(false); // HTML uses the length heuristic elsewhere
  });
});

describe("functionalRequired + isAllowedChain", () => {
  it("requires a functional surface only for openapi/subnet-api/sse", () => {
    expect(functionalRequired("openapi")).toBe(true);
    expect(functionalRequired("subnet-api")).toBe(true);
    expect(functionalRequired("sse")).toBe(true);
    expect(functionalRequired("website")).toBe(false);
  });
  it("accepts bittensor/subtensor-family chain names, rejects others/blank", () => {
    expect(isAllowedChain("Bittensor Finney")).toBe(true);
    expect(isAllowedChain("subtensor")).toBe(true);
    expect(isAllowedChain("nakamoto")).toBe(true);
    expect(isAllowedChain("ethereum")).toBe(false);
    expect(isAllowedChain("")).toBe(false);
    expect(isAllowedChain(null)).toBe(false);
  });
});

describe("isDirectSubmissionScope", () => {
  it("is true only for the direct candidate/provider scopes", () => {
    expect(isDirectSubmissionScope("direct-candidate")).toBe(true);
    expect(isDirectSubmissionScope("direct-provider")).toBe(true);
    expect(isDirectSubmissionScope("mixed-files")).toBe(false);
    expect(isDirectSubmissionScope("not-direct-submission")).toBe(false);
  });
});

describe("registry-logic edge branches (additional coverage)", () => {
  it("computeGrounding grounds via huggingface owner tokens + host-referenced-in-source", () => {
    // ownerTokens huggingface branch (datasets/models/spaces prefix stripped) + sourceText.includes(targetHost)
    const candidate = {
      netuid: 5,
      url: "https://huggingface.co/cacheonlabs/model",
      source_url: "https://docs.example.org/about",
    };
    const target = { title: "t", snippet: "no number" };
    const source = { title: "s", snippet: "huggingface.co hosts cacheonlabs and references huggingface.co/cacheonlabs/model" };
    const g = computeGrounding(candidate, target, source);
    expect(g.ownerMentioned).toBe(true); // "cacheonlabs" token (≥4 chars) appears in evidence
  });

  it("harvests org tokens from source_repo + domain labels from a links array, ignoring aggregators", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Byzantium",
      native_name: "Byzantium AI",
      source_repo: "https://github.com/byzantiumlabs/core", // ownerTokens path → "byzantiumlabs"
      links: [
        { url: "https://aurora.net/home" }, // links domain-label path → "aurora"
        "https://taostats.io/sn/5", // aggregator label dropped
        { nourl: true }, // no url → skipped (covers the missing-url branch)
      ],
    });
    expect(tokens).toContain("byzantium");
    expect(tokens).toContain("byzantiumai");
    expect(tokens).toContain("byzantiumlabs"); // from source_repo ownerTokens
    expect(tokens).toContain("aurora"); // from the links domain label
    expect(tokens).not.toContain("taostats");
    expect(tokens).not.toContain("github"); // aggregator/code-host label excluded
  });

  it("deriveRegistryIdentityTokens returns [] for a null/non-object record", () => {
    expect(deriveRegistryIdentityTokens(null)).toEqual([]);
    expect(deriveRegistryIdentityTokens(undefined)).toEqual([]);
  });

  it("surfaceMatchesRegistryIdentity matches on an owner-token (repo org), not just the domain label", () => {
    // domainLabel of github.com is the aggregator-excluded 'github', so this must match via ownerTokens.
    expect(surfaceMatchesRegistryIdentity("https://github.com/cacheonlabs/repo", ["cacheonlabs"])).toBe(true);
    // No matching token at all → false (exercises the loop-falls-through return).
    expect(surfaceMatchesRegistryIdentity("https://github.com/someoneelse/repo", ["cacheonlabs"])).toBe(false);
  });

  it("assessProviderDocument closes a non-object/null document as malformed-json", () => {
    const r = assessProviderDocument(null);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed-json");
  });

  it("assessProviderDocument closes a secret-bearing provider profile", () => {
    const r = assessProviderDocument({ provider: { id: "a", name: "A", website_url: "https://a.example", note: "ghp_" + "z".repeat(25) } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("secret-or-credential");
  });

  it("assessProviderDocument accepts a FLAT (non-enveloped) provider object", () => {
    const r = assessProviderDocument({ id: "flat", name: "Flat Co", website_url: "https://flat.example" });
    expect(r.ok).toBe(true);
    expect(r.provider?.id).toBe("flat");
  });

  it("normalizePublicUrl drops tracking params + sorts the query deterministically", () => {
    const a = normalizePublicUrl("https://x.example/p?b=2&utm_source=q&a=1&fbclid=z");
    const b = normalizePublicUrl("https://x.example/p?a=1&b=2");
    expect(a).toBe(b);
  });

  it("assessCandidateDocument closes a non-integer netuid as unsupported-shape", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: "abc", kind: "website", url: "https://x.example", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.verdict).toBe("closed");
    expect(r.reason).toBe("unsupported-shape");
    expect(r.summary).toContain("integer");
  });

  it("assessCandidateDocument closes an unsupported kind", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: 14, kind: "totally-made-up", url: "https://x.example", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.verdict).toBe("closed");
    expect(r.reason).toBe("unsupported-shape");
    expect(r.summary).toContain("not supported");
  });

  it("assessCandidateDocument closes an unsafe source URL even when the surface URL is fine", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: 14, kind: "website", url: "https://x.example", source_url: "http://127.0.0.1/x", public_safe: true },
    });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("source URL");
  });

  it("assessCandidateDocument validates a base-layer kind URL via the endpoint (wss) check", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: 14, kind: "subtensor-wss", url: "wss://entrypoint.example/ws", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.verdict).toBe("merged");
  });

  it("assessCandidateDocument closes a base-layer kind with an unsafe (non-wss/https) endpoint", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: 14, kind: "archive", url: "ws://127.0.0.1/ws", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("HTTPS or WSS");
  });

  it("candidateRegistryKey builds netuid|kind|normalizedUrl, null on missing parts", () => {
    expect(candidateRegistryKey({ netuid: 14, kind: "openapi", url: "https://www.A.example/x/" })).toBe(
      "14|openapi|https://a.example/x",
    );
    expect(candidateRegistryKey({ netuid: "x", kind: "openapi", url: "https://a.example" })).toBeNull();
    expect(candidateRegistryKey({ netuid: 14, url: "https://a.example" })).toBeNull(); // no kind
    expect(candidateRegistryKey({ netuid: 14, kind: "openapi", url: "not-a-url" })).toBeNull();
    expect(candidateRegistryKey(null)).toBeNull();
  });

  it("registryDedupKeys / registryUrls return empty for an invalid candidate", () => {
    expect(registryDedupKeys({ netuid: "x", kind: "openapi", url: "https://a.example" }).size).toBe(0);
    expect(registryDedupKeys(null).size).toBe(0);
    expect(registryUrls({ url: "not-a-url" }).size).toBe(0);
  });

  it("normalizePublicUrl keeps ws/wss endpoints and strips the wss default port", () => {
    expect(normalizePublicUrl("wss://node.example:443/ws")).toBe("wss://node.example/ws");
    expect(normalizePublicUrl("ws://node.example:80/ws")).toBe("ws://node.example/ws");
  });
});

describe("registry-logic branch coverage (gap-filling)", () => {
  // ── containsSecretLikeText falsy-input branch ─────────────────────────────
  it("containsSecretLikeText returns false for an empty string (the `|| ''` falsy branch)", () => {
    expect(containsSecretLikeText("")).toBe(false);
    expect(containsSecretLikeText("github_pat_" + "a".repeat(25))).toBe(true);
  });

  // ── normalizePublicUrl untested branches ──────────────────────────────────
  it("normalizePublicUrl leaves a root path untouched (pathname === '/' branch)", () => {
    // pathname === "/" so the trailing-slash strip is skipped; non-default port preserved.
    expect(normalizePublicUrl("https://example.com/")).toBe("https://example.com/");
    expect(normalizePublicUrl("https://example.com:8443/")).toBe("https://example.com:8443/");
  });
  it("normalizePublicUrl collapses /index.html and keeps a non-default port", () => {
    // /docs/index.html → /docs/ (index strip) → /docs (trailing-slash strip, since != "/").
    expect(normalizePublicUrl("https://example.com:8080/docs/index.html")).toBe("https://example.com:8080/docs");
  });

  // ── registrableDomain untested branches ───────────────────────────────────
  it("registrableDomain returns null for a non-string or empty value", () => {
    expect(registrableDomain(42)).toBeNull();
    expect(registrableDomain("")).toBeNull();
    expect(registrableDomain(null)).toBeNull();
  });
  it("registrableDomain returns a bare single-label host unchanged (no dot)", () => {
    // not parseable as a URL → treated as a bare hostname; no "." → returned as-is.
    expect(registrableDomain("localhost")).toBe("localhost");
  });
  it("registrableDomain returns the multi-tenant suffix itself when host === suffix", () => {
    // host equals a multi-tenant suffix exactly → returned as-is (host === suffix branch).
    expect(registrableDomain("https://github.io")).toBe("github.io");
    expect(registrableDomain("pages.dev")).toBe("pages.dev");
  });
  it("registrableDomain takes the deepest tenant label under a multi-tenant suffix", () => {
    // tenant is the LAST label before the suffix (a.b.github.io → b.github.io).
    expect(registrableDomain("https://a.b.github.io/x")).toBe("b.github.io");
  });
  it("registrableDomain returns a two-label apex directly (parts.length <= 2 branch)", () => {
    expect(registrableDomain("https://example.com")).toBe("example.com");
  });

  // ── computeGrounding untested branches ────────────────────────────────────
  it("computeGrounding handles a null candidate + empty evidence (all-false, strong 0)", () => {
    const g = computeGrounding(null, null, undefined);
    expect(g).toEqual({
      netuidMentioned: false,
      ownerMentioned: false,
      hostMatchesClaim: false,
      crossOriginRedirect: false,
      strong: 0,
    });
  });
  it("computeGrounding uses source_urls[0] when source_url is absent", () => {
    // exercises the `(candidate?.source_urls)?.[0]` middle fallback of the source-url chain.
    const candidate = {
      netuid: 9,
      url: "https://cacheon.ai/api",
      source_urls: ["https://cacheon.ai/about"],
    };
    const target = { title: "t", snippet: "no num" };
    const source = { title: "s", snippet: "cacheon.ai is subnet 9" };
    const g = computeGrounding(candidate, target, source);
    // same registrable apex (cacheon.ai) AND source is independent (different path) → host matches.
    expect(g.hostMatchesClaim).toBe(true);
  });
  it("computeGrounding: no source at all → not independent, owner/host both false", () => {
    // source_url falsy + source_urls absent → sourceUrl === "" → independentSource false.
    const candidate = { netuid: 3, url: "https://github.com/cacheonlabs/repo" };
    const ev = { title: "x", snippet: "cacheonlabs subnet 3 cacheonlabs" };
    const g = computeGrounding(candidate, ev, ev);
    expect(g.ownerMentioned).toBe(false);
    expect(g.hostMatchesClaim).toBe(false);
    expect(g.netuidMentioned).toBe(true); // netuid path is source-independent
  });
  it("computeGrounding: an unnormalizable target url makes targetKey null → still independent", () => {
    // candidate.url is not a normalizable URL → stripScheme(targetKey) == null → independentSource true.
    const candidate = {
      netuid: 11,
      url: "not-a-url",
      source_url: "https://github.com/byzantiumlabs/core",
    };
    const target = { title: "t", snippet: "byzantiumlabs" };
    const source = { title: "s", snippet: "byzantiumlabs repo for subnet 11" };
    const g = computeGrounding(candidate, target, source);
    expect(g.ownerMentioned).toBe(true); // owner token grounded because source counts as independent
  });
  it("computeGrounding: host referenced in source body grounds even without a shared apex", () => {
    // targetApex !== sourceApex, but sourceText includes the literal targetHost → hostMatchesClaim true.
    const candidate = {
      netuid: 2,
      url: "https://target-host.example/api",
      source_url: "https://other-domain.org/page",
    };
    const target = { title: "t", snippet: "nothing" };
    const source = { title: "s", snippet: "this page references target-host.example directly" };
    const g = computeGrounding(candidate, target, source);
    expect(g.hostMatchesClaim).toBe(true);
  });
  it("computeGrounding: a cross-origin redirect on the SOURCE side is detected too", () => {
    const candidate = { netuid: 4, url: "https://a.example", source_url: "https://b.example" };
    const target = { title: "t", snippet: "subnet 4" };
    const source = { title: "s", snippet: "subnet 4", cross_origin_redirect: true };
    const g = computeGrounding(candidate, target, source);
    expect(g.crossOriginRedirect).toBe(true);
  });

  // ── ownerTokens (via computeGrounding/deriveRegistryIdentityTokens) branches ─
  it("deriveRegistryIdentityTokens harvests gitlab + bitbucket org tokens and strips .git", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Helios",
      website_url: "https://gitlab.com/heliosorg/heliosrepo.git", // gitlab branch + .git strip on seg[1]
    });
    expect(tokens).toContain("heliosorg");
    expect(tokens).toContain("heliosrepo"); // ".git" stripped, ≥4 chars kept
    const tokens2 = deriveRegistryIdentityTokens({
      name: "Orion",
      source_repo: "https://bitbucket.org/orionlabs/orioncore", // bitbucket branch
    });
    expect(tokens2).toContain("orionlabs");
    expect(tokens2).toContain("orioncore");
  });
  it("deriveRegistryIdentityTokens harvests a huggingface owner WITHOUT a datasets/models/spaces prefix", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Nimbus",
      source_repo: "https://huggingface.co/nimbuslabs/model-x", // no prefix → seg used as-is
    });
    expect(tokens).toContain("nimbuslabs");
  });
  it("deriveRegistryIdentityTokens drops owner tokens shorter than 4 chars", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Zed", // 3 chars → usableIdentityToken false (drops the name token)
      source_repo: "https://github.com/ab/cd", // both <4 chars → ownerTokens filtered out
    });
    expect(tokens).not.toContain("zed");
    expect(tokens).not.toContain("ab");
    expect(tokens).not.toContain("cd");
  });

  // ── deriveRegistryIdentityTokens links: bare-string links + non-array links ─
  it("deriveRegistryIdentityTokens accepts a bare-string link and ignores non-array links", () => {
    const tokens = deriveRegistryIdentityTokens({
      name: "Vega",
      links: ["https://vegasurface.io/home"], // bare string link → domainLabel path
    });
    expect(tokens).toContain("vegasurface");
    // links not an array → the Array.isArray guard short-circuits (no throw, just skipped).
    const tokens2 = deriveRegistryIdentityTokens({ name: "Lyra", links: "https://lyra.example" });
    expect(tokens2).toContain("lyra");
    expect(tokens2).not.toContain("lyra.example");
  });

  // ── assessFreshness untested branches ─────────────────────────────────────
  it("assessFreshness with a missing pushedAt yields ageDays null and not stale", () => {
    const r = assessFreshness({ archived: false }, Date.parse("2026-06-22T00:00:00Z"));
    expect(r).toMatchObject({ known: true, archived: false, pushedAt: null, ageDays: null, stale: false, reason: null });
  });
  it("assessFreshness reports the 'no commits in N days' reason for a stale-but-unarchived repo", () => {
    const now = Date.parse("2026-06-22T00:00:00Z");
    const r = assessFreshness({ archived: false, pushedAt: "2024-01-01T00:00:00Z" }, now);
    expect(r.stale).toBe(true);
    expect(r.archived).toBe(false);
    expect(r.reason).toMatch(/^no commits in \d+ days$/);
  });
  it("assessFreshness reports 'archived' when both archived and stale-old", () => {
    const now = Date.parse("2026-06-22T00:00:00Z");
    const r = assessFreshness({ archived: true, pushedAt: "2020-01-01T00:00:00Z" }, now);
    expect(r.reason).toBe("archived"); // archived takes precedence over the age reason
  });
  it("assessFreshness with an unparseable pushedAt yields ageDays null", () => {
    const r = assessFreshness({ archived: false, pushedAt: "not-a-date" }, Date.now());
    expect(r.ageDays).toBeNull();
    expect(r.stale).toBe(false);
  });

  // ── assessProviderDocument untested branches ──────────────────────────────
  it("assessProviderDocument treats a non-string id/name as empty → unsupported-shape", () => {
    const r = assessProviderDocument({ provider: { id: 123, name: 456, website_url: "https://a.example" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsupported-shape");
  });
  it("assessProviderDocument can skip url validation when sourceUrlValidation is off", () => {
    const r = assessProviderDocument(
      { provider: { id: "a", name: "A", website_url: "http://insecure.example" } },
      { sourceUrlValidation: false },
    );
    expect(r.ok).toBe(true);
  });
  it("assessProviderDocument can skip the secret scan when secretsScan is off", () => {
    const r = assessProviderDocument(
      { provider: { id: "a", name: "A", website_url: "https://a.example", note: "ghp_" + "q".repeat(25) } },
      { secretsScan: false },
    );
    expect(r.ok).toBe(true); // secret not scanned → accepted
  });

  // ── assessCandidateDocument untested branches ─────────────────────────────
  it("assessCandidateDocument reads the array `candidates` form (single entry merges)", () => {
    const r = assessCandidateDocument({
      candidates: [{ netuid: 14, kind: "website", url: "https://x.example", source_url: "https://github.com/a/b", public_safe: true }],
    });
    expect(r.verdict).toBe("merged");
  });
  it("assessCandidateDocument closes when there are MULTIPLE candidates", () => {
    const c = { netuid: 14, kind: "website", url: "https://x.example", source_url: "https://github.com/a/b", public_safe: true };
    const r = assessCandidateDocument({ candidates: [c, c] });
    expect(r.verdict).toBe("closed"); // unsupported-shape IS a reviewer-close reason
    expect(r.reason).toBe("unsupported-shape");
  });
  it("assessCandidateDocument can skip the secret scan via the toggle", () => {
    const r = assessCandidateDocument(
      { candidate: { netuid: 14, kind: "website", url: "https://x.example", source_url: "https://github.com/a/b", public_safe: true, note: "ghp_" + "k".repeat(25) } },
      { secretsScan: false },
    );
    expect(r.verdict).toBe("merged"); // secret not scanned
  });
  it("assessCandidateDocument with a null document closes as unsupported-shape (zero candidates)", () => {
    const r = assessCandidateDocument(null);
    expect(r.reason).toBe("unsupported-shape");
  });
  it("assessCandidateDocument closes a base-layer kind with an unsafe HTTP url message", () => {
    // baseLayer true → unsafe-url uses the "HTTPS or WSS" message branch.
    const r = assessCandidateDocument({
      candidate: { netuid: 1, kind: "subtensor-rpc", url: "http://127.0.0.1", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("HTTPS or WSS");
  });
  it("assessCandidateDocument closes a non-base-layer kind with the plain HTTPS message", () => {
    const r = assessCandidateDocument({
      candidate: { netuid: 1, kind: "website", url: "http://plain.example", source_url: "https://github.com/a/b", public_safe: true },
    });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("public HTTPS URL");
    expect(r.summary).not.toContain("WSS");
  });

  // ── probeFunctionalSurface untested branches ──────────────────────────────
  it("probeFunctionalSurface: openapi version key but paths beyond the window", () => {
    const r = probeFunctionalSurface("openapi", "application/json", '{"openapi":"3.0.0"');
    expect(r.served).toBe(true);
    expect(r.detail).toContain("paths beyond window");
  });
  it("probeFunctionalSurface: a YAML openapi spec (im-multiline form) is recognized", () => {
    const r = probeFunctionalSurface("openapi", "text/yaml", "openapi: 3.0.0\npaths:\n  /x: {}");
    expect(r.served).toBe(true);
    expect(r.detail).toBe("openapi schema served");
  });
  it("probeFunctionalSurface: subnet-api recognized by a leading bracket when content-type isn't json", () => {
    const r = probeFunctionalSurface("subnet-api", "text/plain", "[1,2,3]");
    expect(r.served).toBe(true);
  });
  it("probeFunctionalSurface: subnet-api unserved reports the content-type (none when absent)", () => {
    const r = probeFunctionalSurface("subnet-api", undefined, "<html>");
    expect(r.served).toBe(false);
    expect(r.detail).toContain("content-type:none");
  });
  it("probeFunctionalSurface: sse unserved reports the non-stream content-type", () => {
    const r = probeFunctionalSurface("sse", "application/json", "{}");
    expect(r.served).toBe(false);
    expect(r.detail).toContain("content-type:application/json");
  });

  // ── isAllowedChain undefined branch ───────────────────────────────────────
  it("isAllowedChain returns false for undefined (the nullish-coalesce empty branch)", () => {
    expect(isAllowedChain(undefined)).toBe(false);
  });

  // ── isBaseLayerKind with non-string + isNonEmptyStructuredBody scalar edge ─
  it("isBaseLayerKind coerces a non-string kind (number) to its string form", () => {
    expect(isBaseLayerKind(123)).toBe(false);
    expect(isBaseLayerKind(null)).toBe(false);
  });

  // ── classifyPrScope untested branches ─────────────────────────────────────
  it("classifyPrScope: empty/whitespace-only entries are filtered before classification", () => {
    // null changedFiles (?? []), blank entries filtered → not-direct-submission.
    expect(classifyPrScope(["", "   "]).scope).toBe("not-direct-submission");
    expect(classifyPrScope(null as unknown as string[]).scope).toBe("not-direct-submission");
  });
  it("classifyPrScope: a provider PR with a forbidden companion is mixed-files", () => {
    const r = classifyPrScope(["registry/providers/community/acme.json", "docs/readme.md"]);
    expect(r.scope).toBe("mixed-files");
    expect(r.directFile).toBeNull();
    expect(r.isProvider).toBe(false);
  });
  it("classifyPrScope: a candidate PR may register its provider as an allowed companion", () => {
    const r = classifyPrScope([
      "registry/candidates/community/foo.json",
      "registry/providers/community/foo.json",
      "public/metagraph/index.json",
    ]);
    expect(r.scope).toBe("direct-candidate");
    expect(r.isProvider).toBe(false);
  });
  it("classifyPrScope: two candidate files (not exactly one) is not a direct submission", () => {
    const r = classifyPrScope([
      "registry/candidates/community/a.json",
      "registry/candidates/community/b.json",
    ]);
    expect(r.scope).toBe("not-direct-submission");
  });

  // ── surfaceMatchesRegistryIdentity domain-label match branch ───────────────
  it("surfaceMatchesRegistryIdentity matches directly on the domain label (not just owner tokens)", () => {
    // domainLabel(cacheon.ai) === "cacheon" which is in the want set → early-return true.
    expect(surfaceMatchesRegistryIdentity("https://cacheon.ai", ["cacheon"])).toBe(true);
  });
});

describe("registry-logic branch coverage (second pass)", () => {
  // ── registrableDomain: empty-host return-null branch (line 218) ────────────
  it("registrableDomain returns null when the host strips to empty (www.)", () => {
    // "www." is not a URL → bare host "www." → strip www. → "" → !host → null.
    expect(registrableDomain("www.")).toBeNull();
    expect(registrableDomain("WWW.")).toBeNull();
  });

  // ── registrableDomain: empty tenant → returns the bare suffix (line 227) ───
  it("registrableDomain returns the bare multi-tenant suffix when the tenant label is empty", () => {
    // ".github.io" endsWith ".github.io" but !== suffix → tenant slice is "" → falsy → return suffix.
    expect(registrableDomain(".github.io")).toBe("github.io");
    expect(registrableDomain(".pages.dev")).toBe("pages.dev");
  });

  // ── ownerTokens (via deriveRegistryIdentityTokens): github seg guards ───────
  it("deriveRegistryIdentityTokens tolerates a code host with NO path segments", () => {
    // github.com host matched but pathname empty → seg[0] falsy (line 245) and seg[1] falsy (line 246):
    // no owner/repo token harvested, only the name survives.
    const tokens = deriveRegistryIdentityTokens({ name: "Helios", source_repo: "https://github.com" });
    expect(tokens).toEqual(["helios"]);
  });
  it("deriveRegistryIdentityTokens harvests only the owner when a github URL has no repo segment", () => {
    // seg[0] present (owner) but seg[1] absent (no repo) → only the owner token is pushed (line 246 false).
    const tokens = deriveRegistryIdentityTokens({ name: "Orion", source_repo: "https://github.com/orionlabs" });
    expect(tokens).toContain("orionlabs");
    expect(tokens).toContain("orion");
    expect(tokens).toHaveLength(2);
  });

  // ── ownerTokens (via deriveRegistryIdentityTokens): huggingface seg guards ──
  it("deriveRegistryIdentityTokens strips a datasets/models/spaces prefix on huggingface URLs", () => {
    // seg[0] === "datasets" → rest = seg.slice(1) (the ternary's TRUE side, line 248) → owner+name harvested.
    const tokens = deriveRegistryIdentityTokens({
      name: "Nimbus",
      source_repo: "https://huggingface.co/datasets/nimbuslabs/the-dataset",
    });
    expect(tokens).toContain("nimbuslabs");
    expect(tokens).toContain("thedataset"); // normIdent strips the hyphen from "the-dataset"
  });
  it("deriveRegistryIdentityTokens tolerates a huggingface URL with NO path (empty rest)", () => {
    // seg empty → seg[0] is undefined → `?? ""` fallback (line 248) → not a prefix → rest = seg = [] →
    // rest[0] falsy (line 249) and rest[1] falsy (line 250): only the name survives.
    const tokens = deriveRegistryIdentityTokens({ name: "Vega-net", source_repo: "https://huggingface.co" });
    expect(tokens).toEqual(["veganet"]);
  });
  it("deriveRegistryIdentityTokens harvests only the owner when a huggingface URL has one segment", () => {
    // rest[0] present, rest[1] absent (line 250 false) → only the owner token is pushed.
    const tokens = deriveRegistryIdentityTokens({ name: "Lyra", source_repo: "https://huggingface.co/lyralabs" });
    expect(tokens).toContain("lyralabs");
    expect(tokens).toHaveLength(2);
  });

  // ── domainLabel: empty first label → returns null (line 355) ───────────────
  it("deriveRegistryIdentityTokens drops a website URL whose registrable label is empty", () => {
    // registrableDomain(".x") === ".x" → split(".")[0] === "" → label falsy → domainLabel returns null.
    // No identity token is contributed by website_url; only the (≥4-char) name survives.
    const tokens = deriveRegistryIdentityTokens({ name: "Quark", website_url: ".x" });
    expect(tokens).toEqual(["quark"]);
  });

  // ── usableIdentityToken guard on an owner token (line 377) ─────────────────
  it("deriveRegistryIdentityTokens drops an owner token that is a known aggregator/social label", () => {
    // ownerTokens(github.com/discord/repo) → ["discord","repo"]; "discord" is a NON_IDENTITY label →
    // usableIdentityToken false (line 377) so it is NOT added; "repo" is <4 chars and also dropped.
    const tokens = deriveRegistryIdentityTokens({ name: "Byzantium", source_repo: "https://github.com/discord/repo" });
    expect(tokens).not.toContain("discord");
    expect(tokens).toContain("byzantium");
  });

  // ── registryDedupKeys: a field that does not normalize is skipped (line 471) ─
  it("registryDedupKeys skips a non-normalizable field but keeps the valid one", () => {
    // url normalizes (added); schema_url is junk → normalizePublicUrl null → `if(normalized)` false branch.
    const keys = registryDedupKeys({ netuid: 1, kind: "website", url: "https://a.com/x", schema_url: "not-a-url" });
    expect([...keys]).toEqual(["1|website|https://a.com/x"]);
  });

  // ── assessCandidateDocument: url ?? "" fallbacks (lines 541, 542) ──────────
  it("assessCandidateDocument treats a missing base-layer url as unsafe (url ?? '' fallback)", () => {
    // baseLayer true (subtensor-rpc) + url undefined → String(undefined ?? "") === "" → isSafeEndpointUrl false.
    const r = assessCandidateDocument({ candidate: { netuid: 1, kind: "subtensor-rpc", source_url: "https://github.com/a/b" } });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("HTTPS or WSS");
  });
  it("assessCandidateDocument treats a missing content-kind url as unsafe (url ?? '' fallback)", () => {
    // baseLayer false (website) + url undefined → String(undefined ?? "") === "" → isSafeHttpUrl false.
    const r = assessCandidateDocument({ candidate: { netuid: 1, kind: "website", source_url: "https://github.com/a/b" } });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("public HTTPS URL");
  });

  // ── assessCandidateDocument: source_url || source_urls?.[0] right side (550) ─
  it("assessCandidateDocument falls back to source_urls[0] when source_url is absent", () => {
    // source_url falsy → the `|| source_urls?.[0]` right side supplies the source URL.
    const r = assessCandidateDocument({
      candidate: { netuid: 1, kind: "website", url: "https://x.example", source_urls: ["https://github.com/a/b"], public_safe: true },
    });
    expect(r.verdict).toBe("merged");
  });

  // ── assessCandidateDocument: sourceUrl ?? "" fallback when no source at all (551) ─
  it("assessCandidateDocument with NO source url is unsafe (sourceUrl ?? '' fallback)", () => {
    // source_url and source_urls both absent → sourceUrl undefined → String(undefined ?? "") === "" → unsafe.
    const r = assessCandidateDocument({ candidate: { netuid: 1, kind: "website", url: "https://x.example", public_safe: true } });
    expect(r.reason).toBe("unsafe-url");
    expect(r.summary).toContain("source URL");
  });

  // ── assessProviderDocument: website_url ?? "" fallback (line 618) ──────────
  it("assessProviderDocument with a missing website_url is unsafe-url (website_url ?? '' fallback)", () => {
    // website_url undefined → String(undefined ?? "") === "" → isSafeHttpUrl false.
    const r = assessProviderDocument({ provider: { id: "acme", name: "Acme" } });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("unsafe-url");
  });

  // ── probeFunctionalSurface: sse with an EMPTY content-type → ct || "none" (664) ─
  it("probeFunctionalSurface: an unserved sse with an empty content-type reports 'none'", () => {
    // served false AND ct === "" → the `ct || "none"` fallback fires in the detail string.
    const r = probeFunctionalSurface("sse", "", "data: hi\n\n");
    expect(r.served).toBe(false);
    expect(r.detail).toContain("content-type:none");
  });
});
