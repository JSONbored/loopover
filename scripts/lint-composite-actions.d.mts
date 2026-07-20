export type SchemaValidator = ((doc: unknown) => boolean) & {
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

export type Dirent = { name: string; isDirectory(): boolean };

export type ReaddirFn = (dir: string, options: { withFileTypes: true }) => Dirent[];

export type ReadFileFn = (path: string, encoding?: string) => string | Uint8Array;

export declare function compileActionSchema(schemaJson: unknown): SchemaValidator;

export declare function findActionFiles(
  actionsDir: string,
  deps: { readdir: ReaddirFn; readFile: ReadFileFn },
): string[];

export declare function validateActionFile(
  path: string,
  content: string,
  validateSchema: SchemaValidator,
): string[];

export declare function runLint(options: {
  actionsDir: string;
  readdir: ReaddirFn;
  readFile: ReadFileFn;
  validateSchema: SchemaValidator;
  log?: (message: string) => void;
  error?: (message: string) => void;
}): number;
