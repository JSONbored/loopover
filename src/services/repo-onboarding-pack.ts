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
 * Build a sanitized onboarding-pack preview for an accepted (registered) repository.
 */
export async function buildRepoOnboardingPackPreviewForRepo(
  env: Env,
  repoFullName: string,
  options: { refreshManifest?: boolean } = {},
): Promise<RepoOnboardingPackPreviewResponse | { error: string; repoFullName: string }> {
  const repo = await getRepository(env, repoFullName);
  if (!repo?.isRegistered) {
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
