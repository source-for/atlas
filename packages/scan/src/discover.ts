import { scanExecFileSync } from "./scan-env.js";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import ts from "typescript";
import { resolveRelativeImport } from "./extract.js";
import { slug } from "./ids.js";
import {
  classifyFsSymlink,
  countSymlink,
  emptySkippedEntries,
  hasSkippedEntries,
  isBufferOverflow,
  mergeSkippedEntries,
  safeRegularFile,
  SCAN_SIZE_LIMITS,
  ScanSizeLimitError,
  walkRegularFiles,
  type ScanSizeLimits,
  type SkippedTreeEntries,
} from "./source-tree.js";

/**
 * A container-level unit of the repository: a workspace member, the whole repo
 * (single-package mode), the synthetic "tooling" bucket for non-member scripts, or
 * a Rust crate (`.rs` outlined via tree-sitter). Import resolution maps a workspace package
 * name to a unit via `packageName`.
 */
export interface SourceUnit {
  kind: "member" | "root" | "tooling" | "rust";
  /**
   * The unit key (`unitByFile` value): the member/crate directory, the root slug, or
   * {@link TOOLING_UNIT_KEY} for the synthetic bucket. The container id is derived
   * via `slug`, so the bucket is still `container:tooling`.
   */
  dir: string;
  name: string;
  /**
   * The npm package name. On a `rust` unit it is set only when the same directory is
   * also a JS workspace member (the crate owns the dir; the npm name still maps to it).
   */
  packageName?: string;
  /**
   * Repository-relative path of the unit's own `package.json`, when it has one: every
   * member, the root unit (if the root manifest exists), and a `rust` unit whose dir
   * is also a JS member. THE predicate for "this unit has npm manifest facts"
   * (runtime dependencies, exports/main/types, bin) — never test `kind` for that.
   */
  packageManifest?: string;
  /** Repository-relative anchor for the container. */
  evidencePath: string;
}

/**
 * Unit key of the synthetic non-member bucket. It can never be a repository path
 * (NUL is not a valid path byte), so a workspace member literally named `tooling`
 * keeps its own unit instead of sharing — and losing its files to — the bucket.
 * `slug` drops the NUL, so the container id stays `container:tooling`.
 */
export const TOOLING_UNIT_KEY = "\0tooling";

/** Visible accounting of what discovery included and deliberately left out. */
export interface DiscoverySummary {
  /** No workspace members — the whole repo is one container. */
  singlePackage: boolean;
  /**
   * True for a pure-JS repo (every `.js` scanned). False for a TypeScript repo (root
   * tsconfig or any TS source), where `.js` is scanned except the files
   * {@link jsSkipReason} leaves out.
   */
  includedJs: boolean;
  /** `.js` files left out of a TypeScript repo, all reasons together (never silent). */
  skippedJsFiles: number;
  /** `skippedJsFiles` split by reason. Present only when `skippedJsFiles` is non-zero. */
  skippedJsByReason?: SkippedJsByReason;
  /** Workspace members skipped as fixtures/examples/playgrounds/e2e. */
  skippedMembers: string[];
  /**
   * Pure re-export shims outside every workspace member (e.g. a root Vercel
   * `api/share.ts` that is only `export { default } from '../apps/web/api/share.ts'`)
   * folded into the unit that owns their target instead of becoming a second
   * component in the tooling bucket. Sorted by `path`. Never evidence (not a
   * sourceRef): persisted in the scan's membership report / portable-atlas
   * `analysis.membership`, and importers of a shim resolve to its target.
   */
  reexportAliases?: ReexportAlias[];
  /**
   * Tracked symlinks (in-repo ones kept for config/imports; escaping, dangling and looping ones removed) and submodules, none scanned as source files (CLA-299).
   * Present only when at least one count is non-zero; rendered into the scan's
   * `analysis.limitations`.
   */
  skippedEntries?: SkippedTreeEntries;
  /**
   * Source-extension files excluded because they live under a conventional test-data
   * directory (see `isTestDataPath`). Present only when non-zero.
   */
  excludedTestDataFiles?: number;
}

