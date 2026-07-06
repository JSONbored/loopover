export const OUTPUT_PATH: string;

export function formatCfTypegenOutput(source: string): string;

export function genCfTypegen(options?: { check?: boolean }): { changed: boolean | undefined };
