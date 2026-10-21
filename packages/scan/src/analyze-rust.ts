import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type Parser from "tree-sitter";
import { PositionEncoding, SymbolRole, type Occurrence } from "@scip-code/scip";
import type { AnalysisDefinition, AnalysisExternalReference, AnalysisLocation, LanguageAnalysis } from "./language-analysis.js";
import { rustParser, rustParserUnavailable } from "./analyzers.js";
import { decodeScipIndex } from "./scip.js";
import { cachedScipIndex, rustAnalyzerVersion, rustcIdentity, rustInputDigest } from "./scip-cache.js";
import { createScanScratch, operatorCargoHome, rustToolchainPin, scanSpawnSync, scanWorkDir, type ScanScratch } from "./scan-env.js";
import { inspectRustAncestors, nodeAncestorFs, rustProjectJsonIn, type AncestorFs } from "./rust-ancestors.js";
import { labelledPrefix, pathPrefixRewriter } from "./path-prefixes.js";
import { compareText } from "@okie/architecture";

type Point = { row: number; column: number };
type OccurrenceRange = { start: Point; end: Point };

const OUTLINE_ITEMS = new Set([
  "function_item", "struct_item", "enum_item", "trait_item", "mod_item", "type_item",
  "const_item", "static_item", "union_item", "macro_definition",
]);

function canonical<T>(items: Iterable<T>): T[] {
  return [...items].sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right)));
}

/** Sysroot crates are the language, not a dependency. */
const SYSROOT_CRATES = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** `<scheme> cargo <crate> <version> <descriptors>`; undefined for locals and other managers. */
export function parseScipCargoSymbol(symbol: string): { crate: string; version: string; descriptors: string } | undefined {
  const match = /^\S+ cargo (\S+) (\S+) (.+)$/.exec(symbol);
  return match ? { crate: match[1]!, version: match[2]!, descriptors: match[3]! } : undefined;
}

/** Render SCIP descriptors as a Rust-ish path: `device/Device#create_buffer().` → `wgpu::device::Device::create_buffer`. */
export function rustSymbolDisplay(crate: string, descriptors: string): string | undefined {
  const parts: string[] = [];
  let index = 0;
  const readName = (): string => {
    if (descriptors[index] === "`") {
      let out = "";
      index += 1;
      while (index < descriptors.length) {
        if (descriptors[index] === "`") {
          if (descriptors[index + 1] === "`") { out += "`"; index += 2; continue; }
          break;
        }
        out += descriptors[index++];
      }
      index += 1;
      return out;
    }
    const start = index;
    while (index < descriptors.length && /[A-Za-z0-9_$+-]/.test(descriptors[index]!)) index += 1;
    return descriptors.slice(start, index);
  };
  while (index < descriptors.length) {
    const character = descriptors[index];
    if (character === "[" || character === "(") {
      index += 1;
      const name = readName();
      if (descriptors[index] !== (character === "[" ? "]" : ")")) return undefined;
      index += 1;
      if (character === "[" && parts.length) parts[parts.length - 1] += `<${name}>`;
      continue;
    }
    const name = readName();
    if (!name) return undefined;
    const suffix = descriptors[index];
    if (suffix === "(") {
      const close = descriptors.indexOf(").", index);
      if (close < 0) return undefined;
      index = close + 2;
    } else if (suffix !== undefined && "/#.:!".includes(suffix)) index += 1;
    else return undefined;
    parts.push(name);
  }
  return parts.length ? [crate.replace(/-/g, "_"), ...parts].join("::") : undefined;
}

/** A SCIP symbol from a third-party crate (not sysroot, not a workspace crate, not a bare crate root). */
export function externalCargoSymbol(symbol: string, firstPartyCrates: ReadonlySet<string>): { crate: string; version: string; display: string } | undefined {
  const parsed = parseScipCargoSymbol(symbol);
  if (!parsed || SYSROOT_CRATES.has(parsed.crate) || parsed.version.includes("://") || firstPartyCrates.has(parsed.crate)) return undefined;
  if (parsed.descriptors === "crate/") return undefined;
  const display = rustSymbolDisplay(parsed.crate, parsed.descriptors);
  return display ? { crate: parsed.crate, version: parsed.version, display } : undefined;
}

