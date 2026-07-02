// Pure, fs-free (table, column) collision detection across migration files (#2551), shared by
// scripts/check-migrations.mjs's cross-migration collision check. Sufficient for this repo's actual migration
// corpus -- verified by direct inspection: no CREATE TRIGGER statements (so no trigger-body-aware semicolon
// handling is needed, unlike src/selfhost/migrate.ts's statement splitter) and every identifier is a bare
// lowercase snake_case name (no quoted/bracketed identifiers anywhere) -- not a general-purpose SQL parser.

/** Split SQL text into individual statements on top-level semicolons (outside string quotes/comments). */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = null;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    if (char === ";") {
      // The slice always ends with this `;`, so `.trim()` can never produce an empty string here (unlike
      // the trailing tail below, which genuinely can be empty) -- push unconditionally.
      statements.push(sql.slice(start, i + 1).trim());
      start = i + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

/** Split a CREATE TABLE column-list body on top-level commas -- respecting nested parens (CHECK(...),
 *  FOREIGN KEY(a) REFERENCES b(c)) so a comma inside one of those doesn't split a single column/constraint
 *  definition in two. */
function splitTopLevelCommaList(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const TABLE_LEVEL_CONSTRAINT_KEYWORDS = /^(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i;
const IDENTIFIER = /^(\w+)/;

/** Strip `--` line comments and `/* *\/` block comments (outside string quotes) from a statement before
 *  matching against it. Required for two reasons: a statement split at a top-level semicolon can have
 *  LEADING full-line comments preceding the actual keyword (breaking a `^`-anchored match like DROP TABLE's),
 *  and a CREATE TABLE column list's per-column trailing `-- comment, with a comma in it` would otherwise
 *  split a single column definition into two at that comment's comma (verified against
 *  migrations/0060_orb_fleet_collector.sql's inline column comments, which contain commas). */
function stripSqlComments(text: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote) {
        if (next === quote) {
          result += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      result += char;
      continue;
    }
    result += char;
  }
  return result;
}

/** A single schema-affecting event a statement produces, in the order that lets a caller replay migration
 *  history statement-by-statement: `drop_table` clears every column previously tracked for that table (a
 *  DROP+CREATE recreate, e.g. migrations/0060_orb_fleet_collector.sql's documented SQLite-ALTER-limitation
 *  workaround for orb_signals, must not read as colliding with the table it replaces); `remove_column`
 *  (DROP/RENAME COLUMN) untracks a single column rather than flagging it as a fresh collision candidate. */
export type SchemaEvent =
  | { type: "define_column"; table: string; column: string }
  | { type: "drop_table"; table: string }
  | { type: "remove_column"; table: string; column: string };

/** Extract the schema-affecting events a single SQL statement produces. Statements that don't affect table
 *  shape (INSERT, CREATE INDEX, plain DROP INDEX, ...) yield no events. */
export function extractSchemaEvents(rawStatement: string): SchemaEvent[] {
  const statement = stripSqlComments(rawStatement);
  const dropTableMatch = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/i.exec(statement);
  if (dropTableMatch) return [{ type: "drop_table", table: dropTableMatch[1]!.toLowerCase() }];

  const renameColumnMatch = /\bALTER\s+TABLE\s+(\w+)\s+RENAME\s+COLUMN\s+(\w+)\s+TO\s+(\w+)/i.exec(statement);
  if (renameColumnMatch) {
    const table = renameColumnMatch[1]!.toLowerCase();
    return [
      { type: "remove_column", table, column: renameColumnMatch[2]!.toLowerCase() },
      { type: "define_column", table, column: renameColumnMatch[3]!.toLowerCase() },
    ];
  }

  const dropColumnMatch = /\bALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)/i.exec(statement);
  if (dropColumnMatch) return [{ type: "remove_column", table: dropColumnMatch[1]!.toLowerCase(), column: dropColumnMatch[2]!.toLowerCase() }];

  const addColumnMatch = /\bALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(statement);
  if (addColumnMatch) return [{ type: "define_column", table: addColumnMatch[1]!.toLowerCase(), column: addColumnMatch[2]!.toLowerCase() }];

  const createTableMatch = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([\s\S]*)\)[^)]*$/i.exec(statement);
  if (!createTableMatch) return [];
  const table = createTableMatch[1]!.toLowerCase();
  const body = createTableMatch[2]!;
  const events: SchemaEvent[] = [];
  for (const clause of splitTopLevelCommaList(body)) {
    if (TABLE_LEVEL_CONSTRAINT_KEYWORDS.test(clause)) continue;
    const identifierMatch = IDENTIFIER.exec(clause);
    if (!identifierMatch) continue;
    events.push({ type: "define_column", table, column: identifierMatch[1]!.toLowerCase() });
  }
  return events;
}

export type ColumnCollision = { table: string; column: string; files: string[] };

/**
 * Replay every migration file's schema events IN MIGRATION-NUMBER ORDER and return every (table, column)
 * pair DEFINED by more than one file -- a same-table/same-column collision across differently-numbered,
 * individually-valid migrations (#2551). `orderedFileContents` must already be sorted ascending by migration
 * number (the same order `scripts/check-migrations.mjs` reads the directory in); a `drop_table` event clears
 * every column tracked for that table so far, so a documented DROP+CREATE recreate never reads as a
 * collision with the table it replaces. Pure, no I/O.
 */
export function detectColumnCollisions(orderedFileContents: ReadonlyArray<readonly [string, string]>): ColumnCollision[] {
  const tracked = new Map<string, { table: string; column: string; files: Set<string> }>();

  for (const [filename, sql] of orderedFileContents) {
    for (const statement of splitSqlStatements(sql)) {
      for (const event of extractSchemaEvents(statement)) {
        if (event.type === "drop_table") {
          for (const [key, entry] of tracked) {
            if (entry.table === event.table) tracked.delete(key);
          }
          continue;
        }
        const key = `${event.table}.${event.column}`;
        if (event.type === "remove_column") {
          tracked.delete(key);
          continue;
        }
        const entry = tracked.get(key);
        if (entry) entry.files.add(filename);
        else tracked.set(key, { table: event.table, column: event.column, files: new Set([filename]) });
      }
    }
  }

  const collisions: ColumnCollision[] = [];
  for (const { table, column, files } of tracked.values()) {
    if (files.size > 1) collisions.push({ table, column, files: [...files].sort() });
  }
  return collisions.sort((a, b) => (a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table)));
}