/** Why a `.js` file in a TypeScript repo was not scanned; see {@link jsSkipReason}. */
export interface SkippedJsByReason {
  /** Under a `test`/`tests`/`fixture(s)`/`__fixtures__`/`vendor`/`third_party` directory. */
  testOrVendorDirectory: number;
  /** A `*.min.js` bundle. */
  minified: number;
  /** Compiled output: a `foo.ts` or `foo.tsx` sits in the same directory. */
  compiledSibling: number;
}

/** A re-export shim folded into the component of the file it re-exports. */
export interface ReexportAlias {
  /** The shim's repository-relative path (not emitted as its own component). */
  path: string;
  /** The re-exported source file whose component absorbs the shim. */
  target: string;
  /** The unit dir owning `target` (never the tooling bucket). */
  unit: string;
}

export interface Discovery {
  /** Canonically-sorted repository-relative source paths. */
  sourceFiles: string[];
  units: SourceUnit[];
  /** file path -> owning unit dir. */
  unitByFile: Map<string, string>;
  /** workspace package name -> owning unit dir. */
  unitByPackageName: Map<string, string>;
  summary: DiscoverySummary;
  /**
   * Every listed repository file (source or not: assets, JSON, skipped `.js`), so an
   * import of an existing file is never reported as unresolved. Absent on hand-built
   * discoveries, where `sourceFiles` stands in.
   */
  trackedFiles?: ReadonlySet<string>;
}

export interface DiscoverOptions {
  /** Scan workspace members that look like fixtures/examples/playgrounds/e2e too. */
  includeAllMembers?: boolean;
  /**
   * Fold pure re-export shims outside every member into their target (default
   * true). `false` reproduces the pre-CLA-263 shape — each shim is its own
   * tooling component — which the membership diagnostic must then flag.
   */
  foldReexportShims?: boolean;
  /**
   * Entries the acquisition step already skipped (e.g. committed symlinks that were
   * never materialized); merged into `summary.skippedEntries`.
   */
  skippedEntries?: SkippedTreeEntries;
  /** Test seam: override {@link SCAN_SIZE_LIMITS} for the tracked-file listing. */
  limits?: Partial<ScanSizeLimits>;
}

// Always scanned. `.js` is added for every repo; a TypeScript repo filters it (`jsSkipReason`).
const ALWAYS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".jsx", ".rs"] as const;

// Members that are test scaffolding, not architecture.
const FIXTURE_MEMBER_PATTERN = /(^|\/)(playground|playgrounds|examples?|example-.*|e2e|fixtures?|__fixtures__|demos?|sandbox)(\/|$)/i;

// Directories that never hold tracked source; skipped by the tarball walk. `.git`
// is absent from a tarball anyway (the whole point of the extract-scan-discard
// strategy); `node_modules` is never tracked, but excluded defensively so a stray
// vendored copy can never balloon the walk or leak into discovery.
const TARBALL_SKIP_DIRS = new Set([".git", "node_modules"]);

/**
 * Conventional test-data directories: `testdata/` is the Go toolchain's reserved
 * fixture directory (ignored by `go build`) and is used the same way by other
 * ecosystems — compiler test cases, golden baselines, deliberately malformed input.
 * Never architecture; e.g. microsoft/TypeScript keeps ~61k generated files there.
 * Excluded files are counted in `DiscoverySummary.excludedTestDataFiles`.
 */
export function isTestDataPath(path: string): boolean {
  return /(^|\/)testdata\//.test(path);
}

/** Test/generated files excluded from every scan (a named, tested list). */
function isExcludedPath(path: string): boolean {
  return isTestDataPath(path) || isExcludedFile(path);
}

