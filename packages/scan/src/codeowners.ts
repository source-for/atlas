import type { ArchitectureEntity, ArchitectureSnapshot } from "@okie/architecture";
import { scrubGithubTokens } from "./redact.js";
import { compareText } from "@okie/architecture";

/**
 * GitHub CODEOWNERS lookup order. The first existing file wins — same as GitHub.
 * Equivalent path-owner files outside these names are out of slice.
 */
export const CODEOWNERS_CANDIDATE_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

export interface CodeOwnerRule {
  pattern: string;
  owners: string[];
}

export interface CodeOwnersFile {
  path: string;
  rules: CodeOwnerRule[];
}

export interface PathOwnerFact {
  path: string;
  owners: string[];
}

/** First existing CODEOWNERS (or equivalent GitHub path). Missing files are not an error. */
export function readCodeOwners(readFile: (repoRelativePath: string) => string): CodeOwnersFile | undefined {
  for (const path of CODEOWNERS_CANDIDATE_PATHS) {
    let text: string;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    return { path, rules: parseCodeOwners(text) };
  }
  return undefined;
}

/**
 * Parse GitHub CODEOWNERS bytes into ordered rules. Comments are skipped.
 * Owner-less patterns are kept: last match wins, including a later empty
 * owner list that clears inherited ownership.
 */
export function parseCodeOwners(text: string): CodeOwnerRule[] {
  const rules: CodeOwnerRule[] = [];
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = stripCodeOwnersComment(raw).trim();
    if (!line || line.startsWith("!")) continue;
    const tokens = tokenizeCodeOwnersLine(line);
    if (tokens.length < 1) continue;
    const pattern = tokens[0]!;
    if (!pattern) continue;
    // Owner-less later rules are valid GitHub syntax: they *clear* inherited
    // ownership for that path (`/apps/ @octocat` then `/apps/github`).
    const owners = uniqueSorted(tokens.slice(1).map(scrubGithubTokens).filter(isOwnerToken));
    rules.push({ pattern, owners });
  }
  return rules;
}

/** Last matching CODEOWNERS rule for a repository-relative path. Empty when none match. */
export function ownersForPath(path: string, rules: readonly CodeOwnerRule[]): string[] {
  if (!path || rules.length === 0) return [];
  let owners: string[] = [];
  for (const rule of rules) {
    if (pathMatchesCodeOwnersPattern(rule.pattern, path)) owners = rule.owners;
  }
  return owners;
}

/** Deterministic path→owners facts for an emit-prompt appendix. Omits unmatched paths. */
export function pathOwnerFacts(paths: readonly string[], rules: readonly CodeOwnerRule[]): PathOwnerFact[] {
  if (rules.length === 0) return [];
  const facts: PathOwnerFact[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const owners = ownersForPath(path, rules);
    if (owners.length) facts.push({ path, owners });
  }
  return facts;
}

/**
 * Overlay observed path owners onto snapshot entities. Extraction documents
 * stay owner-free — this is scan-time, not ArchitectureExtraction.
 * Parent entities union descendant file owners. Entities with no matching
 * owners keep the field omitted.
 */
export function attachPathOwners(
  snapshot: ArchitectureSnapshot,
  rules: readonly CodeOwnerRule[],
): ArchitectureSnapshot {
  if (rules.length === 0) return snapshot;
  const childrenByParent = new Map<string, string[]>();
  const byId = new Map<string, ArchitectureEntity>();
  for (const entity of snapshot.entities) {
    byId.set(entity.id, entity);
    if (!entity.parentId) continue;
    const bucket = childrenByParent.get(entity.parentId) ?? [];
    bucket.push(entity.id);
    childrenByParent.set(entity.parentId, bucket);
  }

  const pathsMemo = new Map<string, string[]>();
  const collectPaths = (entityId: string): string[] => {
    const cached = pathsMemo.get(entityId);
    if (cached) return cached;
    const entity = byId.get(entityId);
    if (!entity) {
      pathsMemo.set(entityId, []);
      return [];
    }
    const paths = new Set<string>();
    for (const ref of entity.sourceRefs) {
      if (ref.path) paths.add(ref.path);
    }
    for (const childId of childrenByParent.get(entityId) ?? []) {
      for (const path of collectPaths(childId)) paths.add(path);
    }
    const sorted = [...paths].sort();
    pathsMemo.set(entityId, sorted);
    return sorted;
  };

  return {
    ...snapshot,
    entities: snapshot.entities.map(entity => {
      const owners = uniqueSorted(
        collectPaths(entity.id).flatMap(path => ownersForPath(path, rules)),
      );
      if (owners.length === 0) {
        if (!entity.owners) return entity;
        const rest = { ...entity };
        delete rest.owners;
        return rest;
      }
      return { ...entity, owners };
    }),
  };
}

