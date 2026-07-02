export type SelfHostEnvReferenceRow = {
  name: string;
  firstReference: string;
};

export type SelfHostEnvReferenceOptions = {
  rootDir?: string;
  sourceRoots?: readonly string[];
};

export type WriteSelfHostEnvReferenceOptions = SelfHostEnvReferenceOptions & {
  outputPath?: string;
  check?: boolean;
};

export declare const DEFAULT_OUTPUT_PATH: string;
export declare const DEFAULT_SOURCE_ROOTS: readonly string[];

export declare function collectSelfHostEnvVars(
  options?: SelfHostEnvReferenceOptions,
): SelfHostEnvReferenceRow[];

export declare function renderSelfHostEnvReferenceMarkdown(rows: SelfHostEnvReferenceRow[]): string;

export declare function renderSelfHostEnvReferenceModule(rows: SelfHostEnvReferenceRow[]): string;

export declare function writeSelfHostEnvReference(
  options?: WriteSelfHostEnvReferenceOptions,
): {
  changed: boolean;
  outputPath: string;
  rows: SelfHostEnvReferenceRow[];
};