/** The per-file exclusions (everything in `isExcludedPath` except test-data directories). */
function isExcludedFile(path: string): boolean {
  return /\.d\.ts$/.test(path)
    || /(^|\/)dist\//.test(path)
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.spec\.[cm]?[jt]sx?$/.test(path)
    || /\.bench\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)__tests__\//.test(path)
    || /(^|\/)__mocks__\//.test(path)
    || /_qa\.rs$/.test(path)
    // Not `*_test.rs`: production modules can be named `hit_test.rs`.
    || (path.endsWith(".rs") && /(^|\/)(tests|benches|examples)\//.test(path));
}

function hasExtension(path: string, includeJs: boolean): boolean {
  if (ALWAYS_EXTENSIONS.some(ext => path.endsWith(ext))) return true;
  return includeJs && path.endsWith(".js");
}

// Whole directory segments only: `contest/` or `vendored-ui/` do not match.
const JS_SKIP_DIRECTORY = /(^|\/)(test|tests|fixture|fixtures|__fixtures__|vendor|third_party)\//;

/**
 * Why a `.js` file in a TypeScript repo is not scanned, or undefined to scan it. In a
 * TS repo hand-written `.js` is source (config, scripts, legacy modules), but three
 * kinds of `.js` are not: test/fixture/vendored copies, minified bundles, and compiled
 * output committed beside its `.ts`/`.tsx` source. A `.d.ts` beside a `.js` does not
 * make it compiled — typings for hand-written JS are common, so that `.js` is kept.
 * The first matching reason wins, in the order listed. Pure-JS repos never call this.
 */
function jsSkipReason(path: string, trackedFiles: ReadonlySet<string>): keyof SkippedJsByReason | undefined {
  if (JS_SKIP_DIRECTORY.test(path)) return "testOrVendorDirectory";
  if (path.endsWith(".min.js")) return "minified";
  const stem = path.slice(0, -".js".length);
  if (trackedFiles.has(`${stem}.ts`) || trackedFiles.has(`${stem}.tsx`)) return "compiledSibling";
  return undefined;
}

/**
 * Reads a repository-relative config/source file only when it is a regular file
 * reached without any symlink (never follows a link outside — or inside — the root).
 */
