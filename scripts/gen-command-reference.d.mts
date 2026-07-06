export type CommandCatalogEntry = {
  id: string;
  title: string;
  description: string;
};

export type CommandCatalogOptions = {
  rootDir?: string;
  sourcePath?: string;
};

export type WriteCommandReferenceOptions = CommandCatalogOptions & {
  outputPath?: string;
  check?: boolean;
};

export declare const DEFAULT_SOURCE_PATH: string;
export declare const DEFAULT_OUTPUT_PATH: string;

export declare function extractCatalogEntries(sourceText: string, catalogConstName: string): CommandCatalogEntry[];

export declare function renderCommandList(entries: CommandCatalogEntry[]): string;

export declare function collectCommandCatalogs(options?: CommandCatalogOptions): {
  publicCommands: CommandCatalogEntry[];
  maintainerCommands: CommandCatalogEntry[];
  actionCommands: CommandCatalogEntry[];
};

export declare function renderCommandReferenceModule(catalogs: {
  publicCommands: CommandCatalogEntry[];
  maintainerCommands: CommandCatalogEntry[];
  actionCommands: CommandCatalogEntry[];
}): string;

export declare function writeCommandReference(options?: WriteCommandReferenceOptions): {
  changed: boolean;
  outputPath: string;
  publicCommands: CommandCatalogEntry[];
  maintainerCommands: CommandCatalogEntry[];
  actionCommands: CommandCatalogEntry[];
};
