export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export const LOG_LEVELS: readonly LogLevel[];
export const DEFAULT_LOG_LEVEL: LogLevel;

export function isLogLevel(value: unknown): value is LogLevel;

export function resolveLogLevel(signals?: {
  level?: string | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  envLevel?: string | undefined;
}): LogLevel;

export function extractLogOptions(argv: string[]): {
  options: { quiet: boolean; verbose: boolean; level: string | undefined };
  rest: string[];
};

export function formatFields(fields?: Record<string, unknown> | null | undefined): string;

export function formatLine(line: {
  level: string;
  message: string;
  fields?: Record<string, unknown> | null | undefined;
  pretty?: boolean | undefined;
  timestamp?: string | undefined;
}): string;

export interface LoggerStreams {
  stdout?: { write(chunk: string): unknown } | undefined;
  stderr?: { write(chunk: string): unknown } | undefined;
}

export interface LoggerOptions {
  level?: string | undefined;
  quiet?: boolean | undefined;
  verbose?: boolean | undefined;
  pretty?: boolean | undefined;
  fields?: Record<string, unknown> | undefined;
  env?: Record<string, string | undefined> | undefined;
  streams?: LoggerStreams | undefined;
  now?: (() => string) | undefined;
}

export interface Logger {
  level: LogLevel;
  isLevelEnabled(level: string): boolean;
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(options?: LoggerOptions): Logger;
export function configureLogger(options?: LoggerOptions): Logger;
export function getLogger(): Logger;