function readRepositoryFile(sourceRoot: string, relativePath: string): string | undefined {
  const path = safeRegularFile(sourceRoot, relativePath);
  if (!path) return undefined;
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function hasRootTsconfig(sourceRoot: string): boolean {
  return ["tsconfig.json", "tsconfig.base.json"].some(file => safeRegularFile(sourceRoot, file) !== undefined);
}

function readPackageName(sourceRoot: string, dir: string): string | undefined {
  const text = readRepositoryFile(sourceRoot, dir ? `${dir}/package.json` : "package.json");
  if (text === undefined) return undefined;
  try {
    const pkg = JSON.parse(text) as { name?: string };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** `packages:` entries of `pnpm-workspace.yaml` (a list of quoted or bare scalars). */
function pnpmWorkspaceGlobs(sourceRoot: string): string[] {
  const text = readRepositoryFile(sourceRoot, "pnpm-workspace.yaml");
  if (text === undefined) return [];
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
    if (inPackages) {
      const match = /^\s*-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (match) globs.push(match[1]!);
      else if (/^\S/.test(line)) break;
    }
  }
  return globs;
}

/**
 * Root `package.json` `workspaces` (npm, yarn, bun): the array form `["packages/*"]`
 * or yarn classic's object form `{ "packages": [...] }`. `nohoist` is ignored; any
 * other shape or an unparsable manifest declares nothing.
 */
function packageJsonWorkspaceGlobs(sourceRoot: string): string[] {
  const text = readRepositoryFile(sourceRoot, "package.json");
  if (text === undefined) return [];
  let workspaces: unknown;
  try { workspaces = (JSON.parse(text) as { workspaces?: unknown }).workspaces; } catch { return []; }
  const list = Array.isArray(workspaces)
    ? workspaces
    : workspaces && typeof workspaces === "object" ? (workspaces as { packages?: unknown }).packages : undefined;
  return Array.isArray(list) ? list.filter((glob): glob is string => typeof glob === "string") : [];
}

/** Workspace member patterns: `include` globs and `!`-negated `exclude` globs. */
interface WorkspacePatterns {
  include: string[];
  exclude: string[];
}

/** `./a/b/` -> `a/b`; the empty string for the repository root itself. */
function normalizeWorkspacePattern(pattern: string): string {
  return pattern.trim().replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * The JS workspace member patterns. When a repo declares members in more than one
 * place (`pnpm-workspace.yaml` AND root `package.json` `workspaces`), the members are
 * the UNION of every declaration's include globs, minus the union of every `!`
 * negation: both files are package-manager views of the same member set, so a member
 * either one names is real, and an exclusion either one states is applied after all
 * includes (order-independent, unlike pnpm's own last-match-wins). Patterns naming the
 * root itself (`.`) are dropped — the root manifest is never a member.
 */
function workspacePatterns(sourceRoot: string): WorkspacePatterns {
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const raw of [...pnpmWorkspaceGlobs(sourceRoot), ...packageJsonWorkspaceGlobs(sourceRoot)]) {
    const negated = raw.trim().startsWith("!");
    const pattern = normalizeWorkspacePattern(negated ? raw.trim().slice(1) : raw);
    if (!pattern || pattern === ".") continue;
    (negated ? exclude : include).add(pattern);
  }
  return { include: [...include].sort(compareText), exclude: [...exclude].sort(compareText) };
}

/**
 * Workspace glob -> anchored RegExp over a POSIX directory path. `*` matches within a
 * single path segment (`packages/*` = direct children); `**` matches one or more
 * segments. Unsupported, matched literally: `?`, `[...]` classes, `{a,b}` braces and
 * extglobs — none appear in the workspace lists this has to read.
 */
function workspaceGlobToRegExp(glob: string): RegExp {
  const source = glob.split("/").map(segment =>
    segment === "**"
      ? "[^/]+(?:/[^/]+)*"
      : segment.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, "[^/]*"),
  ).join("/");
  return new RegExp(`^${source}$`);
}

function isWorkspaceMemberDir(dir: string, patterns: WorkspacePatterns): boolean {
  const matches = (glob: string): boolean => workspaceGlobToRegExp(glob).test(dir);
  return patterns.include.some(matches) && !patterns.exclude.some(matches);
}

/** Strips a TOML `#` comment that is not inside a basic or literal string. */
function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

/**
 * `members` and `exclude` of the root `Cargo.toml` `[workspace]` table. A small,
 * tolerant reader for just that table (no TOML dependency): comments are stripped,
 * arrays may span lines, strings may be `"basic"` or `'literal'`. Not read: dotted
 * keys (`workspace.members = …` at top level), inline-table `workspace = { … }`,
 * and escapes inside strings beyond `\"`.
 */
export function cargoWorkspaceMembers(manifestText: string): { members: string[]; exclude: string[] } {
  const lines = manifestText.split(/\r?\n/).map(stripTomlComment);
  const body: string[] = [];
  let inWorkspace = false;
  for (const line of lines) {
    // Any table or array-of-tables header ends the `[workspace]` body.
    const header = /^\s*\[(\[?)\s*([^\]]+?)\s*\]/.exec(line);
    if (header) inWorkspace = !header[1] && header[2] === "workspace";
    else if (inWorkspace) body.push(line);
  }
  const text = body.join("\n");
  const arrayOf = (key: string): string[] => {
    const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`).exec(text);
    if (!match) return [];
    return [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map(item => (item[1] ?? item[2]!).replace(/\\"/g, '"'));
  };
  return { members: arrayOf("members"), exclude: arrayOf("exclude") };
}

/**
 * Rust crate directories. With a root `Cargo.toml` `[workspace] members` list, a crate
 * is a directory matched by a member glob (or path), not under an `exclude` path, that
 * has a tracked `Cargo.toml`. Without declared members, the conventional
 * `crates/<name>/Cargo.toml` layout is used (unchanged behaviour), still minus any
 * declared `exclude`. The root itself (`.`) is never a crate unit.
 */
function rustCrateDirectories(sourceRoot: string, allFiles: readonly string[]): string[] {
  const manifestDirs = allFiles
    .filter(path => path.endsWith("/Cargo.toml"))
    .map(manifest => manifest.slice(0, -"/Cargo.toml".length));
  const manifest = readRepositoryFile(sourceRoot, "Cargo.toml");
  const declared = manifest === undefined ? { members: [], exclude: [] } : cargoWorkspaceMembers(manifest);
  const members = declared.members.map(normalizeWorkspacePattern).filter(pattern => pattern && pattern !== ".");
  const excluded = declared.exclude.map(normalizeWorkspacePattern).filter(Boolean);
  const isExcluded = (dir: string): boolean =>
    excluded.some(pattern => dir === pattern || dir.startsWith(`${pattern}/`) || workspaceGlobToRegExp(pattern).test(dir));
  const isMember = members.length === 0
    ? (dir: string): boolean => /^crates\/[^/]+$/.test(dir)
    : (dir: string): boolean => members.some(pattern => workspaceGlobToRegExp(pattern).test(dir));
  return manifestDirs.filter(dir => isMember(dir) && !isExcluded(dir)).sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The most specific (longest) directory in `dirs` containing `file`, or undefined.
 * With nested roots (`apps/web` and `apps/web/api` both packages) a file under
 * `apps/web/api/` belongs to the nested member only — container membership is
 * exclusive and the deepest package root wins, independent of `dirs` order.
 */
export function mostSpecificRoot(file: string, dirs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const dir of dirs) {
    if (file !== dir && !file.startsWith(`${dir}/`)) continue;
    if (best === undefined || dir.length > best.length) best = dir;
  }
  return best;
}

const REEXPORT_SHIM_EXTENSION = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const REEXPORT_SHIM_MAX_CHARS = 8 * 1024;

/**
 * Relative specifiers of a file whose top-level statements are ALL re-exports
 * (`export { a } from './x'`, `export * from './x'`); undefined for anything else
 * (a declaration, an import, a bare-specifier re-export, an empty file).
 */
export function pureRelativeReexportSpecifiers(path: string, text: string): string[] | undefined {
  if (!REEXPORT_SHIM_EXTENSION.test(path)) return undefined;
  // Cheap prefilter before a parse: a shim is short and must re-export `from` somewhere.
  if (text.length > REEXPORT_SHIM_MAX_CHARS || !/\bexport\b/.test(text) || !/\bfrom\b/.test(text)) return undefined;
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  if (sourceFile.statements.length === 0) return undefined;
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) return undefined;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")) return undefined;
    specifiers.push(specifier.text);
  }
  return specifiers;
}

/**
 * Folds pure re-export shims out of the tooling bucket: a NON-MEMBER file whose
 * statements only re-export relative files that ALL resolve to one discovered
 * file owned by a workspace member / Rust crate (never another non-member file)
 * is removed from `unitByFile` and `nonMemberFiles` and recorded as an alias of
 * that target. Returns aliases sorted by path. Unreadable / unresolved /
 * multi-target shims stay as-is. Membership is decided by the `nonMemberFiles`
 * set, never by the bucket's unit key.
 */
function foldReexportShims(sourceRoot: string, unitByFile: Map<string, string>, nonMemberFiles: Set<string>): ReexportAlias[] {
  const fileSet = new Set(unitByFile.keys());
  const aliases: ReexportAlias[] = [];
  for (const file of [...nonMemberFiles].sort()) {
    const text = readRepositoryFile(sourceRoot, file);
    if (text === undefined) continue;
    const specifiers = pureRelativeReexportSpecifiers(file, text);
    if (!specifiers) continue;
    const targets = new Set(specifiers.map(specifier => resolveRelativeImport(file, specifier, fileSet)));
    if (targets.size !== 1) continue;
    const target = [...targets][0];
    const targetUnit = target ? unitByFile.get(target) : undefined;
    if (!target || target === file || !targetUnit || nonMemberFiles.has(target)) continue;
    aliases.push({ path: file, target, unit: targetUnit });
  }
  for (const alias of aliases) {
    unitByFile.delete(alias.path);
    nonMemberFiles.delete(alias.path);
  }
  return aliases;
}

/**
 * All tracked regular files at the current index (gitignore-aware), repo-relative
 * POSIX. Symlinks (mode 120000) and submodules (160000) are skipped and counted; the
 * listing is bounded by {@link SCAN_SIZE_LIMITS} (typed {@link ScanSizeLimitError}).
 */
function listTrackedFiles(sourceRoot: string, limits: ScanSizeLimits): { files: string[]; skipped: SkippedTreeEntries } {
  let out: string;
  try {
    out = scanExecFileSync("git", "git", ["ls-files", "-s", "-z"], { cwd: sourceRoot, encoding: "utf8", maxBuffer: limits.maxListingBytes });
  } catch (error) {
    if (isBufferOverflow(error)) throw new ScanSizeLimitError("listing", limits.maxListingBytes, limits.maxListingBytes);
    throw error;
  }
  const files: string[] = [];
  const skipped = emptySkippedEntries();
  const seen = new Set<string>();
  for (const record of out.split("\0")) {
    // `<mode> <object> <stage>\t<path>`; unmerged paths appear once per stage.
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const mode = record.slice(0, record.indexOf(" "));
    const path = record.slice(tab + 1);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (mode === "160000") skipped.submodules += 1;
    else if (mode === "120000") countSymlink(skipped, classifyFsSymlink(sourceRoot, `${sourceRoot}/${path}`));
    else files.push(path);
  }
  if (files.length > limits.maxFiles) throw new ScanSizeLimitError("files", limits.maxFiles, files.length);
  return { files, skipped };
}

/**
 * Recursively lists every regular file under an extracted tree, repo-relative POSIX. A
 * GitHub codeload tarball already contains exactly the committed tree at the SHA
 * (untracked/gitignored content was never archived), so a plain walk reproduces
 * `git ls-files` for that commit — no `.gitignore` parsing required. Divergence to
 * note: `git archive` honors `.gitattributes export-ignore`, so a rare export-ignored
 * (but tracked) path is present under `git ls-files` yet absent from the tarball.
 * Symlinks are never listed as source files and a symlinked directory is never
 * descended; the links still present (in-repo, kept for config/import resolution) are
 * counted and classified in `skipped`.
 */
function walkExtractedTree(root: string, limits: ScanSizeLimits): { files: string[]; skipped: SkippedTreeEntries } {
  const walked = walkRegularFiles(root, TARBALL_SKIP_DIRS);
  if (walked.files.length > limits.maxFiles) throw new ScanSizeLimitError("files", limits.maxFiles, walked.files.length);
  return walked;
}

/**
 * Pure discovery core over an already-listed set of repository-relative file paths
 * plus an `fs`-readable root (for `package.json`/`tsconfig`/`pnpm-workspace.yaml`,
 * and the text of non-member source files checked for re-export shims).
 * Both the git (`git ls-files`) and tarball (`fs` walk) providers feed the SAME core,
 * so a repo scanned either way yields identical containers/units/sort — the property
 * the byte-identical determinism contract needs.
 */
export function discoverFromFiles(sourceRoot: string, allFiles: readonly string[], options: DiscoverOptions = {}): Discovery {
  const candidates = allFiles.filter(path => hasExtension(path, true));
  // A pure-JS repo (no root tsconfig AND no TS source anywhere — a monorepo can be TS
  // without a root tsconfig) scans every `.js`. A TS repo scans `.js` too, except the
  // test/vendor, minified and compiled-sibling files `jsSkipReason` names (counted).
  const hasTypeScriptSource = candidates.some(path => /\.(ts|tsx|mts|cts)$/.test(path) && !isExcludedPath(path));
  const includedJs = !hasRootTsconfig(sourceRoot) && !hasTypeScriptSource;
  const trackedFiles = new Set(allFiles);
  const skippedJsByReason: SkippedJsByReason = { testOrVendorDirectory: 0, minified: 0, compiledSibling: 0 };
  const sourceCandidates = candidates.filter(path => {
    if (isExcludedPath(path)) return false;
    if (includedJs || !path.endsWith(".js")) return true;
    const reason = jsSkipReason(path, trackedFiles);
    if (reason) skippedJsByReason[reason] += 1;
    return reason === undefined;
  });
  const skippedJsFiles = skippedJsByReason.testOrVendorDirectory + skippedJsByReason.minified + skippedJsByReason.compiledSibling;
  // Only files the testdata rule newly excludes (a testdata `.d.ts` / `*.test.ts` was already out).
  const excludedTestDataFiles = candidates.filter(path => isTestDataPath(path) && !isExcludedFile(path)).length;

  const patterns = workspacePatterns(sourceRoot);
  const memberDirs = new Set<string>();
  for (const path of allFiles) {
    if (!path.endsWith("/package.json") && path !== "package.json") continue;
    if (path === "package.json") continue; // the root manifest is not a workspace member
    const dir = path.slice(0, -"/package.json".length);
    if (isWorkspaceMemberDir(dir, patterns)) memberDirs.add(dir);
  }
  const rustCrateDirs = rustCrateDirectories(sourceRoot, allFiles);
  const rustCrateOf = (file: string): string | undefined => mostSpecificRoot(file, rustCrateDirs);

  const allMembers = [...memberDirs].sort();
  const skippedMembers = options.includeAllMembers ? [] : allMembers.filter(dir => FIXTURE_MEMBER_PATTERN.test(dir));
  const skippedMemberSet = new Set(skippedMembers);
  const memberOf = (file: string): string | undefined => mostSpecificRoot(file, allMembers);

  const unitByFile = new Map<string, string>();
  const unitByPackageName = new Map<string, string>();
  const units: SourceUnit[] = [];
  const singlePackage = allMembers.length === 0;
  let reexportAliases: ReexportAlias[] = [];

  if (singlePackage) {
    // Whole repo is one package -> one container derived from the root manifest.
    const rootPackage = readPackageName(sourceRoot, "");
    const rootName = rootPackage ?? basename(sourceRoot);
    const rootKey = slug(rootName);
    const hasRootManifest = safeRegularFile(sourceRoot, "package.json") !== undefined;
    for (const file of sourceCandidates) unitByFile.set(file, rustCrateOf(file) ?? rootKey);
    units.push({
      kind: "root",
      dir: rootKey,
      name: rootName,
      ...(rootPackage ? { packageName: rootPackage } : {}),
      ...(hasRootManifest ? { packageManifest: "package.json" } : {}),
      evidencePath: hasRootManifest ? "package.json" : rootKey,
    });
    if (rootPackage) unitByPackageName.set(rootPackage, rootKey);
  } else {
    const nonMemberFiles = new Set<string>();
    for (const file of sourceCandidates) {
      // Deepest root wins across Rust crates and JS members together (a JS member
      // nested in a crate owns its files); the same directory as both goes to Rust.
      const rustCrate = rustCrateOf(file);
      const member = memberOf(file);
      if (rustCrate && (!member || rustCrate.length >= member.length)) {
        unitByFile.set(file, rustCrate);
        continue;
      }
      if (member && skippedMemberSet.has(member)) continue; // fixture/example member — dropped
      if (member) unitByFile.set(file, member);
      else { unitByFile.set(file, TOOLING_UNIT_KEY); nonMemberFiles.add(file); }
    }
    if (options.foldReexportShims !== false) reexportAliases = foldReexportShims(sourceRoot, unitByFile, nonMemberFiles);
    // Pruned when every non-member file was a folded shim.
    const hasTooling = nonMemberFiles.size > 0;
    // A member whose dir is also a crate dir lost every file to the crate (ties go to
    // Rust): it is merged into the crate's unit below, never a second unit.
    const rustCrateDirSet = new Set(rustCrateDirs);
    const membersWithSource = allMembers
      .filter(dir => !skippedMemberSet.has(dir) && !rustCrateDirSet.has(dir))
      .filter(dir => sourceCandidates.some(file => unitByFile.get(file) === dir));
    for (const dir of membersWithSource) {
      const name = readPackageName(sourceRoot, dir);
      units.push({ kind: "member", dir, name: name ?? dir, evidencePath: dir, ...(name ? { packageName: name } : {}), packageManifest: `${dir}/package.json` });
      if (name) unitByPackageName.set(name, dir);
    }
    if (hasTooling) {
      units.push({ kind: "tooling", dir: TOOLING_UNIT_KEY, name: "Build & fixture tooling", evidencePath: "scripts" });
    }
  }

  for (const dir of rustCrateDirs) {
    // Same dir as a (non-skipped) JS member: one Rust unit that also carries the
    // member's npm manifest facts and answers to its npm name.
    const isJsMember = memberDirs.has(dir) && !skippedMemberSet.has(dir);
    const packageName = isJsMember ? readPackageName(sourceRoot, dir) : undefined;
    units.push({
      kind: "rust",
      dir,
      name: dir.replace(/^crates\//, ""),
      evidencePath: dir,
      ...(packageName ? { packageName } : {}),
      ...(isJsMember ? { packageManifest: `${dir}/package.json` } : {}),
    });
    if (packageName) unitByPackageName.set(packageName, dir);
  }

  const sourceFiles = [...unitByFile.keys()].sort();
  return {
    sourceFiles,
    units,
    unitByFile,
    unitByPackageName,
    trackedFiles,
    summary: {
      singlePackage,
      includedJs,
      skippedJsFiles,
      ...(skippedJsFiles > 0 ? { skippedJsByReason } : {}),
      skippedMembers,
      ...(reexportAliases.length > 0 ? { reexportAliases } : {}),
      ...(hasSkippedEntries(options.skippedEntries) ? { skippedEntries: { ...options.skippedEntries } } : {}),
      ...(excludedTestDataFiles > 0 ? { excludedTestDataFiles } : {}),
    },
  };
}

/**
 * Deterministically discovers source files, containers, tooling, and Rust crates
 * from a local git working tree (gitignore-aware via `git ls-files`).
 */
export function discoverRepository(sourceRoot: string, options: DiscoverOptions = {}): Discovery {
  const listed = listTrackedFiles(sourceRoot, { ...SCAN_SIZE_LIMITS, ...options.limits });
  return discoverFromFiles(sourceRoot, listed.files, { ...options, skippedEntries: mergeSkippedEntries(options.skippedEntries, listed.skipped) });
}

/**
 * Discovery for an extracted GitHub tarball: no `.git`, so files come from an `fs`
 * walk of the committed tree instead of `git ls-files`. Runs the identical core, so
 * the same repository content yields byte-identical discovery whether reached via a
 * local clone or a `gh:` tarball.
 */
export function discoverExtractedTree(root: string, options: DiscoverOptions = {}): Discovery {
  const walked = walkExtractedTree(root, { ...SCAN_SIZE_LIMITS, ...options.limits });
  return discoverFromFiles(root, walked.files, { ...options, skippedEntries: mergeSkippedEntries(options.skippedEntries, walked.skipped) });
}
