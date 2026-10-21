import { scanExecFileSync, scanWorkDir } from "./scan-env.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  classifyTreeSymlinkTargets,
  countSymlink,
  detachSymlinks,
  emptySkippedEntries,
  foldCollidingPaths,
  placeSymlinkSafely,
  isBufferOverflow,
  MAX_SYMLINK_TARGET_BYTES,
  planBlobChunks,
  SCAN_SIZE_LIMITS,
  ScanSizeLimitError,
  type ScanSizeLimits,
  type SkippedTreeEntries,
} from "./source-tree.js";

/**
 * An immutable pin of the scanned source. `commitSha` is the REAL commit (unlike
 * the golden fixture's synthetic revision); `generatedAt` is the commit's own
 * committer date, NOT wall-clock — so a re-scan of the same commit is byte-identical.
 */
export interface RepositoryPin {
  commitSha: string;
  treeHash: string;
  /** ISO-8601 committer date of `commitSha`. Input-derived, never `Date.now()`. */
  generatedAt: string;
}

function git(sourceRoot: string, args: readonly string[]): string {
  return scanExecFileSync("git", "git", ['--no-replace-objects', ...args], { cwd: sourceRoot, encoding: "utf8" }).trim();
}

/** Resolves a local revision to its immutable commit identity. */
export function pinRepository(sourceRoot: string, revision = "HEAD"): RepositoryPin {
  const commitSha = git(sourceRoot, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  const treeHash = git(sourceRoot, ["rev-parse", `${commitSha}^{tree}`]);
  const generatedAt = new Date(git(sourceRoot, ["show", "-s", "--format=%cI", commitSha])).toISOString();
  return { commitSha, treeHash, generatedAt };
}

/** A temporary filesystem view containing only one committed Git tree. */
export interface AcquiredCommittedTree {
  root: string;
  /** The temporary directory holding `root`; removed by `cleanup`. */
  checkoutRoot: string;
  /** Optional installed dependencies; never a source-file fallback. */
  installationRoot?: string;
  pin: RepositoryPin;
  sourceName: string;
  /** Symlinks not kept (escaping / dangling / loop) and submodules; kept in-repo links are counted by discovery. */
  skipped: SkippedTreeEntries;
  cleanup(): void;
}

/** Test seam: override {@link SCAN_SIZE_LIMITS} (e.g. a tiny `batchBytes` to exercise chunking). */
export interface AcquireCommittedTreeOptions {
  limits?: Partial<ScanSizeLimits>;
  /** Directory the temporary tree is created in (default the scanner work dir, see scanWorkDir). */
  tempRoot?: string;
}

interface TreeEntry { mode: string; kind: string; hash: string; size: number; path: string }

/** Lists the committed tree with sizes, bounded by `maxListingBytes`. */
function listCommittedTree(sourceRoot: string, commitSha: string, maxListingBytes: number): TreeEntry[] {
  let listing: string;
  try {
    listing = scanExecFileSync("git", "git", ["--no-replace-objects", "ls-tree", "-rlz", "--full-tree", commitSha], { cwd: sourceRoot, encoding: "utf8", maxBuffer: maxListingBytes });
  } catch (error) {
    if (isBufferOverflow(error)) throw new ScanSizeLimitError("listing", maxListingBytes, maxListingBytes);
    throw error;
  }
  return listing.split("\0").filter(Boolean).map(entry => {
    const tab = entry.indexOf("\t");
    // `<mode> SP <type> SP <object> SP+ <size>\t<path>`; size is `-` for gitlinks.
    const [mode = "", kind = "", hash = "", sizeText = ""] = tab < 0 ? [] : entry.slice(0, tab).split(/ +/);
    const path = entry.slice(tab + 1);
    if (tab < 0 || !hash || path.split("/").some(part => !part || part === ".." || part === ".") || path.includes("\\")) throw new Error("Unsupported committed source path.");
    const size = kind === "blob" ? Number(sizeText) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Unsupported committed source entry size: ${path}`);
    return { mode, kind, hash, size, path };
  });
}

/**
 * Reads blobs with `git cat-file --batch` in chunks whose summed size stays under
 * `batchBytes` (a single larger blob gets a call of its own sized to it), handing each
 * blob to `onBlob` as its chunk returns — the repository is never buffered whole.
 */
export function readBlobsInChunks(sourceRoot: string, entries: readonly { hash: string; size: number }[], batchBytes: number, onBlob: (index: number, bytes: Buffer) => void): void {
  for (const [start, end] of planBlobChunks(entries.map(entry => entry.size), batchBytes)) {
    const chunk = entries.slice(start, end);
    const bytes = chunk.reduce((sum, entry) => sum + entry.size, 0);
    // Each record is `<hash> blob <size>\n<bytes>\n`; 128 bytes covers any header.
    const maxBuffer = bytes + chunk.length * 128 + 1024;
    const output = scanExecFileSync("git", "git", ["--no-replace-objects", "cat-file", "--batch"], { cwd: sourceRoot, input: chunk.map(entry => entry.hash + "\n").join(""), maxBuffer });
    let offset = 0;
    chunk.forEach((entry, position) => {
      const newline = output.indexOf(10, offset);
      const [hash, kind, sizeText] = output.subarray(offset, newline).toString("utf8").split(" ");
      const size = Number(sizeText);
      if (newline < offset || hash !== entry.hash || kind !== "blob" || !Number.isSafeInteger(size) || size !== entry.size || newline + 1 + size >= output.length) throw new Error("Incomplete committed source blob.");
      onBlob(start + position, output.subarray(newline + 1, newline + 1 + size));
      offset = newline + 1 + size + 1;
    });
  }
}

/**
 * Materializes a committed tree without reading, changing, or checking out the
 * caller's working tree. Dirty and untracked files are absent by construction.
 * A symlink whose target lexically resolves inside the tree is materialized as the same
 * relative link (config reads and import resolution may follow it; discovery never
 * lists it as a source file); escaping, absolute, dangling and looping links are never
 * written, and the same filesystem pass the tarball path uses then removes any written
 * link that really escapes. Submodules are skipped. `skipped` counts what was NOT kept
 * (internal links are counted by the discovery walk). A tree over
 * {@link SCAN_SIZE_LIMITS} fails with {@link ScanSizeLimitError} before any blob is read.
 */
export function acquireCommittedTree(sourceRoot: string, revision = "HEAD", options: AcquireCommittedTreeOptions = {}): AcquiredCommittedTree {
  const limits = { ...SCAN_SIZE_LIMITS, ...options.limits };
  const pin = pinRepository(sourceRoot, revision);
  const sourceName = basename(git(sourceRoot, ['rev-parse', '--show-toplevel']));
  // Read raw blobs: git archive applies export-ignore/export-subst attributes,
  // and checkout can run filters. Neither is an exact view of committed bytes.
  const entries = listCommittedTree(sourceRoot, pin.commitSha, limits.maxListingBytes);
  const files: TreeEntry[] = [];
  const links: TreeEntry[] = [];
  let submodules = 0;
  for (const entry of entries) {
    if (entry.kind === "commit" && entry.mode === "160000") submodules += 1;
    else if (entry.kind === "blob" && entry.mode === "120000") links.push(entry);
    else if (entry.kind === "blob" && (entry.mode === "100644" || entry.mode === "100755")) files.push(entry);
    else throw new Error(`Unsupported committed source entry (mode ${entry.mode}, ${entry.kind}): ${entry.path}`);
  }
  if (files.length + links.length > limits.maxFiles) throw new ScanSizeLimitError("files", limits.maxFiles, files.length + links.length);
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > limits.maxBytes) throw new ScanSizeLimitError("bytes", limits.maxBytes, totalBytes);

  // Symlink targets are tiny blobs; read them only to classify. A "target" longer than
  // PATH_MAX cannot resolve and is never read.
  const readableLinks = links.filter(entry => entry.size <= MAX_SYMLINK_TARGET_BYTES);
  const linkTargets = new Map<string, string>();
  readBlobsInChunks(sourceRoot, readableLinks, limits.batchBytes, (index, bytes) => { linkTargets.set(readableLinks[index]!.path, bytes.toString("utf8")); });
  const linkClasses = classifyTreeSymlinkTargets(linkTargets, files.map(entry => entry.path));
  const skipped: SkippedTreeEntries = { ...emptySkippedEntries(), symlinksUnresolved: links.length - readableLinks.length, submodules };
  for (const kind of linkClasses.values()) if (kind !== "internal") countSymlink(skipped, kind);

  const temporary = mkdtempSync(join(options.tempRoot ?? scanWorkDir(), "okie-committed-"));
  const root = join(temporary, sourceName);
  try {
    // Fixed 0755 (umask can only remove bits): an in-repository directory is never
    // group/other-writable, which the Rust ancestor check refuses (CLA-605: a nested
    // Cargo context has repository directories as ancestors). Same as the tarball path.
    mkdirSync(root, { mode: 0o755 });
    // Regular files first (no link exists yet, so no write can pass through one), in
    // ls-tree byte order. On a case-insensitive filesystem two case-aliased files land in
    // one file (first spelling, last content) — deterministic for a given filesystem; a
    // file/directory conflict (`D` vs `d/x`) skips the file and is counted, never crashes.
    let pathCollisions = 0;
    readBlobsInChunks(sourceRoot, files, limits.batchBytes, (index, bytes) => {
      const entry = files[index]!;
      const target = join(root, entry.path);
      try {
        mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
        writeFileSync(target, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTDIR" && code !== "EISDIR") throw error;
        pathCollisions += 1;
      }
    });
    if (pathCollisions) skipped.pathCollisions = pathCollisions;
    // In-root links, only where provably safe: a link whose path (or a parent) folds onto
    // another entry's spelling is skipped outright, and each placement re-checks its parents
    // component by component. Every skipped link counts as unresolved (not followed).
    const colliding = foldCollidingPaths(entries.map(entry => entry.path), links.map(entry => entry.path));
    for (const [path, kind] of linkClasses) {
      if (kind !== "internal") continue;
      if (colliding.has(path) || !placeSymlinkSafely(root, path, linkTargets.get(path)!)) countSymlink(skipped, "unresolved");
    }
    const removed = detachSymlinks(root);
    skipped.symlinksEscaping += removed.symlinksEscaping;
    skipped.symlinksUnresolved += removed.symlinksUnresolved;
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    root,
    checkoutRoot: temporary,
    installationRoot: sourceRoot,
    pin,
    sourceName,
    skipped,
    cleanup: () => {
      if (!cleaned) rmSync(temporary, { recursive: true, force: true });
      cleaned = true;
    },
  };
}
