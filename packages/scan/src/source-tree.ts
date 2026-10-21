import { lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Source-tree acquisition bounds and non-regular-entry accounting shared by the
 * committed-Git path (`acquireCommittedTree`), the working-tree listing
 * (`discoverRepository`) and the tarball walk (`discoverExtractedTree`).
 */

/**
 * Generous, documented upper bounds on what one scan will acquire. They exist so an
 * enormous repository fails fast with a typed error BEFORE any blob is read, instead
 * of exhausting memory or a child-process buffer. They comfortably admit
 * microsoft/TypeScript (~66.8k tracked files, ~412 MB checkout).
 */
export interface ScanSizeLimits {
  maxFiles: number;
  maxBytes: number;
  maxListingBytes: number;
  batchBytes: number;
}

export const SCAN_SIZE_LIMITS: Readonly<ScanSizeLimits> = {
  /** Regular files materialized from one committed tree / listed by discovery. */
  maxFiles: 250_000,
  /** Summed size of those files (2 GiB). */
  maxBytes: 2 * 1024 * 1024 * 1024,
  /** Raw bytes of one tree listing (`git ls-tree -rlz` / `git ls-files -sz`). */
  maxListingBytes: 256 * 1024 * 1024,
  /**
   * Blob bytes requested from one `git cat-file --batch` call. Blobs are streamed in
   * chunks under this bound; a single larger blob gets its own call sized to it.
   */
  batchBytes: 32 * 1024 * 1024,
};

export type ScanSizeLimitKind = "files" | "bytes" | "listing";

/** A repository exceeded one of {@link SCAN_SIZE_LIMITS}; raised before blobs are read. */
export class ScanSizeLimitError extends Error {
  readonly kind: ScanSizeLimitKind;
  readonly limit: number;
  /** The observed amount; for `listing` it is a lower bound (the listing overflowed). */
  readonly actual: number;
  constructor(kind: ScanSizeLimitKind, limit: number, actual: number) {
    const what = kind === "files" ? "tracked files" : kind === "bytes" ? "bytes of tracked files" : "bytes of tree listing";
    super(`Repository is too large to scan: ${kind === "listing" ? "more than " : ""}${actual} ${what} exceeds the limit of ${limit}.`);
    this.name = "ScanSizeLimitError";
    this.kind = kind;
    this.limit = limit;
    this.actual = actual;
  }
}

/** Case-fold + Unicode (NFC) key under which two paths name the same entry on APFS / NTFS. */
function foldPathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/**
 * The paths in `candidates` that collide — themselves or through any directory prefix —
 * with a differently spelled path among `allPaths` (and their prefixes) once case and
 * Unicode normalization are folded. On a case-insensitive filesystem such an entry can
 * resolve through another one (e.g. link `d/Y` and directory `d/y/`), so a colliding
 * symlink is never materialized. Deterministic: independent of the host filesystem.
 */
export function foldCollidingPaths(allPaths: Iterable<string>, candidates: Iterable<string>): Set<string> {
  const spellings = new Map<string, Set<string>>();
  const note = (path: string): void => {
    const key = foldPathKey(path);
    const set = spellings.get(key) ?? new Set<string>();
    set.add(path);
    spellings.set(key, set);
  };
  const prefixes = (path: string): string[] => {
    const parts = path.split("/");
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  };
  for (const path of allPaths) for (const prefix of prefixes(path)) note(prefix);
  const colliding = new Set<string>();
  for (const path of candidates) {
    if (prefixes(path).some(prefix => (spellings.get(foldPathKey(prefix))?.size ?? 0) > 1)) colliding.add(path);
  }
  return colliding;
}

/**
 * Creates `relativePath` as a symlink to `target` under `root` only when it is provably
 * safe: every parent is created one component at a time and must be a real directory
 * (never a symlink, never a file), the parent's real path must lie inside the real root,
 * and nothing may already exist at the link path (e.g. a case alias of a written file).
 * Returns false — the link is not written — otherwise.
 */
export function placeSymlinkSafely(root: string, relativePath: string, target: string): boolean {
  const parts = relativePath.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`;
    let stats;
    try { stats = lstatSync(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      mkdirSync(current, { mode: 0o755 });
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }
  try {
    if (!isWithin(realpathSync(root), realpathSync(current))) return false;
  } catch {
    return false;
  }
  const linkPath = `${root}/${relativePath}`;
  try {
    lstatSync(linkPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  symlinkSync(target, linkPath);
  return true;
}

/** Symlink targets longer than this (PATH_MAX) are classified `unresolved` without reading the blob. */
export const MAX_SYMLINK_TARGET_BYTES = 4096;

/**
 * Plans `git cat-file --batch` calls: consecutive `[start, end)` ranges whose summed
 * sizes stay within `batchBytes`; a single blob larger than the bound is a range of
 * its own. Pure, so the chunking boundaries are directly testable.
 */
export function planBlobChunks(sizes: readonly number[], batchBytes: number): [number, number][] {
  const chunks: [number, number][] = [];
  let start = 0;
  while (start < sizes.length) {
    let end = start;
    let bytes = 0;
    while (end < sizes.length && (end === start || bytes + sizes[end]! <= batchBytes)) {
      bytes += sizes[end]!;
      end += 1;
    }
    chunks.push([start, end]);
    start = end;
  }
  return chunks;
}

/** True when `error` is a child-process buffer overflow (`maxBuffer` exceeded). */
export function isBufferOverflow(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/**
 * Tracked symlinks and submodules. A symlink is never listed as a source file of its
 * own (its in-repo target is already scanned at its canonical path; listing both would
 * duplicate components). One whose target resolves inside the repository root is kept
 * on disk so config reads and import resolution can follow it; an escaping, dangling
 * or looping one is never written (committed path) or is removed (tarball path).
 */
export interface SkippedTreeEntries {
  /** Symlinks whose target resolves inside the repository (kept; followed for config/imports only). */
  symlinksInternal: number;
  /** Symlinks with an absolute target or one that climbs out of the repository root. */
  symlinksEscaping: number;
  /** Symlinks whose target is missing, or that loop / exceed the resolution depth. */
  symlinksUnresolved: number;
  /** Git submodules (gitlinks); their content is another repository. */
  submodules: number;
  /**
   * Committed regular files that could not be written because their path conflicts
   * with another entry on a case-insensitive / normalizing filesystem (e.g. a file `D`
   * and a directory `d/`). Present only when non-zero; filesystem-dependent.
   */
  pathCollisions?: number;
}

export function emptySkippedEntries(): SkippedTreeEntries {
  return { symlinksInternal: 0, symlinksEscaping: 0, symlinksUnresolved: 0, submodules: 0 };
}

export function hasSkippedEntries(skipped: SkippedTreeEntries | undefined): skipped is SkippedTreeEntries {
  return Boolean(skipped && (skipped.symlinksInternal || skipped.symlinksEscaping || skipped.symlinksUnresolved || skipped.submodules || skipped.pathCollisions));
}

export function mergeSkippedEntries(...items: (SkippedTreeEntries | undefined)[]): SkippedTreeEntries {
  const total = emptySkippedEntries();
  for (const item of items) {
    if (!item) continue;
    total.symlinksInternal += item.symlinksInternal;
    total.symlinksEscaping += item.symlinksEscaping;
    total.symlinksUnresolved += item.symlinksUnresolved;
    total.submodules += item.submodules;
    if (item.pathCollisions) total.pathCollisions = (total.pathCollisions ?? 0) + item.pathCollisions;
  }
  return total;
}

export type SymlinkClass = "internal" | "escaping" | "unresolved";

export function countSymlink(skipped: SkippedTreeEntries, kind: SymlinkClass): void {
  if (kind === "internal") skipped.symlinksInternal += 1;
  else if (kind === "escaping") skipped.symlinksEscaping += 1;
  else skipped.symlinksUnresolved += 1;
}

const MAX_SYMLINK_HOPS = 40;

/**
 * Classifies committed symlinks purely from the Git tree (never the filesystem):
 * `links` maps each symlink path to its raw target, `files` is every tracked
 * non-link path. Resolution is lexical (POSIX-normalized per hop) and substitutes
 * symlinked path prefixes, bounded to {@link MAX_SYMLINK_HOPS} hops so a loop is
 * `unresolved`, never a hang.
 */
export function classifyTreeSymlinks(links: ReadonlyMap<string, string>, files: Iterable<string>): SkippedTreeEntries {
  const skipped = emptySkippedEntries();
  for (const kind of classifyTreeSymlinkTargets(links, files).values()) countSymlink(skipped, kind);
  return skipped;
}

/** Per-link form of {@link classifyTreeSymlinks}, keyed by link path in sorted order. */
export function classifyTreeSymlinkTargets(links: ReadonlyMap<string, string>, files: Iterable<string>): Map<string, SymlinkClass> {
  const known = new Set<string>();
  for (const file of files) {
    known.add(file);
    for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1)) known.add(file.slice(0, slash));
  }
  for (const link of links.keys()) {
    for (let slash = link.lastIndexOf("/"); slash > 0; slash = link.lastIndexOf("/", slash - 1)) known.add(link.slice(0, slash));
  }
  type Resolved = { path: string } | { fail: "escaping" | "unresolved" };
  let hops = 0;
  const resolve = (path: string): Resolved => {
    let resolved = "";
    for (const part of path ? path.split("/") : []) {
      const candidate = resolved ? `${resolved}/${part}` : part;
      const target = links.get(candidate);
      if (target === undefined) { resolved = candidate; continue; }
      if ((hops += 1) > MAX_SYMLINK_HOPS) return { fail: "unresolved" };
      if (target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)) return { fail: "escaping" };
      const joined = posix.normalize(posix.join(posix.dirname(candidate), target));
      if (joined === ".." || joined.startsWith("../")) return { fail: "escaping" };
      const next = resolve(joined === "." ? "" : joined.replace(/\/+$/, ""));
      if ("fail" in next) return next;
      resolved = next.path;
    }
    return { path: resolved };
  };
  const classes = new Map<string, SymlinkClass>();
  for (const link of [...links.keys()].sort()) {
    hops = 0;
    const outcome = resolve(link);
    classes.set(link, "fail" in outcome ? outcome.fail : outcome.path === "" || known.has(outcome.path) ? "internal" : "unresolved");
  }
  return classes;
}

/**
 * Classifies one on-disk symlink under `root` WITHOUT reading through it. The raw
 * target is checked first (absolute, or lexically climbing out of the root →
 * `escaping`, matching {@link classifyTreeSymlinks}); otherwise the OS resolves it
 * (`realpath`, which fails with ELOOP on a loop rather than hanging) and only the
 * resolved location is compared against the root (a chain through another link can
 * still escape).
 */
export function classifyFsSymlink(root: string, absolutePath: string): SymlinkClass {
  let target: string;
  try { target = readlinkSync(absolutePath); } catch { return "unresolved"; }
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) return "escaping";
  if (!isWithin(resolve(root), resolve(dirname(absolutePath), target))) return "escaping";
  let resolvedRoot: string;
  let resolvedTarget: string;
  try {
    resolvedRoot = realpathSync(root);
    resolvedTarget = realpathSync(absolutePath);
  } catch {
    return "unresolved";
  }
  return isWithin(resolvedRoot, resolvedTarget) ? "internal" : "escaping";
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * The regular file at `root/relativePath` if — and only if — its real path (after the
 * OS resolves any in-repo symlinks; a loop fails with ELOOP, never hangs) is a regular
 * file inside the real root. Config reads (package.json, tsconfig, pnpm-workspace.yaml,
 * shim text) go through this, so an in-repo linked config (tsconfig.json ->
 * tsconfig.base.json) is honoured while a link out of the repository is never read.
 */
export function safeRegularFile(root: string, relativePath: string): string | undefined {
  if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some(part => part === ".." || part === "")) return undefined;
  try {
    const real = realpathSync(`${root}/${relativePath}`);
    if (!isWithin(realpathSync(root), real) || !statSync(real).isFile()) return undefined;
    return `${root}/${relativePath}`;
  } catch {
    return undefined;
  }
}

/**
 * Lists every regular file under `root` (repo-relative POSIX), never descending into a
 * symlinked directory. Symlinks are counted and classified, never listed; `skipDirs`
 * names are pruned. Callers sort; counts do not depend on `readdir` order.
 */
export function walkRegularFiles(root: string, skipDirs: ReadonlySet<string>): { files: string[]; symlinks: string[]; skipped: SkippedTreeEntries } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const visit = (relativeDir: string): void => {
    const absoluteDir = relativeDir ? `${root}/${relativeDir}` : root;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) symlinks.push(relativePath);
      else if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) visit(relativePath); }
      else if (entry.isFile()) files.push(relativePath);
      // sockets, FIFOs and devices are ignored (not source)
    }
  };
  visit("");
  // Classify every link while all of them still exist (a chain resolves through others).
  const skipped = emptySkippedEntries();
  for (const link of symlinks) countSymlink(skipped, classifyFsSymlink(root, `${root}/${link}`));
  return { files, symlinks, skipped };
}

/**
 * Removes every symlink under `root` whose target escapes the (real) root, dangles or
 * loops — after classifying all of them while every link still exists, so a chain
 * through an escaping link is itself escaping. Links resolving inside the root stay
 * (config reads and import resolution follow them; the walk still never lists or
 * descends them). Returns counts of the REMOVED links only; the discovery walk counts
 * the kept, internal ones. Used by the tarball path and, after materialization, by the
 * committed-Git path, so both leave the same tree.
 */
export function detachSymlinks(root: string, skipDirs: ReadonlySet<string> = new Set()): SkippedTreeEntries {
  const walked = walkRegularFiles(root, skipDirs);
  const removed = emptySkippedEntries();
  const doomed: string[] = [];
  for (const link of walked.symlinks) {
    const kind = classifyFsSymlink(root, `${root}/${link}`);
    if (kind === "internal") continue;
    countSymlink(removed, kind);
    doomed.push(link);
  }
  for (const link of doomed) unlinkSync(`${root}/${link}`);
  return removed;
}

/** Human-readable, deterministic limitation lines; empty when nothing was skipped. */
export function skippedEntryLimitations(skipped: SkippedTreeEntries | undefined): string[] {
  if (!hasSkippedEntries(skipped)) return [];
  const lines: string[] = [];
  const symlinks = skipped.symlinksInternal + skipped.symlinksEscaping + skipped.symlinksUnresolved;
  if (symlinks) {
    const parts = [
      skipped.symlinksInternal ? `${skipped.symlinksInternal} resolve inside the repository (followed only for config/imports; not listed as separate source files)` : "",
      skipped.symlinksEscaping ? `${skipped.symlinksEscaping} point outside the repository (absolute or ../ target; never read)` : "",
      skipped.symlinksUnresolved ? `${skipped.symlinksUnresolved} are dangling, loop or collide with another path (not followed)` : "",
    ].filter(Boolean);
    lines.push(`${symlinks} committed symlink(s) were not scanned as source: ${parts.join("; ")}.`);
  }
  if (skipped.pathCollisions) lines.push(`${skipped.pathCollisions} committed file(s) were not written: their path collides with another entry on a case-insensitive filesystem.`);
  if (skipped.submodules) lines.push(`${skipped.submodules} Git submodule(s) were not scanned (their content is another repository).`);
  return lines;
}