/** `local N` symbols are only unique within one SCIP document. */
function isDocumentLocalSymbol(symbol: string): boolean {
  return /^local \d+$/.test(symbol);
}

function sameDefinition(left: AnalysisDefinition, right: AnalysisDefinition): boolean {
  return left.path === right.path
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

function hasWasmTargetGate(text: string): boolean {
  return /target_arch\s*=\s*"wasm32"/.test(text);
}

function occurrenceRange(occurrence: Occurrence): OccurrenceRange | undefined {
  if (occurrence.typedRange.case === "singleLineRange") {
    const value = occurrence.typedRange.value;
    return { start: { row: value.line, column: value.startCharacter }, end: { row: value.line, column: value.endCharacter } };
  }
  if (occurrence.typedRange.case === "multiLineRange") {
    const value = occurrence.typedRange.value;
    return { start: { row: value.startLine, column: value.startCharacter }, end: { row: value.endLine, column: value.endCharacter } };
  }
  if (occurrence.range.length === 3) return { start: { row: occurrence.range[0]!, column: occurrence.range[1]! }, end: { row: occurrence.range[0]!, column: occurrence.range[2]! } };
  if (occurrence.range.length === 4) return { start: { row: occurrence.range[0]!, column: occurrence.range[1]! }, end: { row: occurrence.range[2]!, column: occurrence.range[3]! } };
  return undefined;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  return starts;
}

/** Convert rust-analyzer's UTF-8 byte column to a JS string offset. */
function offsetAt(text: string, starts: readonly number[], point: Point, encoding: PositionEncoding): number | undefined {
  const lineStart = starts[point.row];
  if (lineStart === undefined) return undefined;
  const lineEnd = text.indexOf("\n", lineStart);
  const limit = lineEnd < 0 ? text.length : lineEnd;
  if (encoding !== PositionEncoding.UTF8CodeUnitOffsetFromLineStart) return Math.min(lineStart + point.column, limit);
  let offset = lineStart;
  let bytes = 0;
  while (offset < limit && bytes < point.column) {
    const character = String.fromCodePoint(text.codePointAt(offset)!);
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > point.column) return undefined;
    bytes += width;
    offset += character.length;
  }
  return bytes === point.column ? offset : undefined;
}

function location(path: string, text: string, starts: readonly number[], range: OccurrenceRange, encoding: PositionEncoding): AnalysisLocation | undefined {
  const startOffset = offsetAt(text, starts, range.start, encoding);
  const endOffset = offsetAt(text, starts, range.end, encoding);
  if (startOffset === undefined || endOffset === undefined) return undefined;
  return { path, startLine: range.start.row + 1, endLine: range.end.row + 1, startOffset, endOffset };
}

function callAt(tree: Parser.Tree, point: Point): boolean {
  let node = tree.rootNode.descendantForPosition(point);
  for (; node.parent; node = node.parent) {
    const parent = node.parent;
    if (parent.type === "call_expression") {
      const callee = parent.childForFieldName("function");
      return !!callee && node.startIndex >= callee.startIndex && node.endIndex <= callee.endIndex;
    }
    if (parent.type === "method_call_expression") {
      const method = parent.childForFieldName("method");
      return !!method && node.startIndex >= method.startIndex && node.endIndex <= method.endIndex;
    }
  }
  return false;
}

function importAt(tree: Parser.Tree, point: Point): boolean {
  let node = tree.rootNode.descendantForPosition(point);
  for (; node.parent; node = node.parent) if (node.parent.type === "use_declaration") return true;
  return false;
}

