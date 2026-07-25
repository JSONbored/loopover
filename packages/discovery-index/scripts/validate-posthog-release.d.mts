export type PostHogReleaseValidationConfig = {
  apiKey: string | undefined;
  projectId: string | undefined;
  release: string | undefined;
  baseUrl: string;
};

export type PostHogReleaseValidationResult = {
  release: string | undefined;
  symbolSetCount: number;
};

export declare class PostHogReleaseValidationError extends Error {
  failures: string[];
  constructor(message: string, failures?: string[]);
}

export declare function loadPostHogReleaseValidationConfig(
  env?: Record<string, string | undefined>,
): PostHogReleaseValidationConfig;

export declare function validatePostHogRelease(
  env?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<PostHogReleaseValidationResult>;
