#!/usr/bin/env node
// CLI wrapper for check-coco-dev-versions-core.ts (#9213, epic #8534) -- wired into `npm run test:ci` so a
// version bump made in only one of the two files (k8s/coco-dev/versions.json,
// k8s/coco-dev/kbs/base/kustomization.yaml) fails CI instead of silently shipping a KBS deploy that doesn't
// match its own recorded version manifest.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { type CocoDevVersions, checkCocoDevVersionDrift, findKustomizationImage } from "./check-coco-dev-versions-core";

const VERSIONS_JSON_PATH = "k8s/coco-dev/versions.json";
const KUSTOMIZATION_PATH = "k8s/coco-dev/kbs/base/kustomization.yaml";
const KBS_IMAGE_PLACEHOLDER = "kbs-container-image";

function main(): void {
  const versions = JSON.parse(readFileSync(VERSIONS_JSON_PATH, "utf8")) as CocoDevVersions;
  const kustomization = parse(readFileSync(KUSTOMIZATION_PATH, "utf8"));
  const kustomizationImage = findKustomizationImage(kustomization, KBS_IMAGE_PLACEHOLDER);

  const result = checkCocoDevVersionDrift(versions, kustomizationImage);
  if (!result.drifted) {
    process.stdout.write("coco-dev versions: OK\n");
    return;
  }

  process.stderr.write(`coco-dev version drift between ${VERSIONS_JSON_PATH} and ${KUSTOMIZATION_PATH} (#9213):\n`);
  for (const reason of result.reasons) {
    process.stderr.write(`  ${reason}\n`);
  }
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