/** Match the same declaration surface that the Rust outline extractor publishes. */
function outlinedDefinitionAt(tree: Parser.Tree, range: OccurrenceRange): Parser.SyntaxNode | undefined {
  let node = tree.rootNode.descendantForPosition(range.start);
  for (; node.parent; node = node.parent) {
    const item = node.parent;
    if (!OUTLINE_ITEMS.has(item.type)) continue;
    const name = item.childForFieldName("name");
    if (!name || range.start.row < name.startPosition.row || range.end.row > name.endPosition.row) continue;
    if (item.type === "function_item") {
      const list = item.parent;
      if (list?.type === "declaration_list" && list.parent?.type === "impl_item") return name;
      if (item.parent?.type === "source_file") return name;
      continue;
    }
    if (item.parent?.type === "source_file") return name;
  }
  return undefined;
}

function moduleTarget(path: string, text: string, allowed: ReadonlySet<string>): LanguageAnalysis["modules"] {
  const tree = rustParser().parse(text);
  const modules: LanguageAnalysis["modules"] = [];
  const normalize = (candidate: string): string => candidate.split(sep).join("/");
  const rootDirectory = (): string => {
    const directory = dirname(path);
    const file = basename(path);
    return ["lib.rs", "main.rs", "mod.rs"].includes(file) ? directory : join(directory, file.slice(0, -extname(file).length));
  };
  const pathAttribute = (node: Parser.SyntaxNode): string | undefined => {
    const attribute = node.previousNamedSibling;
    if (attribute?.type !== "attribute_item") return undefined;
    return /#\s*\[\s*path\s*=\s*"([^"\\]+)"\s*\]/.exec(attribute.text)?.[1];
  };
  const visit = (node: Parser.SyntaxNode, moduleDirectory: string): void => {
    if (node.type === "mod_item") {
      const name = node.childForFieldName("name");
      // Inline modules are containment, not a file dependency.
      const body = node.childForFieldName("body");
      if (name && !body) {
        const stem = name.text;
        const explicit = pathAttribute(node);
        const candidates = explicit
          ? [normalize(join(moduleDirectory, explicit))]
          : [normalize(join(moduleDirectory, `${stem}.rs`)), normalize(join(moduleDirectory, stem, "mod.rs"))];
        const targetPath = candidates.find(candidate => allowed.has(candidate));
        if (targetPath) modules.push({ path, startLine: name.startPosition.row + 1, endLine: name.endPosition.row + 1, startOffset: name.startIndex, endOffset: name.endIndex, targetPath });
      } else if (name && body) {
        for (const child of body.namedChildren) visit(child, join(moduleDirectory, name.text));
      }
      return;
    }
    for (const child of node.namedChildren) visit(child, moduleDirectory);
  };
  visit(tree.rootNode, rootDirectory());
  return modules;
}

/**
 * Truthful dependency-resolution line (both CARGO_HOME modes). `reason` is cargo's first error line from an offline
 * `cargo metadata` of the root manifest; undefined when there is no root manifest to check.
 * - default (isolated scratch CARGO_HOME): emitted when resolution failed, or could not be checked;
 * - OKIE_SCAN_CARGO_HOME: emitted only when resolution failed (e.g. a git dependency that is not in that cache).
 */
export function rustDependencyLimitation(mode: "isolated" | "operator", reason: string | undefined): string {
  return mode === "isolated"
    ? `crates.io dependencies are not resolved (offline, isolated CARGO_HOME${reason ? `: ${reason}` : ""}): external references to them are omitted, and calls through dependency types may be missed. An operator can set OKIE_SCAN_CARGO_HOME to a registry cache.`
    : `Dependency resolution failed offline (${reason ?? "unknown error"}): external references omitted and calls through dependency types may be missed.`;
}

/** First `error:` line of cargo's stderr, with machine paths replaced (tree, scratch, CARGO_HOME, home). */
export function scrubCargoError(stderr: string, paths: ReadonlyArray<readonly [label: string, path: string | undefined]>): string {
  const lines = stderr.split("\n").map(line => line.trim()).filter(Boolean);
  const line = lines.find(item => /^error\b/i.test(item)) ?? lines[0] ?? "cargo metadata failed";
  return pathPrefixRewriter(paths.map(([label, path]) => labelledPrefix(label, path)))(line).replace(/^error:\s*/i, "").slice(0, 300);
}