function stripCodeOwnersComment(line: string): string {
  let result = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && line[index + 1] === "#") {
      result += "#";
      index += 1;
      continue;
    }
    if (char === "#") break;
    result += char;
  }
  return result;
}

function tokenizeCodeOwnersLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === "\\" && index + 1 < line.length) {
      current += line[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isOwnerToken(value: string): boolean {
  return value.length > 0 && value !== "[redacted-token]";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))].sort(compareText);
}

function pathMatchesCodeOwnersPattern(pattern: string, path: string): boolean {
  const normalized = pattern.replace(/\\/g, "/");
  if (!normalized) return false;
  // GitHub CODEOWNERS: `*` is the repo-wide default (all files), unlike gitignore `*`.
  if (normalized === "*" || normalized === "**" || normalized === "/**") return true;
  if (gitignoreMatch(normalized, path)) return true;
  return literalDirectoryPrefixMatch(normalized, path);
}

/**
 * Gitignore-style match (GitHub CODEOWNERS). A trailing slash is directory-only
 * and matches that directory plus every path under it. Unanchored globs
 * (`*.js`, `README.md`) match in any directory.
 */
function gitignoreMatch(pattern: string, path: string): boolean {
  let body = pattern;
  let dirOnly = false;
  if (body.endsWith("/")) {
    dirOnly = true;
    body = body.slice(0, -1);
  }
  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  } else if (body.includes("/")) {
    anchored = true;
  }
  if (!body) return dirOnly;
  const regex = globToRegExp(body, anchored, dirOnly);
  return regex.test(path);
}

function globToRegExp(glob: string, anchored: boolean, dirOnly: boolean): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; ) {
    if (glob.startsWith("**/", index) || (glob.startsWith("**", index) && index + 2 === glob.length)) {
      if (glob.startsWith("**/", index)) {
        source += "(?:.*/)?";
        index += 3;
      } else {
        source += ".*";
        index += 2;
      }
      continue;
    }
    const char = glob[index]!;
    if (char === "*") {
      source += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    if (char === "[" ) {
      const close = glob.indexOf("]", index + 1);
      if (close > index) {
        source += glob.slice(index, close + 1);
        index = close + 1;
        continue;
      }
    }
    source += escapeRegExp(char);
    index += 1;
  }
  const tail = dirOnly ? "(?:/.*)?" : "";
  if (anchored) return new RegExp(`^${source}${tail}$`);
  return new RegExp(`(?:^|/)${source}${tail}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Literal (non-glob) patterns also cover files under that directory, so
 * `/packages/scan @team` owns `packages/scan/src/index.ts` and a container
 * evidence path `packages/scan`.
 */
function literalDirectoryPrefixMatch(pattern: string, path: string): boolean {
  if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) return false;
  // Unanchored filenames (`README.md`) stay gitignore-only; a slash means a path.
  if (!pattern.includes("/")) return false;
  let dir = pattern;
  if (dir.endsWith("/")) dir = dir.slice(0, -1);
  if (dir.startsWith("/")) dir = dir.slice(1);
  if (!dir) return false;
  return path === dir || path.startsWith(`${dir}/`);
}
