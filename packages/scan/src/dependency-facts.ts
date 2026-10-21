import { builtinModules } from "node:module";
import type TS from "typescript";
import type Parser from "tree-sitter";
import { rustParser, rustParserUnavailable, ts } from "./analyzers.js";
import {
  CONTROL_CHARACTERS, DEPENDENCY_FACTS_OMITTED_LIMIT, portableSourcePath, sanitizeControlCharacters, validateDependencyFacts,
  type DependencyCoverage, type DependencyDeclaration, type DependencyEcosystem, type DependencyEvidenceKind, type DependencyFacts,
  type DependencyImport, type DependencyImportKind, type DependencyPackage, type DependencySection, type DependencySymbolReference,
} from "@okie/architecture";
import { packageNameOfSpecifier, parseSource } from "./extract.js";
import type { AnalysisExternalReference, LanguageAnalysis } from "./language-analysis.js";
import { scrubGithubTokens } from "./redact.js";

/**
 * Dependency consumer facts (CLA-212): manifest declarations, syntactic imports,
 * and analyzer-resolved symbol references — three distinct evidence kinds, each
 * with explicit coverage. Bundle-only: nothing here feeds the architecture graph.
 */
export const DEPENDENCY_FACT_LIMITS = {
  maxImports: 50_000,
  maxSymbolReferences: 50_000,
  maxSymbolReferencesPerDependencyFile: 200,
  /** Serialized (compact JSON) budget for the whole facts object: 16 MiB. */
  maxFactBytes: 16 * 1024 * 1024,
} as const;

export interface DependencyFactLimits {
  maxImports: number;
  maxSymbolReferences: number;
  maxSymbolReferencesPerDependencyFile: number;
  maxFactBytes: number;
}

/** Manifest and lockfile names read (only) from committed content. */
export const DEPENDENCY_INPUT_FILES = ["package.json", "Cargo.toml", "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "Cargo.lock", "tsconfig.json"] as const;

// ---------------------------------------------------------------------------
// Shared helpers

/** Byte-stable ordering (never locale-dependent). */
const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const joinPath = (directory: string, name: string): string => (directory ? `${directory}/${name}` : name);
function ancestors(directory: string): string[] {
  const result = [directory];
  for (let current = directory; current; ) {
    current = dirOf(current);
    result.push(current);
  }
  return result;
}
function relativeDirectory(from: string, to: string): string {
  if (!from) return to;
  return to === from ? "" : to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to;
}
const ECOSYSTEM_LIST = ["npm", "cargo"] as const;
const perEcosystem = <T>(make: () => T): Record<DependencyEcosystem, T> => ({ npm: make(), cargo: make() });

const SEMVER = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const ABSOLUTE_PATH_PLACEHOLDER = "<absolute path>";

/**
 * Strip credentials from a requested spec or lockfile source before it is persisted:
 * URL userinfo (including a raw `/` inside it), query strings, credential-looking
 * fragments, token-shaped strings, and absolute local paths.
 */
export function redactSpec(spec: string): string {
  let value = spec;
  // Absolute local paths: `/…`, `~/…`, `C:\…`, optionally behind file:/link:/portal:/path:.
  value = value.replace(/^((?:file|link|portal|path):)?(?:\/|~[/\\]|[A-Za-z]:[\\/]).*$/s, (_match, prefix: string | undefined) => `${prefix ?? ""}${ABSOLUTE_PATH_PLACEHOLDER}`);
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(value);
  if (scheme) {
    const start = scheme[0].length;
    const endOfLocator = value.search(/[?#]/);
    const locatorEnd = endOfLocator < 0 ? value.length : endOfLocator;
    const locator = value.slice(start, locatorEnd);
    let rest = value.slice(locatorEnd);
    const firstSlash = locator.indexOf("/");
    const authority = firstSlash < 0 ? locator : locator.slice(0, firstSlash);
    let cut = -1;
    if (authority.includes("@")) cut = authority.lastIndexOf("@");
    // `user:secret/with/slash@host` — a non-numeric "port" means the colon part is a password.
    else if (/:[^0-9]/.test(authority) || /:$/.test(authority)) cut = locator.lastIndexOf("@");
    let redactedLocator = locator;
    if (cut >= 0 && locator.slice(0, cut) !== "git") redactedLocator = `[redacted]${locator.slice(cut)}`;
    // Queries routinely carry tokens; fragments stay only when they look like a git ref / semver range.
    rest = rest.replace(/\?[^#]*/, "?[redacted]");
    rest = rest.replace(/#(.*)$/s, (match, fragment: string) => (/[=&]|token|secret|pass|key|auth/i.test(fragment) ? "#[redacted]" : match));
    value = `${value.slice(0, start)}${redactedLocator}${rest}`;
  }
  value = scrubGithubTokens(value)
    .replace(/glpat-[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/npm_[A-Za-z0-9]{36}/g, "[redacted-token]");
  return sanitizeControlCharacters(value);
}

/** Normalize a lockfile "version" (pnpm peer suffixes, aliases) to semver, a local link, or a non-registry source. */
export function normalizeLockVersion(raw: string): { kind: "version"; version: string } | { kind: "local" } | { kind: "source" } {
  let value = raw.trim().replace(/^['"]|['"]$/g, "");
  if (/^(link|file|workspace|portal):/.test(value)) return { kind: "local" };
  value = value.replace(/^\//, "").replace(/\(.*$/, "");
  const peer = /^(\d+\.\d+\.\d+[^_]*)_/.exec(value); // pnpm v5: 18.2.0_react@17.0.2
  if (peer) value = peer[1]!;
  if (value.includes("@", 1)) {
    const tail = value.slice(value.lastIndexOf("@") + 1); // alias: react@18.2.0
    if (SEMVER.test(tail)) value = tail;
  }
  return SEMVER.test(value) ? { kind: "version", version: value.replace(/^v/, "") } : { kind: "source" };
}

/** Loose numeric-aware version ordering for candidate lists. */
function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/);
  const b = right.split(/[.+-]/);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? "";
    const y = b[index] ?? "";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny) && nx !== ny) return nx - ny;
    if (x !== y) return compare(x, y);
  }
  return 0;
}

/** A semver version: numeric core plus prerelease identifiers (build metadata dropped). */
interface SemverVersion { major: number; minor: number; patch: number; pre: string[] }
const SEMVER_PRE = String.raw`(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?`;

function parseSemver(version: string): SemverVersion | undefined {
  const match = new RegExp(String.raw`^v?(\d+)\.(\d+)\.(\d+)${SEMVER_PRE}$`).exec(version.trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ? match[4].split(".") : [] };
}

/**
 * Semver prerelease order: a release (no identifiers) sorts AFTER any prerelease; numeric
 * identifiers compare numerically and before alphanumeric ones; a longer list wins a tie.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return (left.length === 0 ? 1 : 0) - (right.length === 0 ? 1 : 0);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!;
    const b = right[index]!;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB && Number(a) !== Number(b)) return Number(a) - Number(b);
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

/** One comparator; `minor`/`patch` are undefined when the requirement omits them (`1`, `<=1.2`). */
interface SemverComparator { op: "=" | ">" | ">=" | "<" | "<=" | "~" | "^" | "*"; major: number; minor?: number; patch?: number; pre: string[] }

function parseComparator(text: string): SemverComparator | undefined {
  const match = new RegExp(String.raw`^(\^|~|=|>=|<=|>|<)?\s*v?(\d+)(?:\.(\d+|[*xX]))?(?:\.(\d+|[*xX]))?${SEMVER_PRE}$`).exec(text);
  if (!match) return undefined;
  const wildcard = (part: string | undefined): boolean => part !== undefined && /^[*xX]$/.test(part);
  // Cargo rejects a number or prerelease after a wildcard (`1.*.3`, `1.2.*-beta`): unparsable.
  if ((wildcard(match[3]) && match[4] !== undefined && !wildcard(match[4])) || ((wildcard(match[3]) || wildcard(match[4])) && match[5])) return undefined;
  const minor = match[3] === undefined || wildcard(match[3]) ? undefined : Number(match[3]);
  const patch = minor === undefined || match[4] === undefined || wildcard(match[4]) ? undefined : Number(match[4]);
  const pre = match[5] ? match[5].split(".") : [];
  // `1.*` / `1.2.*` are wildcards (the `semver` crate's Op::Wildcard, matched like `=`), but
  // only without an explicit operator: `^1.2.*` is `^1.2` and `>=1.*` is `>=1`.
  const op = (match[1] ?? (wildcard(match[3]) || wildcard(match[4]) ? "*" : "^")) as SemverComparator["op"];
  return { op, major: Number(match[2]), ...(minor !== undefined ? { minor } : {}), ...(patch !== undefined ? { patch } : {}), pre };
}

// The `semver` crate's comparator semantics (what Cargo uses), partial versions included:
// `<=1` admits 1.4.0, `>1` starts at 2.0.0, `=1.2` is 1.2.x, `~1` is 1.x, `^0.2` is 0.2.x.
function matchesExact(cmp: SemverComparator, v: SemverVersion): boolean {
  return v.major === cmp.major && (cmp.minor === undefined || v.minor === cmp.minor)
    && (cmp.patch === undefined || v.patch === cmp.patch) && comparePrerelease(v.pre, cmp.pre) === 0;
}
function matchesGreater(cmp: SemverComparator, v: SemverVersion): boolean {
  if (v.major !== cmp.major) return v.major > cmp.major;
  if (cmp.minor === undefined) return false;
  if (v.minor !== cmp.minor) return v.minor > cmp.minor;
  if (cmp.patch === undefined) return false;
  if (v.patch !== cmp.patch) return v.patch > cmp.patch;
  return comparePrerelease(v.pre, cmp.pre) > 0;
}
function matchesLess(cmp: SemverComparator, v: SemverVersion): boolean {
  if (v.major !== cmp.major) return v.major < cmp.major;
  if (cmp.minor === undefined) return false;
  if (v.minor !== cmp.minor) return v.minor < cmp.minor;
  if (cmp.patch === undefined) return false;
  if (v.patch !== cmp.patch) return v.patch < cmp.patch;
  return comparePrerelease(v.pre, cmp.pre) < 0;
}
function matchesTilde(cmp: SemverComparator, v: SemverVersion): boolean {
  if (v.major !== cmp.major) return false;
  if (cmp.minor !== undefined && v.minor !== cmp.minor) return false;
  if (cmp.patch !== undefined && v.patch !== cmp.patch) return v.patch > cmp.patch;
  return comparePrerelease(v.pre, cmp.pre) >= 0;
}
function matchesCaret(cmp: SemverComparator, v: SemverVersion): boolean {
  if (v.major !== cmp.major) return false;
  if (cmp.minor === undefined) return true;
  if (cmp.patch === undefined) return cmp.major > 0 ? v.minor >= cmp.minor : v.minor === cmp.minor;
  if (cmp.major > 0) {
    if (v.minor !== cmp.minor) return v.minor > cmp.minor;
    if (v.patch !== cmp.patch) return v.patch > cmp.patch;
  } else if (cmp.minor > 0) {
    if (v.minor !== cmp.minor) return false;
    if (v.patch !== cmp.patch) return v.patch > cmp.patch;
  } else if (v.minor !== cmp.minor || v.patch !== cmp.patch) return false;
  return comparePrerelease(v.pre, cmp.pre) >= 0;
}
function matchesComparator(cmp: SemverComparator, v: SemverVersion): boolean {
  switch (cmp.op) {
    case "=": case "*": return matchesExact(cmp, v);
    case ">": return matchesGreater(cmp, v);
    case ">=": return matchesExact(cmp, v) || matchesGreater(cmp, v);
    case "<": return matchesLess(cmp, v);
    case "<=": return matchesExact(cmp, v) || matchesLess(cmp, v);
    case "~": return matchesTilde(cmp, v);
    case "^": return matchesCaret(cmp, v);
  }
}

/**
 * Whether a Cargo version requirement (`0.7`, `^1.2`, `~1`, `=1.2.3`, `>=1, <2`, `<=1`,
 * `1.*`, `*`, `>=1.0.0-beta`) admits `version`, with the `semver` crate's rules: every
 * comparator must match (partial versions as above), and a prerelease version (`1.0.0-alpha`)
 * is admitted only when some comparator names the same major.minor.patch with a prerelease.
 * Undefined when the requirement or version is unparsable.
 */
export function cargoRequirementMatches(requirement: string, version: string): boolean | undefined {
  const target = parseSemver(version);
  if (!target) return undefined;
  // Only characters Cargo's requirement grammar uses, with ASCII space as its only
  // whitespace: a control character or Unicode whitespace (raw, or decoded from a TOML
  // escape) is unparsable, never trimmed away. A repertoire gate, not full validation.
  if (/[^0-9A-Za-z*.,+^~<=> -]/.test(requirement)) return undefined;
  const parts = requirement.split(",").map(part => part.trim());
  if (parts.length === 1 && /^[*xX]?$/.test(parts[0]!)) return target.pre.length === 0; // `*` / empty: any release
  const comparators: SemverComparator[] = [];
  for (const part of parts) {
    const comparator = parseComparator(part);
    if (!comparator) return undefined;
    comparators.push(comparator);
  }
  if (!comparators.every(comparator => matchesComparator(comparator, target))) return false;
  if (target.pre.length === 0) return true;
  return comparators.some(comparator => comparator.pre.length > 0 && comparator.major === target.major
    && comparator.minor === target.minor && comparator.patch === target.patch);
}

const NPM_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/;
const CARGO_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const validName = (ecosystem: DependencyEcosystem, name: string): boolean =>
  name.length > 0 && name.length <= 214 && (ecosystem === "npm" ? NPM_NAME : CARGO_NAME).test(name);
const validRepoPath = (path: string): boolean => portableSourcePath(path) && !CONTROL_CHARACTERS.test(path);

// ---------------------------------------------------------------------------
// npm manifests + lockfiles

export const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** 1-based line of each key directly inside a top-level package.json object `section`. */
export function jsonSectionKeyLines(text: string, section: string): Map<string, number> {
  const lines = text.split(/\r?\n/);
  const result = new Map<string, number>();
  let depth = 0;
  let inside = false;
  let sectionDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!inside && depth === 1 && new RegExp(`^\\s*"${section}"\\s*:\\s*\\{`).test(line)) {
      inside = true;
      sectionDepth = depth + 1;
    } else if (inside && depth === sectionDepth) {
      const match = /^\s*"((?:[^"\\]|\\.)+)"\s*:/.exec(line);
      if (match && !result.has(match[1]!)) result.set(match[1]!, index + 1);
    }
    let quoted = false;
    for (let offset = 0; offset < line.length; offset += 1) {
      const character = line[offset];
      if (character === "\\" && quoted) { offset += 1; continue; }
      if (character === '"') quoted = !quoted;
      else if (!quoted && character === "{") depth += 1;
      else if (!quoted && character === "}") {
        depth -= 1;
        if (inside && depth < sectionDepth) inside = false;
      }
    }
  }
  return result;
}