/**
 * Why a rust-analyzer run failed, as one stable line: its first `Error:` line, or else its panic (`thread 'main'
 * panicked at crates/…/x.rs:12:5:` plus the message line after it), with machine paths replaced — never the whole
 * stderr (wall-clock log timestamps, progress lines, the temporary checkout, a backtrace).
 */
export function scrubScipError(stderr: string, paths: ReadonlyArray<readonly [label: string, path: string | undefined]>): string {
  const lines = stderr.split("\n").map(line => line.trim());
  if (lines.some(line => /^error\b/i.test(line))) return scrubCargoError(stderr, paths);
  const panic = lines.findIndex(line => /^thread '.*' panicked at /.test(line));
  if (panic < 0) return "rust-analyzer exited unsuccessfully.";
  // Rust 1.73+ prints the location ending in `:` and the message on the next line.
  const message = lines[panic]!.endsWith(":") && lines[panic + 1] ? `${lines[panic]} ${lines[panic + 1]}` : lines[panic]!;
  return scrubCargoError(message, paths);
}

/**
 * CLA-305 lockdown, carried by a config file on EVERY rust-analyzer `scip` run. Verified against rust-analyzer 1.87 (see
 * docs/architecture/scan-sandbox.md): `scip` ignores `cargo.buildScripts.enable` and `procMacro.enable` / `procMacro.server`
 * (it always loads build data and uses the sysroot proc-macro server), but it does honour
 * `cargo.buildScripts.overrideCommand`. Replacing the build-data step with a no-op that exits 0 and prints nothing means
 * no build script is compiled or run, no proc-macro dylib is built (so none is loaded), and no `target/` is written in
 * the tree; the index is still produced from the source. A repository `rust-analyzer.toml` is not read by `scip`.
 */
export const RUST_LOCKDOWN_LIMITATION = "Build scripts and proc macros are not executed: code generated into OUT_DIR (include!(concat!(env!(\"OUT_DIR\"), ...))) and items produced by proc-macro expansion are not indexed.";

/** An absolute no-op command: exits 0 with no output. /usr/bin/true exists on macOS and glibc Linux; /bin/true on busybox. */
export function lockdownNoopCommand(): string[] {
  for (const candidate of ["/usr/bin/true", "/bin/true"]) if (existsSync(candidate)) return [candidate];
  return [process.execPath, "-e", ""];
}

/** The rust-analyzer config for one variant, with the lockdown merged in; `noop` is a placeholder in the cache key. */
export function rustAnalyzerConfig(variant: "host" | "wasm32", noop: readonly string[] = lockdownNoopCommand()): Record<string, unknown> {
  const buildScripts = { overrideCommand: [...noop] };
  return variant === "wasm32"
    ? { cargo: { target: "wasm32-unknown-unknown", allTargets: false, buildScripts } }
    : { cargo: { buildScripts } };
}

/**
 * rust-analyzer loads `proc_macro_dylib_path` dylibs into its sysroot proc-macro server, and runs the `sysroot`'s
 * `bin/rustc` and `libexec/rust-analyzer-proc-macro-srv`, whatever the config says (both verified with 1.87). A
 * rust-project.json that names either (or a sysroot source), cannot be parsed, or is a symlink is refused: returns the
 * reason, or undefined when every rust-project.json in the tree is safe to load. Each directory is checked by folded
 * name AND by asking the filesystem for the canonical names, so `Rust-Project.JSON` or `ruſt-project.json` (what
 * rust-analyzer opens on APFS) cannot slip past.
 */
