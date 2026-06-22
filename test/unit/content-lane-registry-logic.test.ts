import { describe, expect, it } from "vitest";
import {
  assessCandidateDocument,
  assessFreshness,
  assessProviderDocument,
  classifyPrScope,
  computeGrounding,
  containsSecretLikeText,
  deriveRegistryIdentityTokens,
  isBaseLayerKind,
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