export interface NpmManifestEntry { key: string; section: typeof NPM_SECTIONS[number]; spec: string; line?: number }

/**
 * A `package.json` with no name, no dependency section and no `workspaces` is a
 * marker (e.g. `{"type":"module"}`), not a package: `marker: true`.
 */
export function parsePackageJsonDependencies(text: string): { name?: string; entries: NpmManifestEntry[]; marker: boolean } {
  const manifest = JSON.parse(text) as Record<string, unknown>;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("package.json is not an object");
  const entries: NpmManifestEntry[] = [];
  let sections = 0;
  for (const section of NPM_SECTIONS) {
    const block = manifest[section];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    sections += 1;
    const lines = jsonSectionKeyLines(text, section);
    for (const [key, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec !== "string") continue;
      const line = lines.get(key);
      entries.push({ key, section, spec, ...(line ? { line } : {}) });
    }
  }
  const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name : undefined;
  return { ...(name ? { name } : {}), entries, marker: !name && !sections && manifest.workspaces === undefined };
}

/** pnpm-lock.yaml importers (v6/v9) or the top-level v5/v6 single-project layout: importer -> name -> version. */
export function parsePnpmLockImporters(text: string): Map<string, Map<string, string>> {
  const importers = new Map<string, Map<string, string>>();
  const lines = text.split(/\r?\n/);
  const unquote = (value: string): string => value.trim().replace(/^['"]|['"]$/g, "");
  const cleanVersion = (value: string): string => {
    const clean = unquote(value).replace(/\(.*$/, "");
    return /^\d+\.\d+\.\d+[^_]*_/.test(clean) ? clean.slice(0, clean.indexOf("_")) : clean;
  };
  const sectionName = /^(dependencies|devDependencies|optionalDependencies|peerDependencies):\s*$/;
  const hasImporters = lines.some(line => /^importers:\s*$/.test(line));
  const read = (start: number, base: number, importer: string): number => {
    // `base` is the indent of section keys; entries sit at base+2, nested fields at base+4.
    const target = importers.get(importer) ?? new Map<string, string>();
    importers.set(importer, target);
    let index = start;
    let inSection = false;
    let current: string | undefined;
    for (; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent < base) break;
      if (indent === base) {
        inSection = sectionName.test(line.trim());
        current = undefined;
        continue;
      }
      if (!inSection) continue;
      if (indent === base + 2) {
        const match = /^((?:'[^']*'|"[^"]*"|[^:\s]+)):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        current = unquote(match[1]!);
        if (match[2]) target.set(current, cleanVersion(match[2]));
      } else if (indent === base + 4 && current) {
        const field = /^version:\s*(.+)$/.exec(line.trim());
        if (field) target.set(current, cleanVersion(field[1]!));
      }
    }
    return index;
  };
  if (hasImporters) {
    let inImporters = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (/^importers:\s*$/.test(line)) { inImporters = true; continue; }
      if (!inImporters) continue;
      if (/^\S/.test(line)) break;
      const importer = /^ {2}((?:'[^']*'|"[^"]*"|[^:\s][^:]*)):\s*$/.exec(line);
      if (importer) index = read(index + 1, 4, unquote(importer[1]!)) - 1;
    }
  } else {
    // Single project: top-level dependency sections at indent 0.
    for (let index = 0; index < lines.length; index += 1) {
      if (sectionName.test(lines[index]!)) index = read(index, 0, ".") - 1;
    }
  }
  return importers;
}

/** package-lock.json v2/v3 `packages` (v1 top-level `dependencies` best-effort): install path -> entry. */
export function parsePackageLock(text: string): Map<string, { version?: string; link?: boolean }> {
  const lock = JSON.parse(text) as { packages?: Record<string, { version?: unknown; link?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  const result = new Map<string, { version?: string; link?: boolean }>();
  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, value] of Object.entries(lock.packages)) {
      if (!value || typeof value !== "object") continue;
      result.set(key, { ...(typeof value.version === "string" ? { version: value.version } : {}), ...(value.link === true ? { link: true } : {}) });
    }
  } else if (lock.dependencies && typeof lock.dependencies === "object") {
    for (const [name, value] of Object.entries(lock.dependencies)) {
      if (value && typeof value.version === "string") result.set(`node_modules/${name}`, { version: value.version });
    }
  }
  return result;
}

/** yarn.lock (v1; berry best-effort): descriptor (`name@range`) -> version. */
export function parseYarnLock(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let descriptors: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (/^\S/.test(line) && line.trimEnd().endsWith(":")) {
      descriptors = line.trimEnd().slice(0, -1).split(/,\s*/).map(item => item.trim().replace(/^"|"$/g, ""));
      continue;
    }
    const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (version) for (const descriptor of descriptors) result.set(descriptor, version[1]!);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cargo manifests + lockfile

export interface CargoDependencySpec {
  version?: string;
  path?: string;
  git?: string;
  gitRef?: string;
  package?: string;
  workspace?: boolean;
  /** `registry = "…"`: the alternate registry a version requirement resolves from. */
  registry?: string;
  /** 1-based line where `path` was set (the inline table, dotted key or subsection field). */
  pathLine?: number;
  /** 1-based line where `workspace = true` was set. */
  workspaceLine?: number;
}
export interface CargoManifestEntry extends CargoDependencySpec {
  key: string;
  section: "dependencies" | "dev-dependencies" | "build-dependencies";
  target?: string;
  line: number;
}
/** One entry of a `[patch.<source>]` table (inline, dotted keys or `[patch.<source>.<key>]`). */
export interface CargoManifestPatch extends CargoDependencySpec {
  /** The `<source>` key, unquoted: a registry name (`crates-io`) or a git URL. */
  source: string;
  key: string;
  line: number;
}
export interface CargoManifest {
  packageName?: string;
  /** `[package] version` as written. */
  packageVersion?: string;
  /** `[package] version.workspace = true`: the version comes from `[workspace.package]`. */
  packageVersionInherited?: boolean;
  /** `[workspace.package] version`. */
  workspacePackageVersion?: string;
  isWorkspace: boolean;
  workspaceDependencies: Map<string, CargoDependencySpec & { line: number }>;
  entries: CargoManifestEntry[];
  /** `[patch.*]` entries in source order (Cargo honours them only in the workspace root). */
  patches: CargoManifestPatch[];
}

/** Remove a TOML `#` comment that is outside any string. */
export function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') { index += 1; continue; }
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "#") return line.slice(0, index);
  }
  return line;
}
/** Net `{`/`[` depth of a comment-stripped TOML fragment, ignoring strings. */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === "\\" && quote === '"') { index += 1; continue; }
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
  }
  return depth;
}
const TOML_ESCAPES: Readonly<Record<string, string>> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
/**
 * A dependency requirement as Cargo reads it: a TOML 1.0 basic string (`basic`, raw
 * between the quotes) with its escapes decoded, or a literal string (`literal`) as is.
 * An escape or control character TOML rejects (`\q`, `\uD800`, `\e`) keeps the raw
 * text; it contains a backslash or control character, so no requirement parses it and
 * the requirement is reported unparsable rather than read as absent.
 */