export function unsafeRustProjectJson(root: string): string | undefined {
  const refused: string[] = [];
  const walk = (directory: string) => {
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) if (entry.isDirectory() && entry.name !== ".git") walk(join(directory, entry.name));
    // Folded names plus a direct lstat of the canonical names (the filesystem's own folding: `ruſt-project.json`).
    for (const absolute of rustProjectJsonIn(directory, entries.map(entry => entry.name), nodeAncestorFs)) {
      const path = relative(root, absolute).split(sep).join("/");
      let regular = false; try { regular = lstatSync(absolute).isFile(); } catch { regular = false; }
      if (!regular) { refused.push(`${path} (not a regular file)`); continue; }
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(absolute, "utf8")); } catch { refused.push(`${path} (unparseable)`); continue; }
      const keys = new Set<string>();
      const visit = (value: unknown) => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== "object") return;
        for (const [key, inner] of Object.entries(value)) {
          if (["proc_macro_dylib_path", "sysroot", "sysroot_src", "sysroot_project"].includes(key) && inner !== null) keys.add(key);
          visit(inner);
        }
      };
      visit(parsed);
      if (keys.size) refused.push(`${path} (${[...keys].sort().join(", ")})`);
    }
  };
  walk(root);
  return refused.length ? `Rust analysis skipped: rust-analyzer would load or execute repository-supplied binaries named by ${refused.sort().join("; ")}.` : undefined;
}

/**
 * `cargo metadata --offline` of the root manifest with the scanner env (the same exposure rust-analyzer already has:
 * pinned cargo/rustc, no wrappers, no build scripts). Stdout is discarded; only success and the first error matter.
 */
function dependencyResolution(root: string, scratch: ScanScratch, cargoBinary: string | undefined, paths: ReadonlyArray<readonly [label: string, path: string | undefined]>): { checked: boolean; failed: boolean; reason?: string } {
  const manifest = join(root, "Cargo.toml");
  if (!existsSync(manifest)) return { checked: false, failed: false };
  // cwd = the tree (already ancestor-checked): cargo discovers `.cargo/config.toml` from its cwd, so this sees exactly
  // the configuration rust-analyzer's own `cargo metadata` sees (e.g. a vendored `[source]` replacement).
  const run = scanSpawnSync("rust", cargoBinary ?? "cargo", ["metadata", "--offline", "--format-version", "1", "--manifest-path", manifest], { cwd: root, scratch, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "ignore", "pipe"] });
  if (!run.error && run.status === 0) return { checked: true, failed: false };
  const reason = scrubCargoError(run.error ? `error: ${run.error.message}` : run.stderr ?? "", paths);
  return { checked: true, failed: true, reason };
}

/**
 * Invoke rust-analyzer's SCIP exporter and retain only resolved, in-repository facts.
 * Import/file links are emitted separately; calls are established from the parsed call AST.
 */
export interface RustAnalysisOptions {
  /** CLA-271: content-addressed SCIP index cache directory (see scip-cache.ts); absent = always run rust-analyzer. */
  indexCacheDir?: string;
  /** Test/measurement seam: reports whether each SCIP run was served from the cache. */
  onIndex?: (variant: "host" | "wasm32", cache: "hit" | "miss" | "off") => void;
  /** Test seam for the ancestor inspection (rust-ancestors.ts). */
  ancestorFs?: AncestorFs;
  /** The scan's temporary directory holding the tree (AcquiredCommittedTree.checkoutRoot), named `<checkout>` in errors. */
  checkoutRoot?: string;
}

