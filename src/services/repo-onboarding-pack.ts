import { getRepository } from "../db/repositories";
import type { FocusManifest } from "../signals/focus-manifest";
import { loadRepoFocusManifest } from "../signals/focus-manifest-loader";
import {
  buildRepoOnboardingPackPreview,
  type RepoOnboardingPackPreview,
  type RepoPolicyCompilerOutput,
} from "../signals/onboarding-pack";
import { compileRepoPolicyCompilerOutput } from "../signals/repo-policy-compiler";

export type RepoOnboardingPackPreviewResponse = {
  repoFullName: string;
  accepted: boolean;
  preview: RepoOnboardingPackPreview;
  policySource: "policy_compiler";
};

export function buildRepoOnboardingPackPreviewFromManifest(
  repoFullName: string,
  manifest: FocusManifest,
): { preview: RepoOnboardingPackPreview; policyOutput: RepoPolicyCompilerOutput } {
  const policyOutput = compileRepoPolicyCompilerOutput({ repoFullName, manifest });
  const preview = buildRepoOnboardingPackPreview(policyOutput);
  return { preview, policyOutput };
}

/**
 * Build a sanitized onboarding-pack preview for an installed repository. The preview is derived
 * entirely from the repo's own focus manifest/policy compiler (contribution lanes, label policy,
 * validation/maintainer expectations) with zero gittensor-subnet economics data, so it is scoped to
 * isInstalled like the sibling advisory tools in this same access tier (getMaintainerLane, getLabelAudit,
 * getBurdenForecast all use isInstalled-equivalent RBAC with no isRegistered gate) -- not isRegistered.
 */
export async function buildRepoOnboardingPackPreviewForRepo(
  env: Env,
  repoFullName: string,
  options: { refreshManifest?: boolean } = {},
): Promise<RepoOnboardingPackPreviewResponse | { error: string; repoFullName: string }> {
  const repo = await getRepository(env, repoFullName);
  if (!repo?.isInstalled) {
    return {
      error: "repo_not_accepted",
      repoFullName,
    };
  }

  const manifest = await loadRepoFocusManifest(env, repoFullName, { refresh: options.refreshManifest === true });
  const { preview } = buildRepoOnboardingPackPreviewFromManifest(repoFullName, manifest);

  return {
    repoFullName,
    accepted: true,
    preview,
    policySource: "policy_compiler",
  };
}
