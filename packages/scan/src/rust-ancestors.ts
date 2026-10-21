import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

/**
 * CLA-305: rust-analyzer and cargo read configuration from the ANCESTORS of the tree they analyse, not only the tree.
 * Verified with rust-analyzer 1.87 / cargo 1.87 (docs/architecture/scan-sandbox.md):
 * - a rust-project.json / .rust-project.json (any letter case on a case-insensitive FS) in ANY ancestor is loaded
 *   instead of the tree's own Cargo.toml: its `sysroot` binaries run and the tree is not indexed;
 * - an ancestor `.cargo/config.toml` applies (its rustc / wrapper keys are neutralised by the scan-env pins, but other
 *   keys still shape `cargo metadata`, so it could poison the content-keyed SCIP cache);
 * - an ancestor Cargo.toml `[workspace]` captures a single-package tree (cargo metadata then fails outright).
 *
 * So before Rust analysis every ancestor of the analysis root must be owned by root or the scanner's uid and not
 * group/other-writable (no sticky-bit exemption: /tmp fails), no ancestor may hold a rust-project.json, and the
 * operator's own ancestor cargo config / manifests are recorded as limitations and folded into the cache key.
 */
export interface AncestorStat { uid: number; mode: number; isDirectory(): boolean }
/** Filesystem seam (tests inject fake ancestor layouts). */
export interface AncestorFs {
  realpath(path: string): string;
  lstat(path: string): AncestorStat;
  readdir(path: string): string[];
  readFile(path: string): string;
  /** lstat succeeds: on a case/normalization-insensitive FS this finds `Rust-Project.json` or `ruſt-project.json` too. */
  exists(path: string): boolean;
}
export const nodeAncestorFs: AncestorFs = {
  realpath: path => realpathSync(path),
  lstat: path => lstatSync(path),
  readdir: path => readdirSync(path),
  readFile: path => readFileSync(path, "utf8"),
  exists: path => { try { lstatSync(path); return true; } catch { return false; } },
};

export interface RustAncestorReport {
  /** Set when Rust analysis must not run. */
  refusal?: string;
  limitations: string[];
  /** Ancestor files that shape cargo's view of the tree; content and position relative to the tree go in the SCIP cache key. */
  keyInputs: Array<{ path: string; relative: string; content: string }>;
}

/**
 * Name comparison approximating a case- and normalization-insensitive filesystem (APFS, NTFS): NFC, then upper- then
 * lower-case, so `ſ` (U+017F) folds to `s` and `K` (U+212A) to `k`. A second layer only: {@link rustProjectJsonIn} also
 * asks the filesystem itself.
 */
export function fsName(name: string): string { return name.normalize("NFC").toUpperCase().toLowerCase(); }
export const RUST_PROJECT_JSON_NAMES = new Set(["rust-project.json", ".rust-project.json"]);

/**
 * The rust-project.json files rust-analyzer could open in `directory`: every entry whose folded name matches, plus a
 * direct lstat of the canonical names (the filesystem's own case/normalization folding decides, whatever the stored
 * name is). Paths are returned as found.
 */
export function rustProjectJsonIn(directory: string, names: readonly string[], fs: Pick<AncestorFs, "exists">): string[] {
  const found = names.filter(name => RUST_PROJECT_JSON_NAMES.has(fsName(name))).map(name => join(directory, name));
  for (const canonical of RUST_PROJECT_JSON_NAMES) {
    if (!found.some(path => fsName(basename(path)) === canonical) && fs.exists(join(directory, canonical))) found.push(join(directory, canonical));
  }
  return found.sort();
}

/** A Cargo.toml that defines a workspace: `[workspace]`, `[ workspace ]`, `[workspace.*]` tables or dotted/inline `workspace` keys. */
export function definesCargoWorkspace(manifest: string): boolean {
  return /^\s*(\[\s*workspace\s*[\].]|workspace\s*[.=])/m.test(manifest);
}

/** Deterministic rendering of an ancestor path: relative to the tree (never an absolute or mkdtemp path). */
function fromTree(real: string, path: string): string { return relative(real, path) || "."; }

const WORK_DIR_HINT = "Set OKIE_SCAN_WORK_DIR to a private directory (0700, owned by the scanner's user) outside any Cargo workspace.";

/**
 * `repositoryRoot` (CLA-605): when the analysis root is a Cargo context BELOW the scanned tree, the tree directories
 * between them are ancestors too. They get exactly the same ownership/mode/rust-project.json refusals; their cargo
 * manifests and configs are keyed the same way and labelled as repository files (repository-relative paths).
 */