export function analyzeRust(sourceRoot: string, discoveredFiles?: readonly string[], options: RustAnalysisOptions = {}): LanguageAnalysis {
  // Symlinks resolved: the path rust-analyzer and cargo walk up from is exactly the one the ancestor check inspects.
  let root = resolve(sourceRoot);
  try { root = realpathSync(root); } catch { /* missing tree: nothing below will index it */ }
  const allFiles = discoveredFiles ?? [];
  const allowed = new Set(allFiles.filter(path => path.endsWith(".rs")).map(path => path.split(sep).join("/")));
  const result: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], coverage: [] };
  if (!allowed.size) return result;
  const unavailable = (limitation: string) => {
    result.coverage.push({ language: "rust", tool: "rust-analyzer", version: "unavailable", coverage: "unavailable", indexedFiles: [], limitations: [limitation] });
    return result;
  };
  const noParser = rustParserUnavailable();
  if (noParser) return unavailable(noParser);
  const refusal = unsafeRustProjectJson(root);
  if (refusal) return unavailable(refusal);
  const ancestors = inspectRustAncestors(root, options.ancestorFs ? { fs: options.ancestorFs } : {});
  if (ancestors.refusal) return unavailable(ancestors.refusal);
  // Operator-owned ancestor cargo files shape `cargo metadata`: their content (and position relative to the tree, not
  // the machine path) is part of the cache key.
  const ancestorKey = ancestors.keyInputs.length ? createHash("sha256").update(JSON.stringify(ancestors.keyInputs.map(({ relative, content }) => ({ relative, content })))).digest("hex") : null;
  const pin = rustToolchainPin();
  if (pin.error) return unavailable(`Rust analysis unavailable: ${pin.error}`);
  const cargo = operatorCargoHome();
  // A private (0700) scratch dir: HOME, CARGO_HOME, config files and index output, removed afterwards.
  const scratch = createScanScratch("okie-rust-scip-");
  const temporary = scratch.dir;
  /** Machine paths an error line may name, replaced by label. */
  const machinePaths = [["tree", root], ["checkout", options.checkoutRoot], ["scratch", temporary], ["CARGO_HOME", cargo.path], ["work-root", scanWorkDir()], ["home", homedir()]] as const;
  /** One rust-analyzer SCIP run through the optional cache; the variant names the invocation minus machine paths. */
  const scip = (variant: "host" | "wasm32") => {
    const output = join(temporary, `${variant}.scip`); const configPath = join(temporary, `${variant}.json`);
    writeFileSync(configPath, JSON.stringify(rustAnalyzerConfig(variant)), { mode: 0o600 });
    const args = ["--config-path", configPath, "--exclude-vendored-libraries"];
    const digest = options.indexCacheDir ? (inputDigest ??= rustInputDigest(root)) : undefined;
    const toolchain = options.indexCacheDir ? (toolchainIdentity ??= rustcIdentity() ?? "") : undefined;
    // The key names the arguments with the config content (no-op path as a placeholder) in place of its temporary path.
    const keyArgs = args.map(arg => arg === configPath ? "<config>" : arg);
    const keyConfig = JSON.stringify(rustAnalyzerConfig(variant, ["<noop>"]));
    // The opt-in CARGO_HOME changes what resolves: its path and what it holds are part of the key.
    const cargoHome = cargo.path ? { path: cargo.path, registry: existsSync(join(cargo.path, "registry")), git: existsSync(join(cargo.path, "git")) } : "scratch";
    const result = cachedScipIndex({ ...(options.indexCacheDir ? { cacheDir: options.indexCacheDir } : {}), root, ...(digest ? { digest } : {}), ...(toolchain ? { toolchain } : {}), variant: JSON.stringify({ variant, args: keyArgs, config: keyConfig, cargoHome, ancestors: ancestorKey }), run: () => {
      // cwd is the scratch dir, never the tree: nothing about the toolchain is resolved from the repository.
      const spawned = scanSpawnSync("rust", "rust-analyzer", ["scip", root, "--output", output, ...args], { cwd: temporary, scratch, encoding: "utf8", timeout: 120_000 });
      if (spawned.error || spawned.status !== 0 || !existsSync(output)) return { stderr: spawned.stderr ?? "", error: scrubScipError(spawned.error ? `error: ${spawned.error.message}` : spawned.stderr ?? "", machinePaths) };
      return { bytes: readFileSync(output), stderr: spawned.stderr ?? "" };
    } });
    options.onIndex?.(variant, result.cache);
    return result;
  };
  let inputDigest: string | undefined; let toolchainIdentity: string | undefined;
  const limitations = new Set<string>(ancestors.limitations);
  try {
    const run = scip("host");
    if (!run.bytes) {
      const missing = !rustAnalyzerVersion();
      limitations.add(missing
        ? `rust-analyzer is unavailable for the scanner's Rust toolchain${pin.toolchain ? ` ${pin.toolchain}` : ""} (resolved from the scanner's working directory; set OKIE_SCAN_RUST_TOOLCHAIN to a toolchain with the rust-analyzer component): ${run.error || "not installed"}`
        : run.error || "rust-analyzer SCIP indexing failed.");
      result.coverage.push({ language: "rust", tool: "rust-analyzer", version: "unavailable", coverage: "unavailable", indexedFiles: [], limitations: canonical(limitations) });
      return result;
    }
    limitations.add(RUST_LOCKDOWN_LIMITATION);
    if (cargo.error) limitations.add(cargo.error);
    // Recomputed on every run (cache hit or not): did cargo actually resolve the dependency graph offline?
    const resolution = dependencyResolution(root, scratch, pin.cargo, machinePaths);
    if (resolution.failed || (!cargo.path && !resolution.checked)) limitations.add(rustDependencyLimitation(cargo.path ? "operator" : "isolated", resolution.reason));
    const indexes = [decodeScipIndex(run.bytes)];
    // The browser facade is deliberately compiled only for the target used by the
    // repository's wasm-pack build. rust-analyzer otherwise omits it on a host scan.
    const needsWasmTarget = [...allowed].some(path => {
      const absolute = join(root, path);
      return existsSync(absolute) && hasWasmTargetGate(readFileSync(absolute, "utf8"));
    });
    if (needsWasmTarget) {
      const wasmRun = scip("wasm32");
      if (!wasmRun.bytes) {
        limitations.add(`wasm32-unknown-unknown SCIP indexing failed: ${wasmRun.error || "rust-analyzer exited unsuccessfully."}`);
      } else {
        indexes.push(decodeScipIndex(wasmRun.bytes));
        limitations.add("Rust target coverage includes wasm32-unknown-unknown inferred from source cfg(target_arch = \"wasm32\"); other targets are not inferred.");
      }
      limitations.add("Rust feature coverage follows Cargo's default feature selection; optional features are not inferred.");
    }
    const documents = indexes.flatMap(index => index.documents);
    const files = new Map<string, { text: string; starts: number[]; tree: Parser.Tree }>();
    for (const path of allowed) {
      const absolute = join(root, path);
      if (!existsSync(absolute)) continue;
      const text = readFileSync(absolute, "utf8");
      files.set(path, { text, starts: lineStarts(text), tree: rustParser().parse(text) });
      for (const module of moduleTarget(path, text, allowed)) result.modules.push(module);
    }
    const names = new Map<string, string>();
    for (const document of documents) for (const symbol of document.symbols) if (symbol.displayName) names.set(symbol.symbol, symbol.displayName);
    const definitions = new Map<string, AnalysisDefinition>();
    const ambiguousSymbols = new Set<string>();
    const pending: Array<{ path: string; occurrence: Occurrence; range: OccurrenceRange; location: AnalysisLocation; tree: Parser.Tree }> = [];
    // Crates with a definition anywhere in the indexed repository are first-party.
    const firstPartyCrates = new Set<string>();
    for (const document of documents) for (const occurrence of document.occurrences) {
      if (occurrence.symbolRoles & SymbolRole.Definition) {
        const crate = parseScipCargoSymbol(occurrence.symbol)?.crate;
        if (crate) firstPartyCrates.add(crate);
      }
    }
    for (const document of documents) {
      const path = document.relativePath.split(sep).join("/");
      const file = files.get(path);
      if (!file) continue;
      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol || isDocumentLocalSymbol(occurrence.symbol)) continue;
        const range = occurrenceRange(occurrence);
        if (!range) continue;
        const observed = location(path, file.text, file.starts, range, document.positionEncoding);
        if (!observed) continue;
        if (occurrence.symbolRoles & SymbolRole.Definition) {
          const name = outlinedDefinitionAt(file.tree, range);
          // Do not turn local variables and parameters into graph targets: they have
          // no matching published L4 outline entity and would create false edges.
          if (!name) continue;
          const definition = {
            ...observed,
            symbol: occurrence.symbol,
            name: names.get(occurrence.symbol) || file.text.slice(name.startIndex, name.endIndex),
          };
          if (ambiguousSymbols.has(occurrence.symbol)) continue;
          const existing = definitions.get(occurrence.symbol);
          if (!existing) definitions.set(occurrence.symbol, definition);
          else if (!sameDefinition(existing, definition)) {
            definitions.delete(occurrence.symbol);
            ambiguousSymbols.add(occurrence.symbol);
          }
        } else pending.push({ path, occurrence, range, location: observed, tree: file.tree });
      }
    }
    result.definitions = canonical(definitions.values());
    const references = new Map<string, LanguageAnalysis["references"][number]>();
    const externalReferences = new Map<string, AnalysisExternalReference>();
    const toolInfo = indexes[0]?.metadata?.toolInfo;
    const analyzer = `${toolInfo?.name || "rust-analyzer"}@${(toolInfo?.version || "unknown").split(" ")[0]}`;
    const modules = new Map(result.modules.map(item => [`${item.path}:${item.startOffset}:${item.targetPath}`, item]));
    for (const pendingReference of pending) {
      if (!ambiguousSymbols.has(pendingReference.occurrence.symbol) && !definitions.has(pendingReference.occurrence.symbol)) {
        const external = externalCargoSymbol(pendingReference.occurrence.symbol, firstPartyCrates);
        // `use` paths are import evidence, captured syntactically elsewhere.
        if (external && !(pendingReference.occurrence.symbolRoles & SymbolRole.Import) && !importAt(pendingReference.tree, pendingReference.range.start)) {
          const kind = callAt(pendingReference.tree, pendingReference.range.start) ? "calls" : "uses";
          const reference: AnalysisExternalReference = { ...pendingReference.location, ecosystem: "cargo", package: external.crate,
            version: external.version, symbol: external.display, kind, analyzer };
          externalReferences.set(`${reference.path}:${reference.startOffset}:${pendingReference.occurrence.symbol}:${kind}`, reference);
        }
        continue;
      }
      // A reference without a definition in this committed source has no target edge.
      if (ambiguousSymbols.has(pendingReference.occurrence.symbol) || !definitions.has(pendingReference.occurrence.symbol)) continue;
      if ((pendingReference.occurrence.symbolRoles & SymbolRole.Import) || importAt(pendingReference.tree, pendingReference.range.start)) {
        const target = definitions.get(pendingReference.occurrence.symbol)!;
        modules.set(`${pendingReference.path}:${pendingReference.location.startOffset}:${target.path}`, { ...pendingReference.location, targetPath: target.path });
        continue;
      }
      const kind = callAt(pendingReference.tree, pendingReference.range.start) ? "calls" : "uses";
      const reference = { ...pendingReference.location, symbol: pendingReference.occurrence.symbol, kind } as LanguageAnalysis["references"][number];
      references.set(`${reference.path}:${reference.startOffset}:${reference.symbol}:${kind}`, reference);
    }
    result.references = canonical(references.values());
    result.modules = canonical(modules.values());
    result.externalReferences = canonical(externalReferences.values());
    const indexedFiles = [...new Set(documents.map(document => document.relativePath.split(sep).join("/")))].filter(path => files.has(path)).sort();
    const omitted = [...files.keys()].filter(path => !indexedFiles.includes(path)).sort();
    const tool = indexes[0]?.metadata?.toolInfo;
    if (run.stderr.includes("duplicate scip symbols")) limitations.add("rust-analyzer reported duplicate SCIP symbols; ambiguous symbols are omitted rather than linked to an arbitrary definition.");
    if (ambiguousSymbols.size) limitations.add(`Ambiguous SCIP definition symbols omitted: ${ambiguousSymbols.size}.`);
    if (omitted.length) limitations.add(`Not indexed by rust-analyzer SCIP: ${omitted.join(", ")}`);
    result.coverage.push({ language: "rust", tool: tool?.name || "rust-analyzer", version: tool?.version || "unknown", coverage: indexedFiles.length ? "semantic" : "unavailable", indexedFiles, limitations: canonical(limitations) });
    return result;
  } catch (error) {
    limitations.add(scrubCargoError(`error: ${error instanceof Error ? error.message : String(error)}`, machinePaths));
    result.coverage.push({ language: "rust", tool: "rust-analyzer", version: "unknown", coverage: "unavailable", indexedFiles: [], limitations: canonical(limitations) });
    return result;
  } finally {
    scratch.dispose();
  }
}
