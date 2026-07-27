import { describe, expect, it } from "vitest";

import { type CocoDevVersions, checkCocoDevVersionDrift, findKustomizationImage } from "../../scripts/check-coco-dev-versions-core";

const VERSIONS: CocoDevVersions = {
  schemaVersion: 1,
  trusteeKbs: {
    image: "ghcr.io/confidential-containers/key-broker-service",
    tag: "built-in-as-v0.21.0",
    digest: "sha256:16926d905621e94dadadb95fd0794dddae8ee30bdf71c71940c6c8fe25087119",
  },
};

describe("checkCocoDevVersionDrift", () => {
  it("reports no drift when the kustomization image matches versions.json exactly", () => {
    const result = checkCocoDevVersionDrift(VERSIONS, {
      name: "kbs-container-image",
      newName: "ghcr.io/confidential-containers/key-broker-service",
      digest: "sha256:16926d905621e94dadadb95fd0794dddae8ee30bdf71c71940c6c8fe25087119",
    });
    expect(result).toEqual({ drifted: false });
  });

  it("reports drift when the digest was bumped in versions.json but not in kustomization.yaml", () => {
    const result = checkCocoDevVersionDrift(VERSIONS, {
      name: "kbs-container-image",
      newName: "ghcr.io/confidential-containers/key-broker-service",
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(result.drifted).toBe(true);
    expect(result.drifted && result.reasons.join("\n")).toMatch(/image digest/);
  });

  it("reports drift when the image name diverges", () => {
    const result = checkCocoDevVersionDrift(VERSIONS, {
      name: "kbs-container-image",
      newName: "ghcr.io/some-fork/key-broker-service",
      digest: "sha256:16926d905621e94dadadb95fd0794dddae8ee30bdf71c71940c6c8fe25087119",
    });
    expect(result.drifted).toBe(true);
    expect(result.drifted && result.reasons.join("\n")).toMatch(/image name/);
  });

  it("reports both reasons when both name and digest diverge", () => {
    const result = checkCocoDevVersionDrift(VERSIONS, {
      name: "kbs-container-image",
      newName: "ghcr.io/some-fork/key-broker-service",
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(result.drifted).toBe(true);
    expect(result.drifted && result.reasons).toHaveLength(2);
  });

  it("reports drift when the kustomization has no matching images entry at all", () => {
    const result = checkCocoDevVersionDrift(VERSIONS, undefined);
    expect(result.drifted).toBe(true);
    expect(result.drifted && result.reasons.join("\n")).toMatch(/no images entry/);
  });
});

describe("findKustomizationImage", () => {
  it("finds the matching entry by placeholder name among several images", () => {
    const parsed = {
      images: [
        { name: "some-other-image", newName: "example.com/other" },
        { name: "kbs-container-image", newName: "ghcr.io/confidential-containers/key-broker-service", digest: "sha256:abc" },
      ],
    };
    expect(findKustomizationImage(parsed, "kbs-container-image")).toEqual({
      name: "kbs-container-image",
      newName: "ghcr.io/confidential-containers/key-broker-service",
      digest: "sha256:abc",
    });
  });

  it("returns undefined when no images array is present", () => {
    expect(findKustomizationImage({ resources: ["namespace.yaml"] }, "kbs-container-image")).toBeUndefined();
  });

  it("returns undefined when images is present but not an array", () => {
    expect(findKustomizationImage({ images: "not-an-array" }, "kbs-container-image")).toBeUndefined();
  });

  it("returns undefined when the parsed document is not an object", () => {
    expect(findKustomizationImage(null, "kbs-container-image")).toBeUndefined();
    expect(findKustomizationImage("a string", "kbs-container-image")).toBeUndefined();
  });

  it("returns undefined when no entry in images matches the placeholder name", () => {
    const parsed = { images: [{ name: "unrelated-image" }] };
    expect(findKustomizationImage(parsed, "kbs-container-image")).toBeUndefined();
  });
});
