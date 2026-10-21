import type TS from "typescript";
import { ts } from "./analyzers.js";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AnalysisDefinition, AnalysisExternalReference, AnalysisLocation, LanguageAnalysis } from "./language-analysis.js";
import { dependencyContext } from './dependency-context.js';
import { labelledPrefix, pathPrefixRewriter, type PathPrefix } from './path-prefixes.js';
import { scanWorkDir } from './scan-env.js';
import { compareText } from "@okie/architecture";

/** The package owning a declaration file: the segment after the LAST `node_modules/` (pnpm `.pnpm/…` layout safe). */
export function nodeModulesPackageOf(fileName: string): string | undefined {
  const normalized = fileName.split(sep).join("/");
  const marker = normalized.lastIndexOf("/node_modules/");
  if (marker < 0) return undefined;
  const segments = normalized.slice(marker + 14).split("/");
  const name = segments[0]!.startsWith("@") ? (segments[1] ? `${segments[0]}/${segments[1]}` : undefined) : segments[0];
  return name && !name.startsWith(".") ? name : undefined;
}

/** `@types/foo` types `foo`; `@types/scope__pkg` types `@scope/pkg`. */
export function typedPackageOf(name: string): string | undefined {
  const match = /^@types\/(.+)$/.exec(name);
  if (!match) return undefined;
  const scoped = /^([^_]+)__(.+)$/.exec(match[1]!);
  return scoped ? `@${scoped[1]}/${scoped[2]}` : match[1];
}

/** Where a scan's compiler runs: the scanned root, and the machine directories around it. */
export interface CompilerMessagePaths {
  /** The scan's own temporary directory holding `root` (see AcquiredCommittedTree.checkoutRoot). */
  checkoutRoot?: string;
  /** The scanner work dir holding every checkout (scanWorkDir). */
  workRoot?: string;
  installationRoot?: string;
  home?: string;
}

/**
 * Compiler messages name absolute paths (`File '/tmp/okie-committed-x/repo/lib/b.ts' is not under 'rootDir' …`).
 * Paths inside `root` become root-relative (`root` itself `.`). So do paths under the checkout or work dir that
 * contains `root` (`../missing/tsconfig.json`, `../../okie-base.json`): only the repository's own relative
 * references reach them. The installation root and home become `<label>`, as does a work dir not containing `root`.
 * Built once per analysis; a limitation never depends on the temporary checkout or where the repository lives.
 */
export function compilerMessageRelativizer(root: string, paths: CompilerMessagePaths = {}): (text: string) => string {
  const inside = (directory: string): boolean => {
    const up = relative(directory, root);
    return up !== "" && up !== ".." && !up.startsWith(`..${sep}`) && !isAbsolute(up);
  };
  const upTo = (directory: string): PathPrefix => {
    const up = relative(root, directory).split(sep).join("/");
    return { path: directory, bare: up, beforeSlash: `${up}/` };
  };
  return pathPrefixRewriter([
    { path: root, bare: ".", beforeSlash: "" },
    ...(paths.checkoutRoot && inside(paths.checkoutRoot) ? [upTo(paths.checkoutRoot)] : []),
    ...(paths.workRoot ? [inside(paths.workRoot) ? upTo(paths.workRoot) : labelledPrefix("work-root", paths.workRoot)] : []),
    labelledPrefix("installation", paths.installationRoot),
    labelledPrefix("home", paths.home),
  ]);
}

/** One-off form of {@link compilerMessageRelativizer}. */
export function relativizeCompilerMessage(text: string, root: string, paths: CompilerMessagePaths = {}): string {
  return compilerMessageRelativizer(root, paths)(text);
}

/**
 * CLA-605: the scan's package scope for semantic resolution, from discovery's
 * resolution (the same decisions container edges use).
 */