export function inspectRustAncestors(root: string, options: { fs?: AncestorFs; uid?: number | undefined; repositoryRoot?: string } = {}): RustAncestorReport {
  const fs = options.fs ?? nodeAncestorFs;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const report: RustAncestorReport = { limitations: [], keyInputs: [] };
  let real: string;
  try { real = fs.realpath(root); } catch (error) { return { ...report, refusal: `Rust analysis skipped: cannot resolve the scanned tree (${error instanceof Error ? error.message : String(error)}).` }; }
  let repository: string | undefined;
  if (options.repositoryRoot !== undefined) {
    try { repository = fs.realpath(options.repositoryRoot); } catch (error) { return { ...report, refusal: `Rust analysis skipped: cannot resolve the scanned tree (${error instanceof Error ? error.message : String(error)}).` }; }
    if (repository === real) repository = undefined;
  }
  const inRepository = (path: string): boolean => repository !== undefined && (path === repository || path.startsWith(`${repository}/`));
  /** Repository paths render repository-relative (`.` = its root); others relative to the analysis root. */
  const label = (path: string): string => inRepository(path) ? relative(repository!, path) || "." : fromTree(real, path);
  const ancestors: string[] = [];
  for (let directory = dirname(real); ; directory = dirname(directory)) { ancestors.push(directory); if (dirname(directory) === directory) break; }
  for (const directory of ancestors) {
    let stat: AncestorStat;
    const own = inRepository(directory);
    const at = label(directory);
    const what = own ? "a repository directory above the analysed Cargo context" : "an ancestor of the scanned tree";
    const hint = own ? "" : ` ${WORK_DIR_HINT}`;
    try { stat = fs.lstat(directory); } catch { return { ...report, refusal: `Rust analysis skipped: cannot inspect ${at}, ${what}.${hint}` }; }
    if (uid !== undefined) {
      if (stat.uid !== 0 && stat.uid !== uid) return { ...report, refusal: `Rust analysis skipped: ${at}, ${what}, is owned by another user (uid ${stat.uid}), who could plant rust-project.json or .cargo/config.toml there.${hint}` };
      if ((stat.mode & 0o022) !== 0) return { ...report, refusal: `Rust analysis skipped: ${at}, ${what}, is group- or world-writable, so another user could plant rust-project.json or .cargo/config.toml there.${hint}` };
    }
    let names: string[]; try { names = fs.readdir(directory); } catch { names = []; }
    const projects = rustProjectJsonIn(directory, names, fs);
    if (projects.length) return { ...report, refusal: own
      ? `Rust analysis skipped: ${label(projects[0]!)}, above the analysed Cargo context, would be loaded by rust-analyzer instead of it.`
      : `Rust analysis skipped: ${fromTree(real, projects[0]!)} in an ancestor of the scanned tree would be loaded by rust-analyzer instead of the tree. ${WORK_DIR_HINT}` };
    for (const name of [...names].sort()) {
      const folded = fsName(name); const path = join(directory, name);
      if (folded === "cargo.toml") {
        report.keyInputs.push({ path, relative: fromTree(real, path), content: safeRead(fs, path) });
        report.limitations.push(own
          ? `A repository Cargo manifest above the analysed Cargo context (${label(path)}) applies to Rust analysis: a [workspace] there that includes the context captures its crates.`
          : `A Cargo manifest in an ancestor of the scanned tree (${fromTree(real, path)}) can capture its crates into that workspace. ${WORK_DIR_HINT}`);
      }
      if (folded === ".cargo") {
        let inner: string[]; try { inner = fs.readdir(path); } catch { inner = []; }
        for (const configName of [...inner].sort()) {
          if (!["config", "config.toml"].includes(fsName(configName))) continue;
          const configPath = join(path, configName);
          report.keyInputs.push({ path: configPath, relative: fromTree(real, configPath), content: safeRead(fs, configPath) });
          report.limitations.push(own
            ? `Repository cargo config above the analysed Cargo context applies to Rust analysis: ${label(configPath)}.`
            : `Operator cargo config in an ancestor of the scanned tree applies to Rust analysis: ${fromTree(real, configPath)}.`);
        }
      }
    }
  }
  return report;
}

function safeRead(fs: AncestorFs, path: string): string {
  try { return fs.readFile(path); } catch { return "<unreadable>"; }
}

/**
 * Why `dir` is unfit as the scanner work root (the tree will live below it), or undefined when it is fit: `dir` and
 * every ancestor must pass the same ownership/mode check as above, and none may hold a rust-project.json or a
 * Cargo.toml with `[workspace]` (which would capture single-package trees).
 */
export function inspectWorkRoot(dir: string, options: { fs?: AncestorFs; uid?: number | undefined } = {}): string | undefined {
  const fs = options.fs ?? nodeAncestorFs;
  const uid = "uid" in options ? options.uid : process.getuid?.();
  let real: string;
  try { real = fs.realpath(dir); } catch (error) { return `cannot resolve ${dir} (${error instanceof Error ? error.message : String(error)})`; }
  for (let directory = real; ; directory = dirname(directory)) {
    let stat: AncestorStat;
    try { stat = fs.lstat(directory); } catch { return `cannot inspect ${directory}`; }
    if (uid !== undefined && stat.uid !== 0 && stat.uid !== uid) return `${directory} is owned by another user (uid ${stat.uid})`;
    if (uid !== undefined && (stat.mode & 0o022) !== 0) return `${directory} is group- or world-writable`;
    let names: string[]; try { names = fs.readdir(directory); } catch { names = []; }
    const projects = rustProjectJsonIn(directory, names, fs);
    if (projects.length) return `${projects[0]} would be loaded by rust-analyzer`;
    for (const name of names) {
      const path = join(directory, name);
      if (fsName(name) === "cargo.toml" && definesCargoWorkspace(safeRead(fs, path))) return `${path} is a Cargo workspace that would capture scanned crates`;
    }
    if (dirname(directory) === directory) return undefined;
  }
}
