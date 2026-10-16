import { createRequire } from "node:module";
import type TypeScript from "typescript";
import type Parser from "tree-sitter";

/**
 * The one loader for the scanner's language tooling: `typescript`, and the native
 * `tree-sitter` + `tree-sitter-rust` parsers. Nothing is imported at module load, so
 * `--help`, `export`, `enrich` and TypeScript-only scans work on a platform with no
 * tree-sitter prebuild. A missing native parser degrades Rust to `unavailable`
 * (like a missing rust-analyzer); it never fails a scan.
 *
 * Loading is synchronous (`createRequire`) rather than `import()`: the scan pipeline
 * is synchronous and library callers reach the analyzers without an async entry
 * point. All three packages are CommonJS, so this is the same module either way.
 */
const requireModule = createRequire(import.meta.url);

export interface AnalyzerLoad {
  /** False when a requested analyzer failed to load. */
  ok: boolean;
  /** Resolved versions of what loaded. */
  versions: { typescript?: string; "tree-sitter"?: string; "tree-sitter-rust"?: string };
  /** Load failures, one line each. */
  errors: string[];
  /** `<platform>-<arch> (node abi <n>)`: what a native prebuild must match. */
  platform: string;
}

let typescriptModule: typeof TypeScript | undefined;
let rustGrammar: { Parser: typeof Parser; language: Parser.Language } | { error: string } | undefined;
let sharedRustParser: Parser | undefined;

export function analyzerPlatform(): string {
  return `${process.platform}-${process.arch} (node abi ${process.versions.modules})`;
}

function loadTypeScript(): typeof TypeScript {
  return typescriptModule ??= requireModule("typescript") as typeof TypeScript;
}

/**
 * The TypeScript compiler API, loaded on first property access. Modules use it as
 * they used `import ts from "typescript"`; type positions use the type-only import.
 */
export const ts: typeof TypeScript = new Proxy({} as typeof TypeScript, {
  get: (_target, property) => Reflect.get(loadTypeScript(), property),
  has: (_target, property) => Reflect.has(loadTypeScript(), property),
});

function loadRustGrammar(): NonNullable<typeof rustGrammar> {
  if (rustGrammar) return rustGrammar;
  try {
    rustGrammar = {
      Parser: requireModule("tree-sitter") as typeof Parser,
      language: requireModule("tree-sitter-rust") as Parser.Language,
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
    rustGrammar = { error: `Rust parser unavailable: tree-sitter has no usable native build for ${analyzerPlatform()}: ${detail.replace(/\.$/, "")}.` };
  }
  return rustGrammar;
}

/** Why Rust cannot be parsed on this machine, or undefined when it can. */
export function rustParserUnavailable(): string | undefined {
  const grammar = loadRustGrammar();
  return "error" in grammar ? grammar.error : undefined;
}

/** Shared Rust parser. Callers check `rustParserUnavailable()` first; this throws when it is set. */
export function rustParser(): Parser {
  if (sharedRustParser) return sharedRustParser;
  const grammar = loadRustGrammar();
  if ("error" in grammar) throw new Error(grammar.error);
  sharedRustParser = new grammar.Parser();
  sharedRustParser.setLanguage(grammar.language);
  return sharedRustParser;
}

function packageVersion(name: string): string | undefined {
  try { return (requireModule(`${name}/package.json`) as { version?: string }).version; } catch { return undefined; }
}

/** Load the analyzers a scan needs (Rust only when asked) and report what resolved. */
export function loadAnalyzers(options: { rust?: boolean } = {}): AnalyzerLoad {
  const result: AnalyzerLoad = { ok: true, versions: {}, errors: [], platform: analyzerPlatform() };
  try {
    result.versions.typescript = loadTypeScript().version;
  } catch (error) {
    result.ok = false;
    result.errors.push(`typescript unavailable: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
  }
  if (options.rust) {
    const unavailable = rustParserUnavailable();
    if (unavailable) {
      result.ok = false;
      result.errors.push(unavailable);
    } else {
      const treeSitter = packageVersion("tree-sitter");
      const treeSitterRust = packageVersion("tree-sitter-rust");
      if (treeSitter) result.versions["tree-sitter"] = treeSitter;
      if (treeSitterRust) result.versions["tree-sitter-rust"] = treeSitterRust;
    }
  }
  return result;
}