export interface TypeScriptWorkspaceScope {
  /** The scan root (repository-relative, `""` = whole repository): only tsconfigs under it are loaded. */
  base: string;
  /**
   * The package directory (repository-relative) a bare import from `fromFile` names,
   * `null` when the scan decided it resolves nowhere (ambiguous, vetoed, or defined
   * only by a package with no scanned source), or undefined for the compiler's own
   * third-party resolution.
   */
  resolve: (specifier: string, fromFile: string) => string | null | undefined;
  /** Package name -> repository-relative directory, for names declared exactly once in scope. */
  packages: ReadonlyMap<string, string>;
  /** Names declared by any in-scope package: never reported as third-party. */
  declared: ReadonlySet<string>;
}

/** Real project-aware compiler analysis; unresolved dependencies remain explicit limitations. */
export function analyzeTypeScript(sourceRoot: string, discoveredFiles?: readonly string[], installationRoot?: string, checkoutRoot?: string, workspace?: TypeScriptWorkspaceScope): LanguageAnalysis {
  const root = resolve(sourceRoot);
  const paths: string[] = [];
  const configs: string[] = [];
  // Without a scan scope (direct callers), every package.json in the tree: a name seen twice maps nowhere.
  const walkedPackages = new Map<string, string | undefined>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      if (entry.isDirectory()) {
        if (!["node_modules", ".git", "target", "dist", "build"].includes(entry.name)) walk(resolve(directory, entry.name));
      } else if (entry.isFile()) {
        const path = resolve(directory, entry.name);
        if (entry.name === "package.json") {
          try {
            const manifest = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
            if (typeof manifest.name === "string") walkedPackages.set(manifest.name, walkedPackages.has(manifest.name) ? undefined : directory);
          } catch { /* Config diagnostics report projects that cannot be loaded. */ }
        }
        if (/^(tsconfig|jsconfig)(\.[^.]+)*\.json$/.test(entry.name)) configs.push(path);
        if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)) paths.push(path);
      }
    }
  };
  walk(root);
  const packages = new Map<string, string>(workspace
    ? [...workspace.packages].map(([name, dir]) => [name, resolve(root, dir)] as const)
    : [...walkedPackages].flatMap(([name, dir]) => dir === undefined ? [] : [[name, dir] as const]));
  const declaredPackages: ReadonlySet<string> = workspace?.declared ?? new Set(walkedPackages.keys());
  const relativePath = (path: string): string => relative(root, path).split(sep).join("/");
  const inside = (path: string): boolean => {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const allowed = new Set((discoveredFiles ?? paths.map(relativePath)).filter(path => /\.[cm]?[jt]sx?$/.test(path)).map(path => resolve(root, path)));
  const relativize = compilerMessageRelativizer(root, { ...(checkoutRoot ? { checkoutRoot } : {}), workRoot: scanWorkDir(), ...(installationRoot ? { installationRoot } : {}), home: homedir() });
  const message = (diagnostic: TS.Diagnostic | TS.DiagnosticMessageChain): string => relativize(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  const result: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], coverage: [] };
  const limitations = new Set<string>();
  const indexed = new Set<string>();
  const definitions = new Map<string, AnalysisDefinition>();
  const references = new Map<string, LanguageAnalysis["references"][number]>();
  const modules = new Map<string, LanguageAnalysis["modules"][number]>();
  const externalReferences = new Map<string, AnalysisExternalReference>();
  const analyzer = `typescript@${ts.version}`;
  const projects = new Map<string, TS.ParsedCommandLine>();
  const loadConfig = (path: string): void => {
    if (projects.has(path)) return;
    const read = ts.readConfigFile(path, ts.sys.readFile);
    if (read.error) { limitations.add(`${relativePath(path)}: ${message(read.error)}`); return; }
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(path), undefined, path);
    projects.set(path, parsed);
    for (const diagnostic of parsed.errors) limitations.add(`${relativePath(path)}: ${message(diagnostic)}`);
    for (const reference of parsed.projectReferences ?? []) loadConfig(ts.resolveProjectReferencePath(reference));
  };
  // A4: only the scan root's own tsconfigs (a sibling root's project references never redirect in-scope files).
  const inScope = (path: string): boolean => !workspace?.base || relativePath(path).startsWith(`${workspace.base}/`);
  for (const config of configs) if (inScope(config)) loadConfig(config);
  // An isolated committed tree has no workspace symlinks or generated declarations.
  // Present workspace packages at their normal node_modules paths to the compiler,
  // and redirect configured declaration outputs to their matching source files.
  const sourceForOutput = new Map<string, string>();
  for (const project of projects.values()) {
    const outDir = project.options.declarationDir ?? project.options.outDir;
    const rootDir = project.options.rootDir;
    if (!outDir || !rootDir) continue;
    for (const source of project.fileNames) {
      const output = resolve(outDir, relative(rootDir, source)).replace(/\.[cm]?[jt]sx?$/, ".d.ts");
      sourceForOutput.set(output, source);
      sourceForOutput.set(output.replace(/\.d\.ts$/, ".js"), source);
    }
  }
  const outputDirectories = new Set<string>();
  for (const output of sourceForOutput.keys()) {
    for (let directory = dirname(output); inside(directory); directory = dirname(directory)) {
      outputDirectories.add(directory);
      if (directory === root) break;
    }
  }
  const virtualPath = (path: string, override?: { name: string; directory: string }): string => {
    const normalized = path.split(sep).join("/");
    const marker = normalized.lastIndexOf("/node_modules/");
    let mapped = path;
    if (marker >= 0) {
      const suffix = normalized.slice(marker + 14);
      const segments = suffix.split("/");
      const name = suffix.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]!;
      const directory = override?.name === name ? override.directory : packages.get(name);
      if (directory) mapped = resolve(directory, ...segments.slice(name.startsWith("@") ? 2 : 1));
    }
    return sourceForOutput.get(resolve(mapped)) ?? dependencies.path(mapped);
  };
  const covered = new Set([...projects.values()].flatMap(project => project.fileNames.map(path => resolve(path))));
  const uncovered = [...allowed].filter(path => !covered.has(path));
  if (uncovered.length) {
    limitations.add(`Inferred compiler configuration for ${uncovered.length} source file(s) outside configured projects.`);
    projects.set("<inferred>", { fileNames: uncovered, options: { allowJs: true, checkJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true }, errors: [] });
  }
  const dependencies = dependencyContext(root, installationRoot, [...projects.values()].map(project => dirname(ts.getDefaultLibFilePath(project.options))));
  if (dependencies.limitation) limitations.add(dependencies.limitation);
  const location = (node: TS.Node): AnalysisLocation => {
    const source = node.getSourceFile();
    const start = node.getStart(source);
    return { path: relativePath(source.fileName), startLine: source.getLineAndCharacterOfPosition(start).line + 1,
      endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1, startOffset: start, endOffset: node.getEnd() };
  };
  for (const [config, project] of projects) {
    if (!project.fileNames.some(path => allowed.has(resolve(path)))) continue;
    const host = ts.createCompilerHost(project.options);
    const originalReadFile = host.readFile;
    const originalFileExists = host.fileExists;
    const originalDirectoryExists = host.directoryExists;
    const originalGetSourceFile = host.getSourceFile;
    host.readFile = path => originalReadFile(virtualPath(path));
    host.fileExists = path => originalFileExists(virtualPath(path));
    host.directoryExists = path => originalDirectoryExists?.(virtualPath(path))
      || outputDirectories.has(virtualPath(path))
      || /(?:^|\/)node_modules(?:\/@[^/]+)?$/.test(path.split(sep).join("/"));
    host.realpath = path => virtualPath(path);
    host.getDirectories = path => ts.sys.getDirectories(virtualPath(path));
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      originalGetSourceFile(virtualPath(path), languageVersion, onError, shouldCreateNewSourceFile);
    // CLA-605: every bare import and type reference is decided for ITS importer (the
    // decision container edges use); the global name map above holds only unique names.
    const overrideHost = (override: { name: string; directory: string }): TS.ModuleResolutionHost => ({
      readFile: path => originalReadFile(virtualPath(path, override)),
      fileExists: path => originalFileExists(virtualPath(path, override)),
      directoryExists: path => originalDirectoryExists?.(virtualPath(path, override))
        || outputDirectories.has(virtualPath(path, override))
        || /(?:^|\/)node_modules(?:\/@[^/]+)?$/.test(path.split(sep).join("/")),
      realpath: path => virtualPath(path, override),
      getDirectories: path => ts.sys.getDirectories(virtualPath(path, override)),
    });
    /** The resolution host for `specifier` from `containingFile`, or null when it must not resolve. */
    const hostFor = (specifier: string, containingFile: string): { host: TS.ModuleResolutionHost; override?: { name: string; directory: string } } | null => {
      const decision = workspace && !specifier.startsWith(".") && !isAbsolute(specifier) && inside(containingFile) ? workspace.resolve(specifier, relativePath(containingFile)) : undefined;
      if (decision === null) return null;
      if (decision === undefined) return { host };
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
      const override = { name, directory: resolve(root, decision) };
      return { host: overrideHost(override), override };
    };
    // A resolved file is named by its real repository path, so later host IO (which
    // only knows unique names) and project-reference redirects stay in the chosen root.
    const canonicalFile = (fileName: string, override?: { name: string; directory: string }): string => override ? virtualPath(fileName, override) : fileName;
    host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options, containingSourceFile) => literals.map(literal => {
      const chosen = hostFor(literal.text, containingFile);
      if (!chosen) return { resolvedModule: undefined };
      const mode = ts.getModeForUsageLocation(containingSourceFile, literal, options);
      const resolved = ts.resolveModuleName(literal.text, containingFile, options, chosen.host, undefined, redirectedReference, mode);
      return resolved.resolvedModule && chosen.override
        ? { ...resolved, resolvedModule: { ...resolved.resolvedModule, resolvedFileName: canonicalFile(resolved.resolvedModule.resolvedFileName, chosen.override) } }
        : resolved;
    });
    host.resolveTypeReferenceDirectiveReferences = (references, containingFile, redirectedReference, options, containingSourceFile) => references.map(reference => {
      const name = typeof reference === "string" ? reference : reference.fileName;
      const chosen = hostFor(name, containingFile);
      if (!chosen) return { resolvedTypeReferenceDirective: undefined };
      // Exactly the compiler's own loader (typescript's internal default-mode helper).
      const defaultMode = containingSourceFile ? (ts as unknown as { getDefaultResolutionModeForFileWorker(file: TS.SourceFile, options: TS.CompilerOptions): TS.ResolutionMode }).getDefaultResolutionModeForFileWorker(containingSourceFile, options) : undefined;
      const mode = ts.getModeForFileReference(reference, defaultMode);
      const resolved = ts.resolveTypeReferenceDirective(name, containingFile, options, chosen.host, redirectedReference, undefined, mode);
      const directive = resolved.resolvedTypeReferenceDirective;
      return directive?.resolvedFileName && chosen.override
        ? { ...resolved, resolvedTypeReferenceDirective: { ...directive, resolvedFileName: canonicalFile(directive.resolvedFileName, chosen.override) } }
        : resolved;
    });
    // Permit source redirects through project references without requiring emitted .d.ts files.
    (host as TS.CompilerHost & { useSourceOfProjectReferenceRedirect?: () => boolean }).useSourceOfProjectReferenceRedirect = () => true;
    const program = ts.createProgram({ rootNames: project.fileNames, options: project.options, host,
      ...(project.projectReferences ? { projectReferences: project.projectReferences } : {}) });
    const checker = program.getTypeChecker();
    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const prefix = diagnostic.file && inside(diagnostic.file.fileName) ? relativePath(diagnostic.file.fileName) : config === "<inferred>" ? config : relativePath(config);
      limitations.add(`${prefix}: TS${diagnostic.code}: ${message(diagnostic)}`);
    }
    const targetDefinition = (symbol: TS.Symbol | undefined): AnalysisDefinition | undefined => {
      if (!symbol) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const candidates = (symbol.declarations ?? []).filter(declaration => allowed.has(resolve(declaration.getSourceFile().fileName)));
      // Prefer the implementation over overload declarations.
      const declaration = candidates.find(candidate => ts.isFunctionDeclaration(candidate) && candidate.body) ?? candidates[0];
      if (!declaration) return undefined;
      const source = declaration.getSourceFile();
      const symbolId = `${relativePath(source.fileName)}@${declaration.getStart(source)}`;
      const definition = { ...location(declaration), symbol: symbolId, name: symbol.getName() };
      definitions.set(symbolId, definition);
      return definition;
    };
    // Third-party symbols: every declaration in ONE node_modules package (never the
    // compiler's default lib, never a workspace package, never Node's own @types/node).
    const externalPackage = (symbol: TS.Symbol): { package: string; via?: string } | undefined => {
      // Namespace/module qualifiers (`ts` in `ts.Node`) are not references; their members are.
      if (symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule)) return undefined;
      const declarations = symbol.declarations ?? [];
      let owner: string | undefined;
      for (const declaration of declarations) {
        const file = declaration.getSourceFile();
        if (program.isSourceFileDefaultLibrary(file)) return undefined;
        const name = nodeModulesPackageOf(file.fileName);
        if (!name || (owner && owner !== name)) return undefined;
        owner = name;
      }
      if (!owner || owner === "@types/node") return undefined;
      const typed = typedPackageOf(owner);
      if (declaredPackages.has(owner) || (typed && declaredPackages.has(typed))) return undefined;
      return typed ? { package: typed, via: owner } : { package: owner };
    };
    // `<div className=…>` resolves into React's JSX typings; that is markup, not API use.
    const jsxTypingOnly = (node: TS.Node): boolean => {
      const parent = node.parent;
      if (ts.isJsxAttribute(parent) && parent.name === node) return true;
      return (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent))
        && parent.tagName === node && ts.isIdentifier(node) && /^[a-z]/.test(node.text);
    };
    const displayName = (symbol: TS.Symbol): string => {
      // Anonymous object/type literals print as `__type` / `__object`; drop those segments.
      const qualified = checker.getFullyQualifiedName(symbol).replace(/^"[^"]*"\./, "").split(".").filter(part => part !== "__type" && part !== "__object").join(".");
      return qualified && !/["\\/]/.test(qualified) ? qualified : symbol.getName();
    };
    for (const source of program.getSourceFiles()) {
      if (!allowed.has(resolve(source.fileName))) continue;
      indexed.add(relativePath(source.fileName));
      const visit = (node: TS.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const moduleSymbol = checker.getSymbolAtLocation(node.moduleSpecifier);
          const target = moduleSymbol?.declarations?.find(ts.isSourceFile);
          if (target && allowed.has(resolve(target.fileName))) {
            const occurrence = { ...location(node.moduleSpecifier), targetPath: relativePath(target.fileName) };
            modules.set(`${occurrence.path}:${occurrence.startOffset}:${occurrence.targetPath}`, occurrence);
          }
        }
        if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
          const parent = node.parent;
          const named = parent as TS.Node & { name?: TS.Node };
          const declarationName = named.name === node && !ts.isPropertyAccessExpression(parent)
            && !ts.isShorthandPropertyAssignment(parent) && !ts.isQualifiedName(parent);
          const importExport = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent);
          if (!declarationName && !importExport) {
            let symbol = ts.isShorthandPropertyAssignment(parent)
              ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
            const aliasSymbol = symbol && symbol.flags & ts.SymbolFlags.Alias ? symbol : undefined;
            if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            let expression: TS.Node = node;
            if (ts.isPropertyAccessExpression(parent) && parent.name === node) expression = parent;
            while (ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent)
              || ts.isAsExpression(expression.parent) || ts.isSatisfiesExpression(expression.parent)) expression = expression.parent;
            const call = expression.parent;
            const callPosition = (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === expression;
            let definiteCall = callPosition;
            if (callPosition && symbol) {
              const declarations = symbol.declarations ?? [];
              const implementation = declarations.filter(declaration =>
                ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && !!declaration.body)
                || ts.isClassDeclaration(declaration)
                || ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration) || ts.isPropertyAssignment(declaration))
                  && !!declaration.initializer && (ts.isArrowFunction(declaration.initializer)
                    || ts.isFunctionExpression(declaration.initializer) || ts.isClassExpression(declaration.initializer))));
              definiteCall = implementation.length === 1 && (declarations.length === 1
                || declarations.every(declaration => ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)));
              if (!definiteCall && declarations.some(declaration => allowed.has(resolve(declaration.getSourceFile().fileName)))) {
                limitations.add(`${relativePath(source.fileName)}:${location(node).startLine}: Ambiguous or dynamic call dispatch at ${expression.getText(source)}; no definite callee emitted.`);
                // A synthetic union symbol can contain unrelated method declarations.
                // Picking the first would misrepresent even a generic reference.
                if (declarations.length > 1) symbol = undefined;
              }
            }
            const target = targetDefinition(symbol);
            if (target) {
              const kind = definiteCall ? "calls" : "uses";
              const occurrence = { ...location(node), symbol: target.symbol, kind } as LanguageAnalysis["references"][number];
              references.set(`${occurrence.path}:${occurrence.startOffset}:${target.symbol}:${kind}`, occurrence);
            } else if (symbol && !jsxTypingOnly(node)) {
              const external = externalPackage(symbol);
              if (external) {
                // A call into the dependency's API surface; overloads/unions stay one dependency.
                // Compile-time only: a type position (incl. `typeof x` inside a type) or a binding from
                // `import type`. A value-position read (`req.query`, `useRef(1).current`) touches a
                // runtime object even when its shape is declared by an interface, so it stays runtime.
                const typeOnly = ts.isPartOfTypeNode(node)
                  || !!ts.findAncestor(node.parent, ancestor => ts.isTypeQueryNode(ancestor) || (ts.isTypeNode(ancestor) && ts.isPartOfTypeNode(ancestor)))
                  || !!aliasSymbol?.declarations?.some(declaration => ts.isTypeOnlyImportOrExportDeclaration(declaration));
                const occurrence: AnalysisExternalReference = { ...location(node), ecosystem: "npm", ...external,
                  symbol: displayName(symbol), kind: callPosition && !typeOnly ? "calls" : "uses", typeOnly, analyzer };
                externalReferences.set(`${occurrence.path}:${occurrence.startOffset}:${occurrence.package}:${occurrence.symbol}:${occurrence.kind}:${typeOnly}`, occurrence);
              }
            }
          } else if (declarationName && !importExport) targetDefinition(checker.getSymbolAtLocation(node));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const canonical = <T>(items: T[]): T[] => items.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  result.definitions = canonical([...definitions.values()]);
  result.references = canonical([...references.values()]);
  result.modules = canonical([...modules.values()]);
  result.externalReferences = canonical([...externalReferences.values()]);
  const missed = [...allowed].filter(path => !indexed.has(relativePath(path)));
  if (missed.length) limitations.add(`Not indexed: ${missed.map(relativePath).sort().join(", ")}`);
  for (const language of ["typescript", "javascript"]) {
    const languageFiles = [...allowed].map(relativePath).filter(path => language === "typescript" ? /\.[cm]?tsx?$/.test(path) : /\.[cm]?jsx?$/.test(path));
    if (!languageFiles.length) continue;
    const indexedFiles = languageFiles.filter(path => indexed.has(path)).sort();
    result.coverage.push({ language, tool: "typescript", version: ts.version, coverage: indexedFiles.length ? "semantic" : "unavailable", indexedFiles, limitations: [...limitations].sort() });
  }
  return result;
}
