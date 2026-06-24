export type CodeownersRule = { pattern: string; owners: string[] };
const MAX_CODEOWNERS_PATTERN_LENGTH = 512;

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = splitCodeownersTokens(line);
    rules.push({ pattern: parts[0]!, owners: parts.slice(1) });
  }
  return rules;
}

export function matchCodeowners(rules: CodeownersRule[], path: string): string[] {
  const normalizedPath = normalizePathForMatch(path);
  if (!normalizedPath) return [];
  let owners: string[] = [];
  for (const rule of rules) {
    if (matchesCodeownersPattern(normalizedPath, rule.pattern)) owners = rule.owners;
  }
  return owners;
}

function normalizePathForMatch(path: string): string {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesCodeownersPattern(normalizedPath: string, rawPattern: string): boolean {
  let pattern = rawPattern.trim();
  if (!pattern) return false;
  if (pattern === "*" || pattern === "/" || pattern === "/*") return true;
  if (pattern.length > MAX_CODEOWNERS_PATTERN_LENGTH) return false;

  const anchored = pattern.startsWith("/");
  const dirOnly = pattern.endsWith("/");
  pattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!pattern) return true;
  const pathSegments = normalizedPath.split("/").filter(Boolean);
  const patternSegments = pattern.split("/").filter(Boolean);
  const matchesAnywhere = !anchored && patternSegments.length === 1;
  if (matchesAnywhere && !dirOnly) return pathSegments.some((segment) => globMatchSegment(segment, patternSegments[0]!));
  if (matchesAnywhere && dirOnly) {
    return pathSegments.some((segment, index) => globMatchSegment(segment, patternSegments[0]!) && index < pathSegments.length - 1);
  }
  return matchPatternSegments(pathSegments, patternSegments, dirOnly);
}

function matchPatternSegments(pathSegments: string[], patternSegments: string[], dirOnly: boolean): boolean {
  const memo = new Map<string, boolean>();
  const visit = (pathIndex: number, patternIndex: number): boolean => {
    const key = `${pathIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched = false;
    if (patternIndex === patternSegments.length) {
      matched = pathIndex === pathSegments.length || dirOnly || terminalPatternMatchesDirectory(patternSegments);
    } else {
      const patternSegment = patternSegments[patternIndex]!;
      if (patternSegment === "**") {
        matched =
          visit(pathIndex, patternIndex + 1) ||
          (pathIndex < pathSegments.length && visit(pathIndex + 1, patternIndex));
      } else if (pathIndex < pathSegments.length && globMatchSegment(pathSegments[pathIndex]!, patternSegment)) {
        matched = visit(pathIndex + 1, patternIndex + 1);
      }
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function terminalPatternMatchesDirectory(patternSegments: string[]): boolean {
  const terminal = patternSegments.at(-1);
  return terminal === "**" || (terminal !== undefined && !terminal.includes("*"));
}

function globMatchSegment(segment: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const visit = (segmentIndex: number, patternIndex: number): boolean => {
    const key = `${segmentIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let matched = false;
    if (patternIndex === pattern.length) {
      matched = segmentIndex === segment.length;
    } else {
      const patternChar = pattern[patternIndex]!;
      if (patternChar === "\\") {
        const escapedChar = pattern[patternIndex + 1];
        matched = escapedChar !== undefined && segmentIndex < segment.length && segment[segmentIndex] === escapedChar && visit(segmentIndex + 1, patternIndex + 2);
      } else if (patternChar === "*") {
        let nextPatternIndex = patternIndex + 1;
        while (pattern[nextPatternIndex] === "*") nextPatternIndex += 1;
        matched = visit(segmentIndex, nextPatternIndex) || (segmentIndex < segment.length && visit(segmentIndex + 1, patternIndex));
      } else if (patternChar === "?") {
        matched = segmentIndex < segment.length && visit(segmentIndex + 1, patternIndex + 1);
      } else if (segmentIndex < segment.length && segment[segmentIndex] === patternChar) {
        matched = visit(segmentIndex + 1, patternIndex + 1);
      }
    }
    memo.set(key, matched);
    return matched;
  };
  return visit(0, 0);
}

function splitCodeownersTokens(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\") {
      current += char;
      if (index + 1 < line.length) {
        current += line[index + 1]!;
        index += 1;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  tokens.push(current);
  return tokens.filter(Boolean);
}
