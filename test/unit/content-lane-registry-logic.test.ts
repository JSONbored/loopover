import { describe, expect, it } from "vitest";
import {
  assessCandidateDocument,
  assessFreshness,
  assessProviderDocument,
  candidateRegistryKey,
  classifyPrScope,
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
