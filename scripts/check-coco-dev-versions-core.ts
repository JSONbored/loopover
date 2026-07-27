// Pure core for the coco-dev version-pin drift check (#9213, epic #8534). k8s/coco-dev/versions.json is the
// single declared source of truth for the Trustee KBS image; kustomize itself needs a literal digest string
// baked into kbs/base/kustomization.yaml (no templating mechanism reaches into it), so that literal is the
// one place a version bump can silently drift from versions.json if a contributor edits one file without the
// other. This module compares the two; it does not check either value against anything upstream -- bumping
// versions.json to a new digest is a deliberate, reviewed change, not something this check second-guesses.
export type CocoDevVersions = {
  schemaVersion: number;
  trusteeKbs: {
    image: string;
    tag: string;
    digest: string;
  };
};

export type KustomizationImage = {
  name: string;
  newName?: string;
  digest?: string;
};

export type CocoDevVersionDriftResult =
  | { drifted: false }
  | { drifted: true; reasons: string[] };

/**
 * Compare the pinned versions manifest against the image entry actually read out of
 * kbs/base/kustomization.yaml. Reports every differing field, not just a single boolean, so a CI failure
 * tells a reviewer exactly what to reconcile instead of just that something doesn't match.
 */
export function checkCocoDevVersionDrift(versions: CocoDevVersions, kustomizationImage: KustomizationImage | undefined): CocoDevVersionDriftResult {
  const reasons: string[] = [];

  if (!kustomizationImage) {
    reasons.push("kbs/base/kustomization.yaml has no images entry named 'kbs-container-image'");
    return { drifted: true, reasons };
  }

  const expectedName = `${versions.trusteeKbs.image}`;
  if (kustomizationImage.newName !== expectedName) {
    reasons.push(`image name: versions.json declares '${expectedName}', kustomization.yaml has '${kustomizationImage.newName}'`);
  }

  if (kustomizationImage.digest !== versions.trusteeKbs.digest) {
    reasons.push(`image digest: versions.json declares '${versions.trusteeKbs.digest}', kustomization.yaml has '${kustomizationImage.digest}'`);
  }

  return reasons.length > 0 ? { drifted: true, reasons } : { drifted: false };
}

/** Find the `images[]` entry kustomize will substitute for the placeholder name `kbs-container-image`, from
 *  an already-parsed kustomization.yaml document. Returns undefined if absent, letting the caller decide how
 *  to report that (never throws -- an absent entry is exactly the drift condition being checked for). */
export function findKustomizationImage(parsedKustomization: unknown, placeholderName: string): KustomizationImage | undefined {
  if (typeof parsedKustomization !== "object" || parsedKustomization === null) return undefined;
  const images = (parsedKustomization as { images?: unknown }).images;
  if (!Array.isArray(images)) return undefined;
  return images.find((entry): entry is KustomizationImage => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === placeholderName);
}