function tomlRequirement(basic: string | undefined, literal: string | undefined): string | undefined {
  if (basic === undefined) return literal;
  if (/[\u0000-\u0008\u000A-\u001F\u007F]/.test(basic)) return basic;
  let valid = true;
  const decoded = basic.replace(/\\(?:([btnfr"\\])|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|[\s\S])/g, (_, simple: string | undefined, short: string | undefined, long: string | undefined) => {
    if (simple !== undefined) return TOML_ESCAPES[simple]!;
    const code = short ?? long;
    const scalar = code === undefined ? -1 : Number.parseInt(code, 16);
    if (scalar >= 0 && scalar <= 0x10ffff && (scalar < 0xd800 || scalar > 0xdfff)) return String.fromCodePoint(scalar);
    valid = false;
    return "";
  });
  return valid ? decoded : basic;
}
function tomlStringMatch(text: string, key: string): RegExpExecArray | null {
  return new RegExp(`(?:^|[{,\\s])${key}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`).exec(stripTomlComment(text));
}
function tomlString(text: string, key: string): string | undefined {
  const match = tomlStringMatch(text, key);
  return match ? (match[1] ?? match[2]) : undefined;
}
function inlineSpec(text: string): CargoDependencySpec {
  const value = stripTomlComment(text).trim();
  const plain = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
  if (plain) return { version: tomlRequirement(plain[1], plain[2])! };
  const spec: CargoDependencySpec = {};
  const version = tomlStringMatch(value, "version");
  if (version) spec.version = tomlRequirement(version[1], version[2])!;
  for (const key of ["path", "git", "package", "registry"] as const) {
    const found = tomlString(value, key);
    if (found !== undefined) spec[key] = found;
  }
  const gitRef = tomlString(value, "rev") ?? tomlString(value, "tag") ?? tomlString(value, "branch");
  if (gitRef !== undefined) spec.gitRef = gitRef;
  if (/(?:^|[{,\s])workspace\s*=\s*true/.test(value)) spec.workspace = true;
  return spec;
}
function assignField(spec: CargoDependencySpec, field: string, rawValue: string): void {
  const value = stripTomlComment(rawValue).trim();
  if (field === "workspace") { if (/^true\b/.test(value)) spec.workspace = true; return; }
  const text = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
  if (!text) return;
  if (field === "version") { spec.version = tomlRequirement(text[1], text[2])!; return; }
  const content = text[1] ?? text[2]!;
  if (field === "path" || field === "git" || field === "package" || field === "registry") spec[field] = content;
  else if (field === "rev" || field === "tag" || field === "branch") spec.gitRef = content;
}

/**
 * Line-based Cargo.toml reader (no TOML dependency): package name, dependency tables,
 * workspace inheritance. Comments are stripped outside strings, and a value whose
 * `{`/`[` do not balance on its line is joined with the following lines, so a
 * multi-line inline table never turns its continuation (`package = …`) into a key.
 */
export function parseCargoManifest(text: string): CargoManifest {
  const manifest: CargoManifest = { isWorkspace: false, workspaceDependencies: new Map(), entries: [], patches: [] };
  const lines = text.split(/\r?\n/);
  type Context = { kind: "package" } | { kind: "workspace-package" } | { kind: "workspace-deps"; sub?: string } | { kind: "deps"; section: CargoManifestEntry["section"]; target?: string; sub?: string }
    | { kind: "patch"; source: string; sub?: string } | { kind: "other" };
  let context: Context = { kind: "other" };
  const byKey = new Map<string, CargoManifestEntry>();
  const entryFor = (key: string, section: CargoManifestEntry["section"], target: string | undefined, line: number): CargoManifestEntry => {
    const id = `${target ?? ""}\u0000${section}\u0000${key}`;
    let entry = byKey.get(id);
    if (!entry) {
      entry = { key, section, ...(target ? { target } : {}), line };
      byKey.set(id, entry);
      manifest.entries.push(entry);
    }
    return entry;
  };
  const workspaceFor = (key: string, line: number): CargoDependencySpec & { line: number } => {
    const existing = manifest.workspaceDependencies.get(key);
    if (existing) return existing;
    const created = { line };
    manifest.workspaceDependencies.set(key, created);
    return created;
  };
  const patchesByKey = new Map<string, CargoManifestPatch>();
  const patchFor = (source: string, key: string, line: number): CargoManifestPatch => {
    const id = `${source}\u0000${key}`;
    let patch = patchesByKey.get(id);
    if (!patch) {
      patch = { source, key, line };
      patchesByKey.set(id, patch);
      manifest.patches.push(patch);
    }
    return patch;
  };
  const unquoteKey = (key: string): string => key.trim().replace(/^["']|["']$/g, "");
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripTomlComment(lines[index]!).trim();
    if (!line) continue;
    const header = /^\[\s*([^\][]+?)\s*\]$/.exec(line);
    if (header) {
      const name = header[1]!;
      const patch = /^patch\s*\.\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\s*(?:\.\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+))?$/.exec(name);
      if (name === "package") context = { kind: "package" };
      else if (name === "workspace") { manifest.isWorkspace = true; context = { kind: "other" }; }
      else if (name === "workspace.package") { manifest.isWorkspace = true; context = { kind: "workspace-package" }; }
      else if (patch) {
        const source = unquoteKey(patch[1]!);
        const sub = patch[2] !== undefined ? unquoteKey(patch[2]) : undefined;
        context = { kind: "patch", source, ...(sub !== undefined ? { sub } : {}) };
        if (sub !== undefined) patchFor(source, sub, lineNumber);
      }
      else if (/^workspace\.dependencies(\.|$)/.test(name)) {
        manifest.isWorkspace = true;
        const sub = /^workspace\.dependencies\.(.+)$/.exec(name)?.[1];
        context = { kind: "workspace-deps", ...(sub ? { sub: unquoteKey(sub) } : {}) };
        if (sub) workspaceFor(unquoteKey(sub), lineNumber);
      } else {
        const match = /^(?:target\.('[^']*'|"[^"]*"|[^.]+)\.)?(dependencies|dev-dependencies|build-dependencies|dev_dependencies|build_dependencies)(?:\.(.+))?$/.exec(name);
        if (match) {
          const target = match[1] ? match[1].replace(/^['"]|['"]$/g, "") : undefined;
          const section = match[2]!.replace("_", "-") as CargoManifestEntry["section"];
          const sub = match[3] ? unquoteKey(match[3]) : undefined;
          context = { kind: "deps", section, ...(target ? { target } : {}), ...(sub ? { sub } : {}) };
          if (sub) entryFor(sub, section, target, lineNumber);
        } else context = { kind: "other" };
      }
      continue;
    }
    if (/^\[\[/.test(line)) { context = { kind: "other" }; continue; }
    // TOML allows whitespace around the dot of a dotted key (`core . workspace = true`);
    // `left` is normalised to `key.field`.
    const assignment = /^("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*("[^"]*"|'[^']*'|[A-Za-z0-9_-]+))?\s*=\s*(.*)$/.exec(line);
    if (!assignment) continue;
    const left = assignment[2] !== undefined ? `${assignment[1]!}.${unquoteKey(assignment[2])}` : assignment[1]!;
    let value = assignment[3]!;
    // Join continuation lines of a multi-line inline table / array (bounded).
    for (let guard = 0; bracketDepth(value) > 0 && index + 1 < lines.length && guard < 500; guard += 1) {
      index += 1;
      value += ` ${stripTomlComment(lines[index]!).trim()}`;
    }
    if (context.kind === "package" || context.kind === "workspace-package") {
      const text = /^"([^"]*)"|^'([^']*)'/.exec(value);
      // A quoted `"version"` key is the same field; without this it reads as no version (0.0.0).
      const field = /^(["'])version\1(?=\.|$)/.test(left) ? `version${left.slice(9)}` : left;
      if (context.kind === "package" && field === "name" && text) manifest.packageName = text[1] ?? text[2]!;
      else if (field === "version" && text) {
        if (context.kind === "package") manifest.packageVersion = text[1] ?? text[2]!;
        else manifest.workspacePackageVersion = text[1] ?? text[2]!;
      } else if (context.kind === "package" && ((field === "version.workspace" && /^true\b/.test(value))
        || (field === "version" && /^\{(?:[^}]*[,\s])?workspace\s*=\s*true\b/.test(value)))) {
        // `version.workspace = true` or the inline `version = { workspace = true }`.
        manifest.packageVersionInherited = true;
      }
      continue;
    }
    if (context.kind !== "deps" && context.kind !== "workspace-deps" && context.kind !== "patch") continue;
    const specFor = (key: string): CargoDependencySpec => context.kind === "deps"
      ? entryFor(key, context.section, context.target, lineNumber)
      : context.kind === "patch" ? patchFor(context.source, key, lineNumber) : workspaceFor(key, lineNumber);
    let spec: CargoDependencySpec;
    if (context.sub !== undefined) {
      spec = specFor(context.sub);
      assignField(spec, left, value);
    } else {
      const dotted = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))\.([A-Za-z0-9_-]+)$/.exec(left);
      spec = specFor(unquoteKey(dotted ? dotted[1]! : left));
      if (dotted) assignField(spec, dotted[2]!, value);
      else Object.assign(spec, inlineSpec(value));
    }
    // Evidence lines: where `path` / `workspace = true` were actually written.
    if (spec.path !== undefined && spec.pathLine === undefined) spec.pathLine = lineNumber;
    if (spec.workspace && spec.workspaceLine === undefined) spec.workspaceLine = lineNumber;
  }
  return manifest;
}

export interface CargoLockPackage { name: string; version: string; source?: string; dependencies: string[] }

/** Cargo.lock `[[package]]` blocks. */
export function parseCargoLock(text: string): CargoLockPackage[] {
  const packages: CargoLockPackage[] = [];
  let current: CargoLockPackage | undefined;
  let inDependencies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      current = { name: "", version: "", dependencies: [] };
      packages.push(current);
      inDependencies = false;
      continue;
    }
    if (/^\[/.test(line)) { current = undefined; continue; }
    if (!current) continue;
    if (inDependencies) {
      if (line.startsWith("]")) { inDependencies = false; continue; }
      const item = /^"([^"]+)"/.exec(line);
      if (item) current.dependencies.push(item[1]!);
      continue;
    }
    const field = /^(name|version|source)\s*=\s*"([^"]*)"/.exec(line);
    if (field) { (current as unknown as Record<string, string>)[field[1]!] = field[2]!; continue; }
    const deps = /^dependencies\s*=\s*\[(.*)$/.exec(line);
    if (deps) {
      const rest = deps[1]!;
      for (const item of rest.matchAll(/"([^"]+)"/g)) current.dependencies.push(item[1]!);
      inDependencies = !rest.includes("]");
    }
  }
  return packages.filter(item => item.name && item.version);
}

class CargoLockIndex {
  private readonly byName = new Map<string, CargoLockPackage[]>();
  private readonly closures = new Map<string, Map<string, number>>();
  constructor(readonly path: string, packages: readonly CargoLockPackage[]) {
    for (const item of packages) {
      const list = this.byName.get(item.name) ?? [];
      list.push(item);
      this.byName.set(item.name, list);
    }
  }
  versions(name: string): string[] {
    return [...new Set((this.byName.get(name) ?? []).map(item => item.version))].sort(compareVersions);
  }
  /** Versions of `dependency` that the workspace crate's own lock entry lists (every edge, never just the first). */
  edgeVersions(crate: string, dependency: string): string[] {
    const owner = (this.byName.get(crate) ?? []).find(item => !item.source);
    if (!owner) return [];
    const result = new Set<string>();
    for (const edge of owner.dependencies) {
      const [name, version] = edge.split(" ");
      if (name !== dependency) continue;
      if (version) result.add(version);
      else for (const candidate of this.versions(dependency)) result.add(candidate);
    }
    return [...result].sort(compareVersions);
  }
  private resolveEdge(item: string): CargoLockPackage | undefined {
    const [name, version] = item.split(" ");
    const candidates = this.byName.get(name!) ?? [];
    return version ? candidates.find(candidate => candidate.version === version) : candidates.length === 1 ? candidates[0] : undefined;
  }
  /** Shortest lock-graph distance from (name, version) to every reachable `name@version` (itself at 0). */
  closure(name: string, version: string): Map<string, number> {
    const key = `${name}@${version}`;
    const cached = this.closures.get(key);
    if (cached) return cached;
    const distance = new Map<string, number>();
    let frontier = (this.byName.get(name) ?? []).filter(item => item.version === version);
    for (let depth = 0; frontier.length; depth += 1) {
      const next: CargoLockPackage[] = [];
      for (const item of frontier) {
        const id = `${item.name}@${item.version}`;
        if (distance.has(id)) continue;
        distance.set(id, depth);
        for (const edge of item.dependencies) {
          const resolved = this.resolveEdge(edge);
          if (resolved) next.push(resolved);
        }
      }
      frontier = next;
    }
    this.closures.set(key, distance);
    return distance;
  }
}

// ---------------------------------------------------------------------------
// Import capture

const NODE_BUILTINS = new Set(builtinModules);

/** npm package name of a bare, non-builtin specifier; undefined for relative/URL/builtin/virtual specifiers. */
export function npmDependencyOfSpecifier(specifier: string): string | undefined {
  if (!specifier || /^[./#~]/.test(specifier) || specifier.includes(":")) return undefined;
  const name = packageNameOfSpecifier(specifier);
  if (!name || !/^(?:@[\w.~-]+\/)?[\w.~-]+$/.test(name) || /^[._]/.test(name)) return undefined;
  if (NODE_BUILTINS.has(name) || NODE_BUILTINS.has(specifier)) return undefined;
  return name;
}

export interface CapturedImport { specifier: string; startLine: number; endLine: number; kind: DependencyImportKind; typeOnly: boolean }

/** Static, re-export, dynamic and require module specifiers in one TS/JS file. */
export function typeScriptImports(path: string, text: string): CapturedImport[] {
  const source = parseSource(path, text);
  const found: CapturedImport[] = [];
  const lineOf = (position: number): number => source.getLineAndCharacterOfPosition(position).line + 1;
  const push = (node: TS.Node, specifier: string, kind: DependencyImportKind, typeOnly: boolean): void => {
    found.push({ specifier, startLine: lineOf(node.getStart(source)), endLine: lineOf(node.getEnd()), kind, typeOnly });
  };
  const visit = (node: TS.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, "static", !!node.importClause?.isTypeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      push(node, node.moduleSpecifier.text, "reexport", node.isTypeOnly);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      push(node, node.moduleReference.expression.text, "require", node.isTypeOnly);
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) push(node, node.arguments[0]!.text, "dynamic", false);
      else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) push(node, node.arguments[0]!.text, "require", false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Root path segments of `use` declarations and `extern crate` items (crate/self/super excluded; `r#` stripped). Empty when no Rust parser loads. */
export function rustImportRoots(text: string): Array<{ root: string; specifier: string; startLine: number; endLine: number; kind: "use" | "externCrate" }> {
  if (rustParserUnavailable()) return [];
  const tree = rustParser().parse(text);
  const result: Array<{ root: string; specifier: string; startLine: number; endLine: number; kind: "use" | "externCrate" }> = [];
  const roots = (node: Parser.SyntaxNode | null): string[] => {
    if (!node) return [];
    switch (node.type) {
      case "identifier": return [node.text.replace(/^r#/, "")];
      case "scoped_identifier": {
        const path = node.childForFieldName("path");
        return path ? roots(path) : roots(node.childForFieldName("name"));
      }
      case "scoped_use_list": {
        const path = node.childForFieldName("path");
        return path ? roots(path) : roots(node.childForFieldName("list"));
      }
      case "use_list": return node.namedChildren.flatMap(child => roots(child));
      case "use_as_clause": return roots(node.childForFieldName("path"));
      case "use_wildcard": return roots(node.namedChildren[0] ?? null);
      default: return [];
    }
  };
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "use_declaration") {
      const argument = node.childForFieldName("argument");
      const specifier = (argument?.text ?? "").replace(/\s+/g, " ").slice(0, 200);
      for (const root of new Set(roots(argument))) {
        result.push({ root, specifier, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, kind: "use" });
      }
      return;
    }
    if (node.type === "extern_crate_declaration") {
      const name = node.childForFieldName("name");
      if (name && name.type === "identifier") {
        result.push({ root: name.text.replace(/^r#/, ""), specifier: node.text.replace(/\s+/g, " ").replace(/;$/, "").slice(0, 200), startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, kind: "externCrate" });
      }
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return result;
}

/** tsconfig `compilerOptions.paths` keys (`@lib/*`, `~/*`, `alias`) — local aliases, not packages. */
export function tsconfigPathAliases(text: string): string[] {
  const parsed = ts.parseConfigFileTextToJson("tsconfig.json", text);
  const paths = (parsed.config as { compilerOptions?: { paths?: unknown } } | undefined)?.compilerOptions?.paths;
  return paths && typeof paths === "object" && !Array.isArray(paths) ? Object.keys(paths).sort(compare) : [];
}
function matchesPathAlias(specifier: string, alias: string): boolean {
  const star = alias.indexOf("*");
  if (star < 0) return specifier === alias;
  return specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1)) && specifier.length >= alias.length - 1;
}

// ---------------------------------------------------------------------------
// Facts

export interface DependencyFactsInput {
  commitSha: string;
  /** Discovery source files; only these are read for imports. Order-independent. */
  sourceFiles: readonly string[];
  readFile: (repoRelativePath: string) => string;
  analysisMode: "full" | "quick";
  languageAnalysis?: LanguageAnalysis;
  limits?: Partial<DependencyFactLimits>;
  /**
   * Committed manifests/lockfiles captured BEFORE analyzers ran (see
   * collectDependencyInputs). When set, manifests and lockfiles are read only from
   * here, so a Cargo.lock written by cargo/rust-analyzer is never cited.
   */
  manifestInputs?: ReadonlyMap<string, string>;
  /** Workspace member directories: their package.json is a package even without a name. */
  workspaceDirectories?: readonly string[];
}

/** Read every candidate manifest/lockfile/tsconfig next to (or above) a source file. Call before analyzers run. */
export function collectDependencyInputs(sourceFiles: readonly string[], readFile: (path: string) => string): Map<string, string> {
  const inputs = new Map<string, string>();
  const directories = [...new Set(sourceFiles.flatMap(path => ancestors(dirOf(path))))].sort(compare);
  for (const directory of directories) {
    for (const name of DEPENDENCY_INPUT_FILES) {
      const path = joinPath(directory, name);
      try { inputs.set(path, readFile(path)); } catch { /* absent in the committed tree */ }
    }
  }
  return inputs;
}

interface NpmLock { path: string; kind: "pnpm" | "package-lock" | "yarn"; pnpm?: Map<string, Map<string, string>>; packageLock?: Map<string, { version?: string; link?: boolean }>; yarn?: Map<string, string> }

const NPM_LOCKFILES: Array<[string, NpmLock["kind"]]> = [["pnpm-lock.yaml", "pnpm"], ["package-lock.json", "package-lock"], ["yarn.lock", "yarn"]];

function sortImports(rows: DependencyImport[]): DependencyImport[] {
  return rows.sort((left, right) => compare(left.path, right.path) || left.startLine - right.startLine || left.endLine - right.endLine
    || compare(left.ecosystem, right.ecosystem) || compare(left.dependency, right.dependency) || compare(left.specifier, right.specifier)
    || compare(left.kind, right.kind) || Number(left.typeOnly) - Number(right.typeOnly) || compare(left.consumingPackage, right.consumingPackage));
}
function sortReferences(rows: DependencySymbolReference[]): DependencySymbolReference[] {
  return rows.sort((left, right) => compare(left.path, right.path) || left.startLine - right.startLine || left.endLine - right.endLine
    || compare(left.ecosystem, right.ecosystem) || compare(left.dependency, right.dependency) || compare(left.symbol, right.symbol)
    || compare(left.kind, right.kind) || compare(left.via ?? "", right.via ?? "") || compare(JSON.stringify(left), JSON.stringify(right)));
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Itemized `droppedByDependency` entries per coverage row; the rest are summed in one limitation. */
export const MAX_DROPPED_BY_DEPENDENCY = 50;
const MORE_DROPPED = /^(\d+) more dependenc(?:y|ies) had (\d+) fact\(s\) dropped \(not itemized\)\.$/;

/**
 * Add `extra` dropped rows to a coverage row and bound its size: the top
 * MAX_DROPPED_BY_DEPENDENCY dependencies by dropped count (ties by name) are itemized,
 * the remainder are summed in a single "N more dependencies" limitation.
 */
function withDropped(row: DependencyCoverage, extra: ReadonlyArray<{ dependency: string }>, note?: string): DependencyCoverage {
  const counts = new Map(row.droppedByDependency.map(item => [item.dependency, item.dropped]));
  for (const item of extra) counts.set(item.dependency, (counts.get(item.dependency) ?? 0) + 1);
  let hiddenDependencies = 0;
  let hiddenDropped = 0;
  const limitations = row.limitations.filter(line => {
    const match = MORE_DROPPED.exec(line);
    if (match) { hiddenDependencies += Number(match[1]); hiddenDropped += Number(match[2]); }
    return !match;
  });
  const ranked = [...counts].sort(([leftName, left], [rightName, right]) => right - left || compare(leftName, rightName));
  for (const [, dropped] of ranked.slice(MAX_DROPPED_BY_DEPENDENCY)) { hiddenDependencies += 1; hiddenDropped += dropped; }
  if (hiddenDependencies) limitations.push(`${hiddenDependencies} more ${hiddenDependencies === 1 ? "dependency" : "dependencies"} had ${hiddenDropped} fact(s) dropped (not itemized).`);
  if (note && extra.length) limitations.push(note);
  return {
    ...row,
    status: extra.length && row.status !== "unavailable" ? "partial" : row.status,
    dropped: row.dropped + extra.length,
    droppedByDependency: ranked.slice(0, MAX_DROPPED_BY_DEPENDENCY).sort(([left], [right]) => compare(left, right)).map(([dependency, dropped]) => ({ dependency, dropped })),
    limitations: [...new Set(limitations)].sort(compare),
  };
}

/** Bound every coverage row's itemized drop list (idempotent). */
export function boundDependencyCoverage(facts: DependencyFacts): DependencyFacts {
  return { ...facts, coverage: facts.coverage.map(row => withDropped(row, [])) };
}

/** The minimal valid stand-in when no fact rows fit: packages + coverage saying why. */
function omittedDependencyFacts(facts: DependencyFacts, maxBytes: number): DependencyFacts {
  const coverage = (withPackages: boolean): DependencyFacts => ({
    ...facts, packages: withPackages ? facts.packages : [], declarations: [], imports: [], symbolReferences: [],
    coverage: facts.coverage.map(row => ({
      ecosystem: row.ecosystem, evidence: row.evidence, status: "unavailable" as const,
      limitations: [DEPENDENCY_FACTS_OMITTED_LIMIT], droppedByDependency: [],
      dropped: row.dropped + (facts[row.evidence] as ReadonlyArray<{ ecosystem: DependencyEcosystem }>).filter(item => item.ecosystem === row.ecosystem).length,
    })),
  });
  const full = coverage(true);
  return byteLength(full) <= maxBytes ? full : coverage(false);
}

/**
 * Deterministically trim facts to a compact-JSON byte budget, measured on the final
 * object (coverage included): symbol references go first, then imports, then
 * declarations; rows keep their canonical order and every dropped row is counted.
 * When not even the empty skeleton fits, a minimal stand-in carrying
 * DEPENDENCY_FACTS_OMITTED_LIMIT is returned (it may still exceed a tiny budget —
 * callers that must fit check the size).
 */
export function fitDependencyFacts(facts: DependencyFacts, maxBytes: number): DependencyFacts {
  const bounded = boundDependencyCoverage(facts);
  if (byteLength(bounded) <= maxBytes) return bounded;
  const tiers = [bounded.declarations, bounded.imports, bounded.symbolReferences] as const;
  const total = tiers.reduce((sum, rows) => sum + rows.length, 0);
  const note = `Trimmed to the ${maxBytes}-byte dependency fact budget (symbol references first, then imports, then declarations; canonical order kept).`;
  const build = (keep: number): DependencyFacts => {
    let rest = keep;
    const kept = tiers.map(rows => { const count = Math.min(rest, rows.length); rest -= count; return count; });
    const dropped = tiers.map((rows, index) => rows.slice(kept[index]) as ReadonlyArray<{ ecosystem: DependencyEcosystem; dependency: string }>);
    const tierOf = { declarations: 0, imports: 1, symbolReferences: 2 } as const;
    return {
      ...bounded,
      declarations: bounded.declarations.slice(0, kept[0]),
      imports: bounded.imports.slice(0, kept[1]),
      symbolReferences: bounded.symbolReferences.slice(0, kept[2]),
      coverage: bounded.coverage.map(row => withDropped(row, dropped[tierOf[row.evidence]]!.filter(item => item.ecosystem === row.ecosystem), note)),
    };
  };
  if (byteLength(build(0)) > maxBytes) return omittedDependencyFacts(bounded, maxBytes);
  // Largest prefix (in priority order) whose final serialized form fits.
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (byteLength(build(middle)) <= maxBytes) low = middle; else high = middle - 1;
  }
  return build(low);
}

export function buildDependencyFacts(input: DependencyFactsInput): DependencyFacts {
  const limits: DependencyFactLimits = { ...DEPENDENCY_FACT_LIMITS, ...input.limits };
  const sourceFiles = [...new Set(input.sourceFiles)].sort(compare);
  const cache = new Map<string, string | undefined>();
  const tryRead = (path: string): string | undefined => {
    if (input.manifestInputs) return input.manifestInputs.get(path);
    if (!cache.has(path)) {
      let text: string | undefined;
      try { text = input.readFile(path); } catch { text = undefined; }
      cache.set(path, text);
    }
    return cache.get(path);
  };
  const readSource = (path: string): string | undefined => {
    try { return input.readFile(path); } catch { return undefined; }
  };
  const directories = [...new Set(sourceFiles.flatMap(path => ancestors(dirOf(path))))].sort(compare);
  const workspaceDirectories = new Set(input.workspaceDirectories ?? []);
  const limitations = perEcosystem(() => ({ declarations: new Set<string>(), imports: new Set<string>(), symbolReferences: new Set<string>() }) as Record<DependencyEvidenceKind, Set<string>>);
  const skipped = perEcosystem(() => ({ declarations: 0, imports: 0, symbolReferences: 0 }) as Record<DependencyEvidenceKind, number>);
  const unowned = perEcosystem(() => ({ imports: 0, symbolReferences: 0 }));
  const unreadable = perEcosystem(() => 0);
  let markerManifests = 0;
  let aliasSkipped = 0;

  // Packages ---------------------------------------------------------------
  const packages: DependencyPackage[] = [];
  const npmManifests = new Map<string, { name?: string; entries: NpmManifestEntry[] }>();
  const cargoManifests = new Map<string, CargoManifest>();
  const pathAliases = new Map<string, string[]>();
  for (const directory of directories) {
    const packageJson = joinPath(directory, "package.json");
    const npmText = tryRead(packageJson);
    if (npmText !== undefined && validRepoPath(packageJson)) {
      try {
        const parsed = parsePackageJsonDependencies(npmText);
        if (parsed.marker && !workspaceDirectories.has(directory)) markerManifests += 1;
        else {
          npmManifests.set(packageJson, parsed);
          const name = parsed.name && !CONTROL_CHARACTERS.test(parsed.name) && parsed.name.length <= 214 ? parsed.name : (directory || "(root)");
          packages.push({ ecosystem: "npm", name, manifestPath: packageJson, directory });
        }
      } catch { limitations.npm.declarations.add(`${sanitizeControlCharacters(packageJson)}: not a valid JSON object; its declarations were not read.`); }
    }
    const cargoToml = joinPath(directory, "Cargo.toml");
    const cargoText = tryRead(cargoToml);
    if (cargoText !== undefined && validRepoPath(cargoToml)) {
      const parsed = parseCargoManifest(cargoText);
      cargoManifests.set(cargoToml, parsed);
      if (parsed.packageName && validName("cargo", parsed.packageName)) packages.push({ ecosystem: "cargo", name: parsed.packageName, manifestPath: cargoToml, directory });
      else if (parsed.packageName) skipped.cargo.declarations += 1;
    }
    const tsconfig = tryRead(joinPath(directory, "tsconfig.json"));
    if (tsconfig !== undefined) {
      try { const aliases = tsconfigPathAliases(tsconfig); if (aliases.length) pathAliases.set(directory, aliases); } catch { /* unparsable tsconfig: no aliases */ }
    }
  }
  if (markerManifests) limitations.npm.declarations.add(`${markerManifests} marker package.json file(s) (no name, dependency section or workspace membership) were not treated as packages; their files belong to the nearest real package.`);
  packages.sort((left, right) => compare(left.manifestPath, right.manifestPath));
  const ownersByDepth = [...packages].sort((left, right) => right.directory.length - left.directory.length || compare(left.manifestPath, right.manifestPath));
  const ownerOf = (path: string, ecosystem: DependencyEcosystem): DependencyPackage | undefined =>
    ownersByDepth.find(item => item.ecosystem === ecosystem && (item.directory === "" || path.startsWith(`${item.directory}/`)));
  const nearest = <T>(directory: string, pick: (candidate: string) => T | undefined): T | undefined => {
    for (const candidate of ancestors(directory)) {
      const found = pick(candidate);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  // npm declarations ----------------------------------------------------------
  const npmLocks = new Map<string, NpmLock | null>();
  const npmLockFor = (directory: string): NpmLock | undefined => nearest(directory, candidate => {
    if (npmLocks.has(candidate)) return npmLocks.get(candidate) ?? undefined;
    let lock: NpmLock | null = null;
    for (const [file, kind] of NPM_LOCKFILES) {
      const path = joinPath(candidate, file);
      const text = tryRead(path);
      if (text === undefined) continue;
      try {
        lock = kind === "pnpm" ? { path, kind, pnpm: parsePnpmLockImporters(text) }
          : kind === "package-lock" ? { path, kind, packageLock: parsePackageLock(text) }
            : { path, kind, yarn: parseYarnLock(text) };
      } catch { limitations.npm.declarations.add(`${path}: could not be parsed; versions from it are unresolved.`); }
      break;
    }
    npmLocks.set(candidate, lock);
    return lock ?? undefined;
  });
  const declarations: DependencyDeclaration[] = [];
  const pushDeclaration = (row: DependencyDeclaration): void => {
    const names = [row.dependency, ...(row.alias ? [row.alias] : [])];
    if (!names.every(name => validName(row.ecosystem, name))) { skipped[row.ecosystem].declarations += 1; return; }
    declarations.push({ ...row, ...(row.reason ? { reason: sanitizeControlCharacters(row.reason) } : {}), ...(row.target ? { target: sanitizeControlCharacters(row.target) } : {}) });
  };
  for (const [manifestPath, manifest] of npmManifests) {
    const directory = dirOf(manifestPath);
    for (const entry of manifest.entries) {
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@(.*))?$/.exec(entry.spec);
      const dependency = alias ? alias[1]! : entry.key;
      const local = /^(workspace|file|link|portal):/.test(entry.spec);
      const base = {
        ecosystem: "npm" as const, dependency, ...(alias && alias[1] !== entry.key ? { alias: entry.key } : {}),
        declaringPackage: manifestPath, section: entry.section as DependencySection, requested: redactSpec(entry.spec),
        source: { path: manifestPath, ...(entry.line ? { line: entry.line } : {}) },
      };
      if (local) { pushDeclaration({ ...base, local: true, resolution: "local", resolvedVersions: [] }); continue; }
      const lock = npmLockFor(directory);
      if (!lock) {
        pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], reason: "No npm lockfile (pnpm-lock.yaml, package-lock.json, yarn.lock) at or above this package." });
        continue;
      }
      let version: string | undefined;
      const relative = relativeDirectory(dirOf(lock.path), directory);
      if (lock.pnpm) version = lock.pnpm.get(relative || ".")?.get(entry.key);
      else if (lock.packageLock) {
        for (let current = relative; ; current = dirOf(current)) {
          const found = lock.packageLock.get(joinPath(current, `node_modules/${entry.key}`));
          if (found) { version = found.link ? "link:" : found.version; break; }
          if (!current) break;
        }
      } else if (lock.yarn) version = lock.yarn.get(`${entry.key}@${entry.spec}`) ?? lock.yarn.get(`${entry.key}@npm:${entry.spec}`);
      const normalized = version === undefined ? undefined : normalizeLockVersion(version);
      if (normalized?.kind === "local") pushDeclaration({ ...base, local: true, resolution: "local", resolvedVersions: [], lockfilePath: lock.path });
      else if (normalized?.kind === "version") pushDeclaration({ ...base, local: false, resolution: "resolved", resolvedVersions: [normalized.version], lockfilePath: lock.path });
      else if (normalized?.kind === "source") {
        pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], lockfilePath: lock.path, reason: `${lock.path} pins a non-registry source (git, tarball or URL); no registry version is recorded.` });
      } else {
        const reason = entry.section === "peerDependencies"
          ? `Peer dependency: provided by the installing consumer; no ${lock.path} entry for this package.`
          : `No ${lock.path} entry for this dependency in this package${lock.kind === "yarn" ? " (yarn.lock lookup is best-effort by descriptor)" : ""}.`;
        pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], lockfilePath: lock.path, reason });
      }
    }
  }

  // Cargo declarations ---------------------------------------------------------
  const cargoLocks = new Map<string, CargoLockIndex | null>();
  const cargoLockFor = (directory: string): CargoLockIndex | undefined => nearest(directory, candidate => {
    if (cargoLocks.has(candidate)) return cargoLocks.get(candidate) ?? undefined;
    const path = joinPath(candidate, "Cargo.lock");
    const text = tryRead(path);
    const lock = text === undefined ? null : new CargoLockIndex(path, parseCargoLock(text));
    cargoLocks.set(candidate, lock);
    return lock ?? undefined;
  });
  const workspaceRootFor = (directory: string): CargoManifest | undefined => nearest(directory, candidate => {
    const manifest = cargoManifests.get(joinPath(candidate, "Cargo.toml"));
    return manifest?.isWorkspace ? manifest : undefined;
  });
  for (const [manifestPath, manifest] of cargoManifests) {
    if (!manifest.packageName || !validName("cargo", manifest.packageName)) continue;
    const directory = dirOf(manifestPath);
    for (const entry of manifest.entries) {
      let spec: CargoDependencySpec = entry;
      let inherited = false;
      let missingWorkspace = false;
      if (entry.workspace) {
        inherited = true;
        const root = workspaceRootFor(directory)?.workspaceDependencies.get(entry.key);
        if (root) spec = { ...root, ...(entry.package ? { package: entry.package } : {}) };
        else missingWorkspace = true;
      }
      const dependency = spec.package ?? entry.key;
      const requested = spec.version ?? (spec.path !== undefined ? `path:${spec.path}` : spec.git !== undefined ? `git:${spec.git}${spec.gitRef ? `#${spec.gitRef}` : ""}` : inherited ? "workspace" : "*");
      const base = {
        ecosystem: "cargo" as const, dependency, ...(dependency !== entry.key ? { alias: entry.key } : {}),
        declaringPackage: manifestPath, section: entry.section as DependencySection, ...(entry.target ? { target: entry.target } : {}),
        requested: redactSpec(requested), ...(inherited ? { workspaceInherited: true } : {}),
        source: { path: manifestPath, line: entry.line },
      };
      if (missingWorkspace) {
        pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], reason: "workspace = true, but no matching [workspace.dependencies] entry was found." });
        continue;
      }
      if (spec.path !== undefined) { pushDeclaration({ ...base, local: true, resolution: "local", resolvedVersions: [] }); continue; }
      const lock = cargoLockFor(directory);
      if (!lock) {
        pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], reason: "No committed Cargo.lock at or above this crate." });
        continue;
      }
      const candidates = lock.versions(dependency);
      const edges = lock.edgeVersions(manifest.packageName, dependency);
      const pool = edges.length ? edges : candidates;
      // Choose by the requested range; never take an arbitrary (first) lock edge.
      const matching = spec.version !== undefined && pool.length > 1 ? pool.filter(version => cargoRequirementMatches(spec.version!, version) === true) : pool;
      if (!candidates.length) pushDeclaration({ ...base, local: false, resolution: "unresolved", resolvedVersions: [], lockfilePath: lock.path, reason: `${dependency} is not present in ${lock.path}.` });
      else if (matching.length === 1) pushDeclaration({ ...base, local: false, resolution: "resolved", resolvedVersions: matching, lockfilePath: lock.path });
      else pushDeclaration({ ...base, local: false, resolution: "ambiguous", resolvedVersions: pool, lockfilePath: lock.path, reason: `${lock.path} holds ${pool.length} candidate versions of ${dependency}; neither the crate's lock entry nor the requested range selects exactly one.` });
    }
  }
  declarations.sort((left, right) => compare(left.ecosystem, right.ecosystem) || compare(left.dependency, right.dependency)
    || compare(left.declaringPackage, right.declaringPackage) || compare(left.section, right.section)
    || compare(left.target ?? "", right.target ?? "") || compare(left.alias ?? "", right.alias ?? "") || compare(left.requested, right.requested));
  const declarationsByPackage = new Map<string, DependencyDeclaration[]>();
  for (const row of declarations) {
    const list = declarationsByPackage.get(row.declaringPackage) ?? [];
    list.push(row);
    declarationsByPackage.set(row.declaringPackage, list);
  }
  /** Map a name used in code (alias / rename key) to the declared package, per consuming package. */
  const canonicalNpm = (manifestPath: string, name: string): string =>
    declarationsByPackage.get(manifestPath)?.find(row => row.alias === name)?.dependency ?? name;

  // Imports -------------------------------------------------------------------
  const imports: DependencyImport[] = [];
  for (const path of sourceFiles) {
    const isRust = path.endsWith(".rs");
    if (!isRust && !/\.[cm]?[jt]sx?$/.test(path)) continue;
    const ecosystem: DependencyEcosystem = isRust ? "cargo" : "npm";
    if (!validRepoPath(path)) { skipped[ecosystem].imports += 1; continue; }
    const text = readSource(path);
    if (text === undefined) { unreadable[ecosystem] += 1; continue; }
    const owner = ownerOf(path, ecosystem);
    if (isRust) {
      if (!owner) { unowned.cargo.imports += 1; continue; }
      const idents = new Map<string, string>();
      for (const row of declarationsByPackage.get(owner.manifestPath) ?? []) idents.set((row.alias ?? row.dependency).replace(/-/g, "_"), row.dependency);
      for (const found of rustImportRoots(text)) {
        const dependency = idents.get(found.root);
        if (!dependency) continue;
        imports.push({ ecosystem: "cargo", dependency, specifier: sanitizeControlCharacters(found.specifier || found.root), path, startLine: found.startLine, endLine: found.endLine, consumingPackage: owner.manifestPath, kind: found.kind, typeOnly: false });
      }
    } else {
      const captured = typeScriptImports(path, text).filter(item => npmDependencyOfSpecifier(item.specifier));
      if (!captured.length) continue;
      if (!owner) { unowned.npm.imports += 1; continue; }
      const aliases = ancestors(dirOf(path)).flatMap(directory => pathAliases.get(directory) ?? []);
      const declared = new Set((declarationsByPackage.get(owner.manifestPath) ?? []).flatMap(row => [row.dependency, row.alias ?? row.dependency]));
      for (const item of captured) {
        const name = npmDependencyOfSpecifier(item.specifier)!;
        // `@lib/*` from tsconfig paths is a local alias unless the package really declares that name.
        if (!declared.has(name) && aliases.some(alias => matchesPathAlias(item.specifier, alias))) { aliasSkipped += 1; continue; }
        const dependency = canonicalNpm(owner.manifestPath, name);
        if (!validName("npm", dependency)) { skipped.npm.imports += 1; continue; }
        imports.push({ ecosystem: "npm", dependency, specifier: sanitizeControlCharacters(item.specifier), path,
          startLine: item.startLine, endLine: item.endLine, consumingPackage: owner.manifestPath, kind: item.kind, typeOnly: item.typeOnly });
      }
    }
  }
  const importKey = (row: DependencyImport): string => JSON.stringify([row.ecosystem, row.path, row.startLine, row.endLine, row.consumingPackage, row.dependency, row.specifier, row.kind, row.typeOnly]);
  const dedupedImports = sortImports([...new Map(imports.map(row => [importKey(row), row])).values()]);
  const keptImports = dedupedImports.slice(0, limits.maxImports);
  const droppedImports = dedupedImports.slice(limits.maxImports);

  // Symbol references --------------------------------------------------------------
  const counters = { unattributedTransitive: 0 };
  const references: DependencySymbolReference[] = [];
  const allowedPaths = new Set(sourceFiles);
  const ident = (name: string): string => name.replace(/-/g, "_");
  const attribute = (external: AnalysisExternalReference, manifestPath: string): DependencySymbolReference => {
    const base = {
      ecosystem: external.ecosystem, path: external.path, startLine: external.startLine, endLine: external.endLine,
      consumingPackage: manifestPath, symbol: sanitizeControlCharacters(external.symbol), kind: external.kind,
      typeOnly: external.typeOnly === true, analyzer: sanitizeControlCharacters(external.analyzer),
    };
    if (external.ecosystem === "npm") {
      return { ...base, dependency: canonicalNpm(manifestPath, external.package), ...(external.via ? { via: external.via } : {}) };
    }
    const declared = (declarationsByPackage.get(manifestPath) ?? []).filter(row => row.ecosystem === "cargo" && !row.local);
    const direct = declared.find(row => ident(row.dependency) === ident(external.package));
    if (direct) return { ...base, dependency: direct.dependency, ...(external.version ? { resolvedVersion: external.version } : {}) };
    // A re-exported or macro-provided item (`wgpu::Color` defined in wgpu-types, a derive
    // from `serde_derive`): attribute to the declared crate NEAREST to the defining crate in
    // the Cargo.lock graph; a tie is broken only by the facade naming convention
    // (`wgpu` → `wgpu-types`, `serde` → `serde_core`). Anything else stays unattributed.
    const lock = cargoLockFor(dirOf(manifestPath));
    const target = `${external.package}@${external.version}`;
    const reach = new Map<string, number>();
    if (lock && external.version) {
      for (const row of declared) for (const version of row.resolvedVersions) {
        const depth = lock.closure(row.dependency, version).get(target);
        if (depth !== undefined) reach.set(row.dependency, Math.min(depth, reach.get(row.dependency) ?? depth));
      }
    }
    const nearestDepth = Math.min(...reach.values());
    let candidates = [...reach].filter(([, depth]) => depth === nearestDepth).map(([name]) => name).sort(compare);
    if (candidates.length > 1) {
      const facade = candidates.filter(name => ident(external.package).startsWith(`${ident(name)}_`));
      if (facade.length === 1) candidates = facade;
    }
    if (candidates.length === 1) {
      const resolved = declared.find(row => row.dependency === candidates[0] && row.resolution === "resolved")?.resolvedVersions[0];
      return { ...base, dependency: candidates[0]!, via: external.package, ...(resolved ? { resolvedVersion: resolved } : {}) };
    }
    counters.unattributedTransitive += 1;
    return { ...base, dependency: external.package, ...(external.version ? { resolvedVersion: external.version } : {}) };
  };
  for (const external of input.languageAnalysis?.externalReferences ?? []) {
    if (!allowedPaths.has(external.path)) continue;
    if (!validRepoPath(external.path) || !(external.endLine >= external.startLine && external.startLine >= 1)) { skipped[external.ecosystem].symbolReferences += 1; continue; }
    const owner = ownerOf(external.path, external.ecosystem);
    if (!owner) { unowned[external.ecosystem].symbolReferences += 1; continue; }
    const row = attribute(external, owner.manifestPath);
    if (!validName(row.ecosystem, row.dependency) || !row.symbol || (row.via !== undefined && !validName(row.ecosystem, row.via))) { skipped[row.ecosystem].symbolReferences += 1; continue; }
    references.push(row);
  }
  const referenceKey = (row: DependencySymbolReference): string => JSON.stringify([row.ecosystem, row.path, row.startLine, row.endLine, row.consumingPackage, row.dependency, row.symbol, row.kind, row.typeOnly, row.via ?? "", row.analyzer, row.resolvedVersion ?? ""]);
  const dedupedReferences = sortReferences([...new Map(references.map(row => [referenceKey(row), row])).values()]);
  const perGroup = new Map<string, number>();
  const cappedPerFile: DependencySymbolReference[] = [];
  const droppedReferences: DependencySymbolReference[] = [];
  for (const row of dedupedReferences) {
    const group = `${row.ecosystem}\u0000${row.dependency}\u0000${row.path}`;
    const count = perGroup.get(group) ?? 0;
    perGroup.set(group, count + 1);
    (count < limits.maxSymbolReferencesPerDependencyFile ? cappedPerFile : droppedReferences).push(row);
  }
  const keptReferences = cappedPerFile.slice(0, limits.maxSymbolReferences);
  droppedReferences.push(...cappedPerFile.slice(limits.maxSymbolReferences));

  // Coverage ------------------------------------------------------------------------
  const ecosystems = new Set<DependencyEcosystem>();
  for (const item of packages) ecosystems.add(item.ecosystem);
  for (const path of sourceFiles) {
    if (path.endsWith(".rs")) ecosystems.add("cargo");
    else if (/\.[cm]?[jt]sx?$/.test(path)) ecosystems.add("npm");
  }
  const scopeLimit = "Partial by construction: manifests and lockfiles are read only at directories that contain scanned source files (and their ancestors), from the committed tree.";
  limitations.npm.declarations.add(scopeLimit);
  limitations.cargo.declarations.add(scopeLimit);
  limitations.cargo.declarations.add("Cargo.toml is read line-by-line (no TOML parser): comments are stripped and multi-line inline tables joined, but unusual quoting or dotted tables may be missed.");
  limitations.npm.declarations.add("npm lockfiles: pnpm-lock.yaml importers (v5/v6/v9), package-lock.json v2/v3 packages, yarn.lock by descriptor (v1; berry best-effort). Git/URL/tarball pins are reported unresolved, not as versions.");
  const importScope = "Only discovered source files are read (tests, declaration files and generated output are excluded by discovery).";
  limitations.npm.imports.add(importScope);
  limitations.cargo.imports.add(importScope);
  limitations.npm.imports.add("Relative specifiers, Node built-ins, URL/virtual specifiers, computed specifiers and type-position import('…') types are not recorded.");
  limitations.npm.imports.add("tsconfig `paths` aliases are read from tsconfig.json files next to scanned sources (no `extends`); a bare specifier matching one is skipped unless the package declares that name.");
  if (aliasSkipped) limitations.npm.imports.add(`${aliasSkipped} import(s) matched a tsconfig paths alias and were skipped as local.`);
  limitations.cargo.imports.add("Only `use` declarations and `extern crate` whose root is a crate declared by the owning Cargo.toml; fully qualified paths without `use` appear only as symbol references (full scan).");
  limitations.cargo.imports.add("A crate whose library name differs from its package name (e.g. md-5 → md5, `[lib] name`), and a later `use` through an `extern crate x as y` alias, are not matched; raw identifiers (`r#name`) are normalized.");
  const noRustParser = ecosystems.has("cargo") ? rustParserUnavailable() : undefined;
  if (noRustParser) limitations.cargo.imports.add(sanitizeControlCharacters(`No Rust imports were read. ${noRustParser}`));
  for (const ecosystem of ECOSYSTEM_LIST) {
    if (unowned[ecosystem].imports) limitations[ecosystem].imports.add(`${unowned[ecosystem].imports} file(s) with dependency evidence have no owning ${ecosystem === "npm" ? "package.json" : "Cargo.toml [package]"} and were skipped.`);
    if (unowned[ecosystem].symbolReferences) limitations[ecosystem].symbolReferences.add(`${unowned[ecosystem].symbolReferences} reference(s) in files without an owning ${ecosystem === "npm" ? "package.json" : "Cargo.toml [package]"} were skipped.`);
    if (unreadable[ecosystem]) limitations[ecosystem].imports.add(`${unreadable[ecosystem]} discovered source file(s) could not be read.`);
    for (const evidence of ["declarations", "imports", "symbolReferences"] as const) {
      if (skipped[ecosystem][evidence]) limitations[ecosystem][evidence].add(`${skipped[ecosystem][evidence]} row(s) with invalid names or paths were skipped at capture.`);
    }
  }
  const analysisCoverage = input.languageAnalysis?.coverage ?? [];
  const symbolStatus: Record<DependencyEcosystem, DependencyCoverage["status"]> = { npm: "partial", cargo: "partial" };
  if (input.analysisMode !== "full" || !input.languageAnalysis) {
    symbolStatus.npm = symbolStatus.cargo = "unavailable";
    limitations.npm.symbolReferences.add("Symbol references unavailable for TypeScript/JavaScript: compiler analysis not run (quick scan).");
    limitations.cargo.symbolReferences.add("Symbol references unavailable for Rust: rust-analyzer not run (quick scan).");
  } else {
    const tsCoverage = analysisCoverage.filter(row => row.tool === "typescript");
    const tsLimits = new Set(tsCoverage.flatMap(row => row.limitations));
    const reused = [...tsLimits].find(limit => /Installed dependency types reused/.test(limit));
    const notReused = [...tsLimits].find(limit => /dependency context not reused/i.test(limit));
    const notInstalled = [...tsLimits].some(limit => /No local dependency installation found/.test(limit));
    const observedNpm = (input.languageAnalysis.externalReferences ?? []).some(row => row.ecosystem === "npm");
    if (!tsCoverage.length || tsCoverage.every(row => row.coverage === "unavailable")) {
      symbolStatus.npm = "unavailable";
      limitations.npm.symbolReferences.add("Symbol references unavailable for TypeScript/JavaScript: no files were semantically indexed.");
    } else if (notReused) {
      symbolStatus.npm = "unavailable";
      limitations.npm.symbolReferences.add(`npm symbol references unavailable: ${sanitizeControlCharacters(notReused)}`);
    } else if (notInstalled || (!reused && !observedNpm)) {
      symbolStatus.npm = "unavailable";
      limitations.npm.symbolReferences.add("No local dependency installation found; npm symbol references unavailable.");
    } else {
      if (reused) limitations.npm.symbolReferences.add(sanitizeControlCharacters(reused));
      limitations.npm.symbolReferences.add("Resolved only where installed dependency type declarations were available to the compiler; packages without installed or bundled types yield imports but no references.");
      limitations.npm.symbolReferences.add("Attributed to the package whose declaration file defines the symbol (`@types/x` → x); a type re-exported from another package is attributed to that package. Node built-ins (@types/node), compiler lib types, and JSX intrinsic tag/attribute names are excluded. Type positions (incl. `typeof x` in a type) and `import type` bindings are marked typeOnly; value-position reads of interface-declared members (e.g. `req.query`) count as runtime.");
      const unresolvedModules = [...tsLimits].filter(limit => /TS(2307|7016):/.test(limit)).length;
      if (unresolvedModules) limitations.npm.symbolReferences.add(`${unresolvedModules} unresolved module / missing type declaration diagnostic(s) (TS2307/TS7016); references through those imports are absent.`);
    }
    const rustCoverage = analysisCoverage.filter(row => row.language === "rust");
    if (!rustCoverage.length || rustCoverage.every(row => row.coverage === "unavailable")) {
      symbolStatus.cargo = "unavailable";
      const reasons = rustCoverage.flatMap(row => row.limitations);
      limitations.cargo.symbolReferences.add(sanitizeControlCharacters(`Symbol references unavailable for Rust: rust-analyzer ${rustCoverage.length ? `unavailable (${reasons.slice(0, 2).join("; ").slice(0, 300) || "no files indexed"})` : "did not index any file"}.`));
    } else {
      limitations.cargo.symbolReferences.add("rust-analyzer SCIP with Cargo's default features and host target (plus inferred wasm32 where source is cfg-gated); std/core/alloc are excluded.");
      limitations.cargo.symbolReferences.add("Items defined in a transitive crate (re-exports, derive macros) are attributed to the declared dependency nearest to it in the Cargo.lock graph, ties broken only by facade naming (`wgpu` → `wgpu-types`); `via` names the defining crate. Otherwise the defining crate itself is named.");
      for (const row of rustCoverage) for (const limit of row.limitations) if (/target|feature|Not indexed/i.test(limit)) limitations.cargo.symbolReferences.add(sanitizeControlCharacters(limit.slice(0, 500)));
      if (counters.unattributedTransitive) limitations.cargo.symbolReferences.add(`${counters.unattributedTransitive} reference(s) to transitive crates could not be attributed to one declared dependency and name the defining crate.`);
    }
  }
  const dropCounts = (rows: ReadonlyArray<{ ecosystem: DependencyEcosystem; dependency: string }>, ecosystem: DependencyEcosystem): Array<{ dependency: string; dropped: number }> => {
    const counts = new Map<string, number>();
    for (const row of rows) if (row.ecosystem === ecosystem) counts.set(row.dependency, (counts.get(row.dependency) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => compare(left, right)).map(([dependency, dropped]) => ({ dependency, dropped }));
  };
  for (const ecosystem of ECOSYSTEM_LIST) {
    if (droppedImports.some(row => row.ecosystem === ecosystem)) limitations[ecosystem].imports.add(`Capped at ${limits.maxImports} imports in total (sorted by path, line).`);
    if (droppedReferences.some(row => row.ecosystem === ecosystem)) {
      limitations[ecosystem].symbolReferences.add(`Capped at ${limits.maxSymbolReferencesPerDependencyFile} references per dependency per file and ${limits.maxSymbolReferences} in total (sorted by path, line).`);
    }
  }
  const coverage: DependencyCoverage[] = [];
  for (const ecosystem of [...ecosystems].sort(compare)) {
    for (const evidence of ["declarations", "imports", "symbolReferences"] as const) {
      const dropped = evidence === "imports" ? dropCounts(droppedImports, ecosystem) : evidence === "symbolReferences" ? dropCounts(droppedReferences, ecosystem) : [];
      const total = dropped.reduce((sum, item) => sum + item.dropped, 0);
      // Declarations are always partial (see scope limits). Imports are "complete" when every
      // discovered source file of the ecosystem was read, owned and fully recorded (nothing
      // capped, skipped or unreadable) — complete within the stated capture rules, not beyond them.
      const status: DependencyCoverage["status"] = evidence === "symbolReferences" ? symbolStatus[ecosystem]
        : evidence === "declarations" ? "partial"
          : ecosystem === "cargo" && noRustParser ? "unavailable"
          : total || unowned[ecosystem].imports || unreadable[ecosystem] || skipped[ecosystem].imports ? "partial" : "complete";
      coverage.push({ ecosystem, evidence, status, limitations: [...limitations[ecosystem][evidence]].map(sanitizeControlCharacters).sort(compare), dropped: total, droppedByDependency: dropped });
    }
  }

  const facts: DependencyFacts = fitDependencyFacts({
    schemaVersion: 1,
    commitSha: input.commitSha,
    packages,
    declarations,
    imports: keptImports,
    symbolReferences: keptReferences,
    coverage,
  }, limits.maxFactBytes);
  // Capture must never abort an export: anything the loader would reject is dropped here.
  try {
    validateDependencyFacts(facts, input.commitSha);
    return facts;
  } catch (error) {
    const note = sanitizeControlCharacters(`Dependency facts failed validation and were omitted: ${error instanceof Error ? error.message : String(error)}`).slice(0, 500);
    return {
      schemaVersion: 1, commitSha: input.commitSha, packages: [], declarations: [], imports: [], symbolReferences: [],
      coverage: [...ecosystems].sort(compare).flatMap(ecosystem => (["declarations", "imports", "symbolReferences"] as const).map(evidence => ({
        ecosystem, evidence, status: "unavailable" as const, limitations: [note], dropped: 0, droppedByDependency: [],
      }))),
    };
  }
}
