import ts from "typescript";
import {
  ARCHITECTURE_EXTRACTION_LIMITS,
  CYCLOMATIC_FLAG_THRESHOLD,
  type ArchitectureExtraction,
  type ArchitectureExtractionEntity,
  type ArchitectureExtractionEntityKind,
  type ArchitectureExtractionEvidence,
  type ArchitectureExtractionRelation,
  type ArchitectureExtractionSourceRef,
  type ArchitectureSnapshot,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import type { AnalysisLocation, LanguageAnalysis } from "./language-analysis.js";
import { pathSlug, resolveCollisions, slug, typedId, unboundedTypedId } from "./ids.js";
import { rustTopLevelItems } from "./extract-rust.js";

/** Max import sites retained as evidence on one aggregated relation. */
const MAX_EVIDENCE_PER_RELATION = 24;

/**
 * How many L1 `externalSystem` entities the deterministic scan emits — the top-N
 * most-imported **service-boundary** runtime dependencies (APIs/platforms), never
 * UI/framework/utility libraries (CLA-97). Kept small so the context band stays
 * legible (the hand-authored golden fixture carries ~3 context nodes). Selection
 * is deterministic by (import-site count desc, package name asc) among packages
 * that pass {@link isL1ExternalSystemPackage}. Bumping this only widens L1.
 */
export const MAX_EXTERNAL_SYSTEMS = 8;

/** Cap on evidence anchors carried by one externalSystem entity (declaration + import sites). */
const MAX_EXTERNAL_SOURCE_REFS = 12;

/**
 * Honest language tags from observed source (CLA-102). `.tsx` is TypeScript, not a
 * React claim. Order is the inspector display order before `adapt` sorts.
 */
export const OBSERVED_LANGUAGE_TAGS = ["TypeScript", "JavaScript", "Rust"] as const;
export type ObservedLanguageTag = (typeof OBSERVED_LANGUAGE_TAGS)[number];

const OBSERVED_LANGUAGE_TAG_SET: ReadonlySet<string> = new Set(OBSERVED_LANGUAGE_TAGS);

export function isObservedLanguageTag(value: string): value is ObservedLanguageTag {
  return OBSERVED_LANGUAGE_TAG_SET.has(value);
}

/** Language tag for a scanned path. Unsupported extensions stay untagged. */
export function languageTagForScanPath(path: string): ObservedLanguageTag | undefined {
  if (/\.(tsx|ts|mts|cts)$/.test(path)) return "TypeScript";
  if (/\.(jsx|js|mjs|cjs)$/.test(path)) return "JavaScript";
  if (path.endsWith(".rs")) return "Rust";
  return undefined;
}

/** Languages first (canonical order), then other tags (CLA-97 libraries), capped. */
export function mergeObservedLanguageTechnology(
  languages: readonly string[],
  other: readonly string[] | undefined,
): string[] | undefined {
  const orderedLanguages = OBSERVED_LANGUAGE_TAGS.filter(tag => languages.includes(tag));
  const rest = (other ?? []).filter(name => !OBSERVED_LANGUAGE_TAG_SET.has(name));
  const merged = [...orderedLanguages, ...rest].slice(0, ARCHITECTURE_EXTRACTION_LIMITS.maxListItems);
  return merged.length ? merged : undefined;
}

export interface TopLevelDeclaration {
  name: string;
  startLine: number;
  endLine: number;
  /** Exported from its module (direct modifier, `export {…}` list, `export default`/`export =`). */
  exported: boolean;
  /** The declaring statement/declarator — the subtree symbol references are walked in. */
  node: ts.Node;
}

export interface ModuleImport {
  specifier: string;
  startLine: number;
  endLine: number;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS; // .ts, .mts, .cts
}

export function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

/** Local names exported indirectly: `export { a, b as c }` (no specifier), `export default x`, `export = x`. */
function indirectlyExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

/**
 * Every top-level named declaration — exported OR not. Non-exported top-level
 * symbols matter: e.g. `CanvasViewport` in App.tsx is a local function yet a
 * pinned golden anchor, so an exports-only walk would under-report. Each
 * declaration carries `exported` so a public-API scan (`codeSurface: 'public'`)
 * can keep only the module's export surface.
 */
export function topLevelDeclarations(sourceFile: ts.SourceFile): TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  const indirect = indirectlyExportedNames(sourceFile);
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const push = (name: string, node: ts.Node, direct: boolean): void => {
    declarations.push({
      name,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
      exported: direct || indirect.has(name),
      node,
    });
  };
  for (const statement of sourceFile.statements) {
    const direct = hasExportModifier(statement);
    if (ts.isFunctionDeclaration(statement) && statement.name) push(statement.name.text, statement, direct);
    else if (ts.isClassDeclaration(statement) && statement.name) push(statement.name.text, statement, direct);
    else if (ts.isInterfaceDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isTypeAliasDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isEnumDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) push(statement.name.text, statement, direct);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) push(declaration.name.text, declaration, direct);
      }
    }
  }
  return declarations;
}

/** Local import name → the module export it binds. */
export interface NamedImportBinding {
  specifier: string;
  exportedName: string;
  namespace?: boolean;
}

/**
 * Import bindings with a syntactically known export identity. Namespace members are
 * resolved only for direct property access (`ns.symbol`), never computed access.
 */
export function namedImportBindings(sourceFile: ts.SourceFile): Map<string, NamedImportBinding> {
  const bindings = new Map<string, NamedImportBinding>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) {
      bindings.set(clause.name.text, { specifier: statement.moduleSpecifier.text, exportedName: "default" });
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bindings.set(clause.namedBindings.name.text, {
        specifier: statement.moduleSpecifier.text,
        exportedName: "*",
        namespace: true,
      });
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          specifier: statement.moduleSpecifier.text,
          exportedName: (element.propertyName ?? element.name).text,
        });
      }
    }
  }
  return bindings;
}

/** True when this identifier occurrence NAMES a declaration/member rather than referencing a value or type. */
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  // Anything that "declares" this identifier: functions, classes, variables,
  // parameters, members, enum members, binding elements, type members…
  // (Shorthand properties `{ compareText }` are deliberately NOT here — they read.)
  const declares = (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
    || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)
    || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)
    || ts.isEnumDeclaration(parent) || ts.isEnumMember(parent) || ts.isModuleDeclaration(parent)
    || ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
    || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
    || ts.isTypeParameterDeclaration(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent));
  return declares && (parent as { name?: ts.Node }).name === node;
}

export interface SymbolReference {
  name: string;
  line: number;
  kind: "uses" | "calls";
  member?: string;
}

function hasBindingName(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    return node.elements.some(element => ts.isBindingElement(element) && hasBindingName(element.name, name));
  }
  return false;
}

function functionHasVarBinding(scope: ts.SignatureDeclaration, name: string): boolean {
  const visit = (current: ts.Node): boolean => {
    if (current !== scope && ts.isFunctionLike(current)) return false;
    if (ts.isVariableDeclaration(current) && ts.isVariableDeclarationList(current.parent)
      && (current.parent.flags & ts.NodeFlags.BlockScoped) === 0 && hasBindingName(current.name, name)) return true;
    return ts.forEachChild(current, visit) === true;
  };
  return visit(scope);
}

/** True when a nested lexical binding hides a top-level/import candidate. */
function isLexicallyShadowed(node: ts.Identifier, boundary: ts.Node): boolean {
  const name = node.text;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && (current.parameters.some(parameter => hasBindingName(parameter.name, name))
      || functionHasVarBinding(current, name))) return true;
    if ((ts.isFunctionExpression(current) || ts.isClassExpression(current)) && current.name?.text === name) return true;
    if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current))
      && current.initializer && ts.isVariableDeclarationList(current.initializer)
      && current.initializer.declarations.some(declaration => hasBindingName(declaration.name, name))) return true;
    if (ts.isCatchClause(current) && current.variableDeclaration && hasBindingName(current.variableDeclaration.name, name)) return true;
    if (ts.isBlock(current) || ts.isCaseBlock(current)) {
      const statements = ts.isCaseBlock(current) ? current.clauses.flatMap(clause => [...clause.statements]) : current.statements;
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some(declaration => hasBindingName(declaration.name, name))) return true;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement))
          && statement.name?.text === name) return true;
      }
    }
    if (current === boundary) break;
  }
  return false;
}

function isTypeOnlyReference(node: ts.Identifier, boundary: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current)) return true;
    if (current === boundary) break;
  }
  return false;
}

function isDirectCallExpression(node: ts.Expression): boolean {
  const parent = node.parent;
  return ts.isCallExpression(parent) && parent.expression === node;
}

/**
 * Identifier references inside one top-level declaration whose names are in
 * `candidates`. Calls are emitted only when the matched expression is directly in
 * call position; all other proven references remain generic `uses` evidence.
 */
export function symbolReferencesIn(
  sourceFile: ts.SourceFile,
  declaration: TopLevelDeclaration,
  candidates: ReadonlySet<string>,
  namespaceCandidates: ReadonlySet<string> = new Set(),
): SymbolReference[] {
  const references: SymbolReference[] = [];
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
      && namespaceCandidates.has(node.expression.text) && !isLexicallyShadowed(node.expression, declaration.node)) {
      references.push({
        name: node.expression.text,
        member: node.name.text,
        line: lineOf(node.getStart(sourceFile)),
        kind: isDirectCallExpression(node) ? "calls" : "uses",
      });
      ts.forEachChild(node, child => {
        if (child !== node.expression && child !== node.name) visit(child);
      });
      return;
    }
    if (ts.isIdentifier(node) && candidates.has(node.text) && !isDeclarationName(node)
      && !isLexicallyShadowed(node, declaration.node) && !isTypeOnlyReference(node, declaration.node)) {
      references.push({
        name: node.text,
        line: lineOf(node.getStart(sourceFile)),
        kind: isDirectCallExpression(node) ? "calls" : "uses",
      });
    }
    ts.forEachChild(node, visit);
  };
  // Walk the declaration body, skipping its own name identifier via isDeclarationName.
  visit(declaration.node);
  return references;
}

/**
 * Product flag: Complexity Kink ~6.5. Functions with McCabe cyclomatic
 * `complexity > 6` are flagged. McCabe 10 is the human-era lint bar only.
 */
export { CYCLOMATIC_FLAG_THRESHOLD };

function isLogicalDecisionOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken
    || kind === ts.SyntaxKind.BarBarToken
    || kind === ts.SyntaxKind.QuestionQuestionToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

/**
 * Classic McCabe: 1 + decision points in this function's own CFG.
 * Nested functions, methods, and classes have separate graphs and are skipped
 * (they are not L4 nodes yet; their complexity is omitted rather than folded in).
 * Type-level conditionals (`T extends U ? A : B`) are not runtime branches.
 */
function isNestedFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isClassDeclaration(node)
    || ts.isClassExpression(node);
}

export function cyclomaticComplexity(node: ts.Node): number {
  let complexity = 1;
  const visit = (current: ts.Node): void => {
    if (ts.isIfStatement(current)
      || ts.isWhileStatement(current)
      || ts.isDoStatement(current)
      || ts.isForStatement(current)
      || ts.isForInStatement(current)
      || ts.isForOfStatement(current)
      || ts.isCatchClause(current)
      || ts.isConditionalExpression(current)
      || ts.isCaseClause(current)) {
      complexity += 1;
    } else if (ts.isBinaryExpression(current) && isLogicalDecisionOperator(current.operatorToken.kind)) {
      complexity += 1;
    }
    ts.forEachChild(current, child => {
      if (child !== node && isNestedFunctionBoundary(child)) return;
      visit(child);
    });
  };
  visit(node);
  return complexity;
}

/** The executable function AST to score, or undefined for types/classes/constants/bodyless decls. */
export function functionLikeBody(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node)) return node.body ? node : undefined;
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer
    && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) {
    return node.initializer;
  }
  return undefined;
}

/** McCabe for one existing L4 declaration. Omitted when the entity is not function-like. */
export function cyclomaticForDeclaration(declaration: TopLevelDeclaration): number | undefined {
  const body = functionLikeBody(declaration.node);
  return body ? cyclomaticComplexity(body) : undefined;
}

export function cyclomaticIsFlagged(complexity: number): boolean {
  return complexity > CYCLOMATIC_FLAG_THRESHOLD;
}

/**
 * Minimum identifier-normalized tokens before two function-like bodies can be a
 * clone pair. Keeps `return 1` / empty arrows from matching every trivial helper.
 */
export const MIN_CLONE_TOKENS = 20;

function isNormalizedCloneIdentifier(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier;
}

function isNormalizedCloneLiteral(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.NumericLiteral
    || kind === ts.SyntaxKind.BigIntLiteral
    || kind === ts.SyntaxKind.StringLiteral
    || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    || kind === ts.SyntaxKind.RegularExpressionLiteral
    || kind === ts.SyntaxKind.TemplateHead
    || kind === ts.SyntaxKind.TemplateMiddle
    || kind === ts.SyntaxKind.TemplateTail;
}

/** Identifier-normalized token stream of a function-like body (Type-2). */
export function cloneTokenSequence(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  const tokens: string[] = [];
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  if (end <= start) return tokens;
  const scanner = ts.createScanner(
    sourceFile.languageVersion,
    true,
    sourceFile.languageVariant,
    sourceFile.text,
    undefined,
    start,
    end - start,
  );
  while (true) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (scanner.getTokenPos() >= end) break;
    if (isNormalizedCloneIdentifier(kind)) tokens.push("I");
    else if (isNormalizedCloneLiteral(kind)) tokens.push("L");
    else tokens.push(String(kind));
  }
  return tokens;
}

/** Structural AST kind sequence of a function-like body. */
export function cloneAstSequence(node: ts.Node): number[] {
  const kinds: number[] = [];
  const visit = (current: ts.Node): void => {
    kinds.push(current.kind);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return kinds;
}

/**
 * Token + AST fingerprint for one existing L4 declaration. Omitted when the
 * entity is not function-like or the body is below `MIN_CLONE_TOKENS`.
 */
export function cloneFingerprintForDeclaration(declaration: TopLevelDeclaration): string | undefined {
  const body = functionLikeBody(declaration.node);
  if (!body) return undefined;
  const sourceFile = declaration.node.getSourceFile();
  const tokens = cloneTokenSequence(body, sourceFile);
  if (tokens.length < MIN_CLONE_TOKENS) return undefined;
  return `${tokens.join(" ")}\n${cloneAstSequence(body).join(",")}`;
}

export interface ClonePair {
  from: string;
  to: string;
}

function clonePairsFromBuckets(buckets: ReadonlyMap<string, readonly string[]>): ClonePair[] {
  const pairs: ClonePair[] = [];
  for (const ids of buckets.values()) {
    if (ids.length < 2) continue;
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        pairs.push({ from: sorted[i]!, to: sorted[j]! });
      }
    }
  }
  return pairs.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

/** Static `import ... from` and `export ... from` module specifiers with line spans. */
export function moduleImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  for (const statement of sourceFile.statements) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement)) specifier = statement.moduleSpecifier;
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) {
      imports.push({
        specifier: specifier.text,
        startLine: lineOf(statement.getStart(sourceFile)),
        endLine: lineOf(statement.getEnd()),
      });
    }
  }
  return imports;
}

/**
 * Dynamic `import('…')` specifiers (string-literal argument) found anywhere in the
 * module — code-split routes and lazily-loaded entrypoints. These are real, observed
 * module dependencies the static `import … from` pass misses: e.g. the web shell
 * reaches its landing screen and app root ONLY through `await import('./scanLanding')`
 * / `await import('./App')`, so without this those targets render as false islands.
 * Returned in source order; folded into the same relation pass as static imports, so
 * a target imported both ways just unions its evidence.
 *
 * Deliberately excluded (no syntactic module identity): type-level `import('…')`
 * (an `ImportTypeNode`, not a call) and computed/non-literal specifiers.
 */
export function dynamicImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
      && ts.isStringLiteralLike(node.arguments[0]!)) {
      imports.push({
        specifier: node.arguments[0]!.text,
        startLine: lineOf(node.getStart(sourceFile)),
        endLine: lineOf(node.getEnd()),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function normalizeRepoPath(baseDir: string, relative: string): string {
  const parts = (baseDir ? baseDir.split("/") : []).concat(relative.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function relativeCandidates(base: string): string[] {
  const out: string[] = [];
  const add = (candidate: string): void => { if (!out.includes(candidate)) out.push(candidate); };
  const extMatch = /\.(js|jsx|mjs|cjs|ts|tsx)$/.exec(base);
  if (extMatch) {
    const stem = base.slice(0, base.length - extMatch[0].length);
    add(`${stem}.ts`);
    add(`${stem}.tsx`);
    add(`${stem}.mjs`);
    add(base);
  } else {
    add(`${base}.ts`);
    add(`${base}.tsx`);
    add(`${base}.mjs`);
    add(`${base}/index.ts`);
    add(`${base}/index.tsx`);
    // Extensionless imports of JS modules (`export * from './index'` -> index.js),
    // tried after every TS candidate so an existing TS resolution never changes.
    add(`${base}.js`);
    add(`${base}.jsx`);
    add(`${base}.cjs`);
    add(`${base}/index.js`);
    add(`${base}/index.jsx`);
    add(`${base}/index.mjs`);
  }
  return out;
}

/** Resolves a relative specifier to a discovered source file, or undefined. */
export function resolveRelativeImport(fromFile: string, specifier: string, fileSet: ReadonlySet<string>): string | undefined {
  const baseDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const base = normalizeRepoPath(baseDir, specifier);
  return relativeCandidates(base).find(candidate => fileSet.has(candidate));
}

/**
 * Maps a relative specifier that escapes the discovered file set onto the unit
 * whose directory contains it — the cross-boundary import case, e.g. the web
 * shell importing the generated WASM pkg (`../../../../crates/atlas-wasm/pkg/…`).
 * The file itself is generated/undiscovered, but the OWNING unit is a container,
 * so the dependency is still an observable container→container fact.
 */
export function resolveRelativeUnitImport(
  fromFile: string,
  specifier: string,
  unitDirs: readonly string[],
): string | undefined {
  const baseDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const target = normalizeRepoPath(baseDir, specifier);
  return [...unitDirs]
    .filter(dir => dir.length > 0 && (target === dir || target.startsWith(`${dir}/`)))
    .sort((left, right) => right.length - left.length)[0];
}

export interface CargoPathDependency {
  name: string;
  /** The dependency's `path` value, as written (relative to the crate dir). */
  path: string;
  /** 1-based line of the declaration (evidence anchor). */
  line: number;
}

/**
 * `path = "…"` dependencies from a Cargo manifest — the deterministic edge source
 * for otherwise-opaque Rust crates (R1 parses no .rs, but the workspace wiring is
 * right there in Cargo.toml). Covers `[dependencies]` and target-scoped
 * `[target.….dependencies]` sections — inline-table form and `[dependencies.name]`
 * subsections — and ignores dev/build dependency sections.
 */
export function cargoPathDependencies(manifestText: string): CargoPathDependency[] {
  const dependencies: CargoPathDependency[] = [];
  const lines = manifestText.split(/\r?\n/);
  let inDependencySection = false;
  let subsectionName: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      const section = header[1]!;
      const isDependencies = /(^|\.)dependencies(\.|$)/.test(section)
        && !/dev-dependencies|build-dependencies/.test(section);
      inDependencySection = isDependencies;
      const subsection = /(?:^|\.)dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      subsectionName = isDependencies && subsection ? subsection[1] : undefined;
      continue;
    }
    if (!inDependencySection) continue;
    if (subsectionName) {
      const pathValue = /^\s*path\s*=\s*"([^"]+)"/.exec(line);
      if (pathValue) dependencies.push({ name: subsectionName, path: pathValue[1]!, line: index + 1 });
      continue;
    }
    const inline = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(line);
    if (inline) dependencies.push({ name: inline[1]!, path: inline[2]!, line: index + 1 });
  }
  return dependencies;
}

/** Maps a bare `@okie/*` specifier to the owning workspace-member unit dir, or undefined. */
export function resolvePackageImport(specifier: string, unitByPackageName: ReadonlyMap<string, string>): string | undefined {
  for (const [name, dir] of unitByPackageName) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return dir;
  }
  return undefined;
}

/**
 * The npm package name a bare specifier belongs to: `react` and `react-dom/client` map to
 * `react`/`react-dom`; `@scope/pkg/sub` collapses to `@scope/pkg`. Relative specifiers and
 * anything without a name return undefined. Node builtins (`node:fs`, `fs`) fall out later —
 * they are never declared as runtime dependencies, so the allowlist filter drops them.
 */
export function packageNameOfSpecifier(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".")) return undefined;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }
  const slash = specifier.indexOf("/");
  const name = slash === -1 ? specifier : specifier.slice(0, slash);
  return name || undefined;
}

/**
 * npm scopes that are UI kits, fonts, compilers, or other implementation libraries —
 * never L1 External Systems (CLA-97).
 */
const L1_LIBRARY_SCOPES = new Set([
  "@babel",
  "@emotion",
  "@fontsource",
  "@fontsource-variable",
  "@mui",
  "@radix-ui",
  "@types",
  "@vitejs",
]);

/**
 * Well-known UI/framework/utility packages named in CLA-97 plus the usual
 * compilers and class-name helpers. Default-exclude (below) also drops unknown
 * libraries; this set documents the locked product examples.
 */
const L1_LIBRARY_PACKAGES = new Set([
  "clsx",
  "classnames",
  "dompurify",
  "esbuild",
  "isomorphic-dompurify",
  "lodash",
  "mermaid",
  "preact",
  "react",
  "react-dom",
  "rollup",
  "solid-js",
  "svelte",
  "typescript",
  "vite",
  "vue",
  "webpack",
  "zod",
]);

/** Cloud/API/database platforms that are meaningful L1 service boundaries. */
const L1_SERVICE_SCOPES = new Set([
  "@anthropic-ai",
  "@aws-sdk",
  "@azure",
  "@datadog",
  "@google-cloud",
  "@octokit",
  "@sentry",
  "@slack",
  "@supabase",
]);

const L1_SERVICE_PACKAGES = new Set([
  "aws-sdk",
  "cassandra-driver",
  "firebase",
  "googleapis",
  "ioredis",
  "mongodb",
  "mongoose",
  "mysql",
  "mysql2",
  "neo4j-driver",
  "openai",
  "pg",
  "postgres",
  "posthog-js",
  "posthog-node",
  "redis",
  "stripe",
  "twilio",
  "@elastic/elasticsearch",
]);

function packageScope(packageName: string): string | undefined {
  if (!packageName.startsWith("@")) return undefined;
  const slash = packageName.indexOf("/");
  return slash === -1 ? packageName : packageName.slice(0, slash);
}

/**
 * True when a declared runtime dependency is a **service boundary** (another
 * system/API/platform the software talks to) and therefore belongs on L1 as an
 * `externalSystem`. UI frameworks, fonts, compilers, bundlers, and utility libs
 * return false — they stay reachable as container `technology` and import
 * evidence, not as L1 cards (CLA-97). Unknown npm packages default to false:
 * most `dependencies` entries are implementation libraries.
 */
export function isL1ExternalSystemPackage(packageName: string): boolean {
  const scope = packageScope(packageName);
  const unscoped = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  if (scope && L1_LIBRARY_SCOPES.has(scope)) return false;
  if (L1_LIBRARY_PACKAGES.has(packageName) || L1_LIBRARY_PACKAGES.has(unscoped)) return false;
  if (unscoped.startsWith("react-") || unscoped.startsWith("lodash.")) return false;
  if (scope && L1_SERVICE_SCOPES.has(scope)) return true;
  if (L1_SERVICE_PACKAGES.has(packageName) || L1_SERVICE_PACKAGES.has(unscoped)) return true;
  // `@org/foo-sdk`, `foo-sdk`, `foo-api-client`.
  if (/(?:^|\/|-)sdk$/i.test(packageName) || /(?:^|\/)sdk(?:-|$)/i.test(unscoped)) return true;
  if (/-api-client$/.test(unscoped)) return true;
  return false;
}

/**
 * 1-based line numbers of each key inside a package.json `"dependencies"` object (best-effort
 * evidence anchoring; membership itself comes from JSON.parse). Scans only within the
 * dependencies block via brace depth so a name that also appears under devDependencies is not
 * mis-anchored. Keys absent from the map simply anchor the manifest path with no line.
 */
export function runtimeDependencyLines(manifestText: string): Map<string, number> {
  const lines = manifestText.split(/\r?\n/);
  const result = new Map<string, number>();
  let inside = false;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const startsHere = !inside && /^\s*"dependencies"\s*:\s*\{/.test(line);
    if (startsHere) inside = true;
    if (!inside) continue;
    for (const character of line) {
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (!startsHere) {
      const match = /^\s*"([^"]+)"\s*:/.exec(line);
      if (match) result.set(match[1]!, index + 1);
    }
    if (depth <= 0) inside = false;
  }
  return result;
}

interface EntityDescriptor {
  naturalKey: string;
  desiredId: string;
  kind: ArchitectureExtractionEntityKind;
  name: string;
  parentKey?: string;
  sourceRefs: ArchitectureExtractionSourceRef[];
  /**
   * Observed language tags (CLA-102) plus dropped runtime libraries (CLA-97).
   * Inspector/detail — not L1 cards.
   */
  technology?: string[];
  exposure?: Array<{ kind: "moduleExport" | "publicApi" | "entryPoint"; evidence: ArchitectureExtractionEvidence }>;
  /** Observed McCabe for function-like code entities — snapshot overlay, not extraction. */
  cyclomaticComplexity?: number;
  /** Token+AST clone fingerprint for function-like code entities — snapshot overlay. */
  cloneFingerprint?: string;
}

interface RelationDescriptor {
  naturalKey: string;
  desiredId: string;
  fromKey: string;
  toKey: string;
  kind?: "uses" | "calls";
  evidence: ArchitectureExtractionEvidence[];
}

/**
 * One bounded, pattern-legal relation-id group for a (path, symbol) pair. Ids are
 * length-capped by the extraction gate; two full path slugs would overflow it, so
 * the group keeps the TAIL of `<pathSlug>-<nameSlug>` — the basename + symbol end,
 * the most distinctive part. Collisions are handled by resolveCollisions as usual.
 */
function symbolRelationGroup(path: string, name: string): string {
  const combined = `${pathSlug(path)}-${slug(name)}`;
  const bounded = combined.length > 72 ? combined.slice(combined.length - 72) : combined;
  return bounded.replace(/^-+|-+$/g, "") || "x";
}

export interface ExtractInput {
  /** Semantic facts resolved against the same committed source tree. */
  languageAnalysis?: LanguageAnalysis;
  discovery: Discovery;
  readFile: (repoRelativePath: string) => string;
  systemName?: string;
  systemSlug?: string;
  /**
   * Which top-level declarations become L4 code entities. 'all' (default) keeps every
   * top-level declaration — required for the Okie self-scan's golden-anchor coverage.
   * 'public' keeps only the module's export surface: the readable public API of the
   * repo, with private helpers left to the file card (`okie-scan --public-api`).
   * Hosted `/new` uses the CLI default (`all`).
   */
  codeSurface?: "all" | "public";
}

function finalizeEvidence(evidence: readonly ArchitectureExtractionEvidence[]): ArchitectureExtractionEvidence[] {
  const byKey = new Map<string, ArchitectureExtractionEvidence>();
  for (const item of evidence) {
    const source = item.source;
    const key = `${source.path}::${source.startLine ?? ""}::${source.endLine ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((left, right) =>
      left.source.path.localeCompare(right.source.path) || (left.source.startLine ?? 0) - (right.source.startLine ?? 0))
    .slice(0, MAX_EVIDENCE_PER_RELATION);
}

interface ExternalEmitInput {
  discovery: Discovery;
  readFile: (repoRelativePath: string) => string;
  externalUsagesByPackage: ReadonlyMap<string, Array<{ container: string; source: ArchitectureExtractionSourceRef }>>;
  entityDescriptors: EntityDescriptor[];
  addRelation: (fromKey: string, toKey: string, desiredId: string, naturalKey: string, evidence: ArchitectureExtractionEvidence) => void;
}

/** package.json manifests that declare runtime deps: the root plus every unit's own manifest. */
function dependencyManifestPaths(discovery: Discovery): string[] {
  const unitManifests = discovery.units
    .flatMap(unit => unit.packageManifest && unit.packageManifest !== "package.json" ? [unit.packageManifest] : [])
    .sort();
  return ["package.json", ...unitManifests];
}

/**
 * Aggregates third-party import usage into L1 `externalSystem` entities (service
 * boundaries only — CLA-97) plus container→externalSystem relations. The allowlist
 * is the union of every manifest's runtime `dependencies` (NOT devDependencies) —
 * so a bare import counts only if its package is a declared runtime dependency,
 * which drops node builtins, dev/type-only tooling, and first-party `@okie/*`
 * packages. UI/framework/utility libs are not L1 cards: they attach to the
 * importing container's `technology` (inspector/detail) instead. L1 selection is
 * the top-N service-boundary packages by (import-site count desc, name asc).
 * At L1 the container→external edges collapse to system→external; at L2 they
 * attribute the dependency to the specific container that imports it. Rust crate
 * dependencies (Cargo.toml, e.g. wgpu) are a documented follow-up — crate outline
 * does not rank `use` frequency for L1 externals.
 */
function emitExternalSystems(input: ExternalEmitInput): void {
  const { discovery, readFile, externalUsagesByPackage, entityDescriptors, addRelation } = input;

  // Declared runtime dependencies (name -> its declaration site(s), best-effort line anchored).
  const declaringRefsByPackage = new Map<string, ArchitectureExtractionSourceRef[]>();
  for (const manifestPath of dependencyManifestPaths(discovery)) {
    let text: string;
    try { text = readFile(manifestPath); } catch { continue; }
    let names: string[];
    try {
      const deps = ((JSON.parse(text) as { dependencies?: Record<string, unknown> }).dependencies) ?? {};
      // Local protocols (`workspace:`, `file:`, `link:`) mark first-party packages — never external,
      // even when they ship no container of their own (e.g. a CSS-only workspace member).
      names = Object.entries(deps)
        .filter(([, spec]) => !/^(workspace|file|link):/.test(String(spec)))
        .map(([name]) => name);
    } catch { continue; }
    const lines = runtimeDependencyLines(text);
    for (const name of names) {
      const line = lines.get(name);
      const ref: ArchitectureExtractionSourceRef = line !== undefined
        ? { path: manifestPath, startLine: line, endLine: line }
        : { path: manifestPath };
      const bucket = declaringRefsByPackage.get(name) ?? [];
      bucket.push(ref);
      declaringRefsByPackage.set(name, bucket);
    }
  }

  const importedRuntime = [...externalUsagesByPackage.entries()]
    .filter(([pkg]) => declaringRefsByPackage.has(pkg) && !discovery.unitByPackageName.has(pkg));

  // Rank service-boundary packages only; utility/framework deps never occupy an L1 slot.
  const selected = importedRuntime
    .filter(([pkg]) => isL1ExternalSystemPackage(pkg))
    .sort(([leftPkg, leftUses], [rightPkg, rightUses]) =>
      rightUses.length - leftUses.length || leftPkg.localeCompare(rightPkg))
    .slice(0, MAX_EXTERNAL_SYSTEMS);

  const libraryByContainer = new Map<string, Set<string>>();
  for (const [pkg, usages] of importedRuntime) {
    if (isL1ExternalSystemPackage(pkg)) continue;
    for (const usage of usages) {
      const bucket = libraryByContainer.get(usage.container) ?? new Set();
      bucket.add(pkg);
      libraryByContainer.set(usage.container, bucket);
    }
  }
  for (const descriptor of entityDescriptors) {
    if (descriptor.kind !== "container") continue;
    const names = libraryByContainer.get(descriptor.naturalKey);
    if (!names || names.size === 0) continue;
    descriptor.technology = [...names].sort().slice(0, ARCHITECTURE_EXTRACTION_LIMITS.maxListItems);
  }

  for (const [pkg, usages] of selected) {
    const importRefs = usages.map(usage => usage.source)
      .sort((left, right) => left.path.localeCompare(right.path) || (left.startLine ?? 0) - (right.startLine ?? 0));
    const declRefs = (declaringRefsByPackage.get(pkg) ?? []).slice()
      .sort((left, right) => left.path.localeCompare(right.path));
    // Manifest declaration(s) first (grounds "why it is a dependency"), then import sites; capped.
    const seen = new Set<string>();
    const sourceRefs: ArchitectureExtractionSourceRef[] = [];
    for (const ref of [...declRefs, ...importRefs]) {
      const key = `${ref.path} ${ref.startLine ?? ""} ${ref.endLine ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceRefs.push(ref);
      if (sourceRefs.length >= MAX_EXTERNAL_SOURCE_REFS) break;
    }
    entityDescriptors.push({
      naturalKey: `ext:${pkg}`,
      desiredId: typedId("external", pkg),
      kind: "externalSystem",
      name: pkg,
      // No parentId: external systems are top-level system context (the extraction gate requires it).
      sourceRefs,
    });

    // One container→external relation per importing container; evidence = that container's imports.
    const byContainer = new Map<string, ArchitectureExtractionEvidence[]>();
    for (const usage of usages) {
      const bucket = byContainer.get(usage.container) ?? [];
      bucket.push({ source: usage.source });
      byContainer.set(usage.container, bucket);
    }
    for (const container of [...byContainer.keys()].sort()) {
      for (const evidence of byContainer.get(container)!) {
        addRelation(container, `ext:${pkg}`, typedId("relation", container, pkg), `ext:${container}->${pkg}`, evidence);
      }
    }
  }
}

/**
 * Attach observed TypeScript / JavaScript / Rust tags so inspector cards are not
 * "Technology not specified" when the language is known (CLA-102). Rust
 * crates get `Rust` from the crate unit and from `.rs` file-components.
 * Prepends languages onto CLA-97 library names already on the container.
 */
function attachObservedLanguageTags(
  discovery: Discovery,
  entityDescriptors: EntityDescriptor[],
): void {
  const tagsByUnit = new Map<string, Set<ObservedLanguageTag>>();
  const systemTags = new Set<ObservedLanguageTag>();
  const add = (unitDir: string | undefined, tag: ObservedLanguageTag): void => {
    systemTags.add(tag);
    if (!unitDir) return;
    const bucket = tagsByUnit.get(unitDir) ?? new Set();
    bucket.add(tag);
    tagsByUnit.set(unitDir, bucket);
  };
  for (const file of discovery.sourceFiles) {
    const tag = languageTagForScanPath(file);
    if (tag) add(discovery.unitByFile.get(file), tag);
  }
  for (const unit of discovery.units) {
    if (unit.kind === "rust") add(unit.dir, "Rust");
  }
  for (const descriptor of entityDescriptors) {
    if (descriptor.kind === "softwareSystem") {
      const merged = mergeObservedLanguageTechnology([...systemTags], descriptor.technology);
      if (merged) descriptor.technology = merged;
    } else if (descriptor.kind === "container") {
      const merged = mergeObservedLanguageTechnology(
        [...(tagsByUnit.get(descriptor.naturalKey) ?? [])],
        descriptor.technology,
      );
      if (merged) descriptor.technology = merged;
    } else if (descriptor.kind === "component") {
      const tag = languageTagForScanPath(descriptor.naturalKey);
      const merged = mergeObservedLanguageTechnology(tag ? [tag] : [], descriptor.technology);
      if (merged) descriptor.technology = merged;
    }
  }
}

/**
 * Deterministic syntax-level extraction: system → containers (workspace members,
 * tooling, Rust crates) → components (one per source file) → code (one per
 * top-level declaration). Rust `.rs` files are outlined via tree-sitter
 * (modules, structs, enums, functions, impl methods). Relations come from
 * static TS import/export specifiers and Cargo.toml path dependencies.
 * Output is independent of file discovery order.
 *
 * Cyclomatic complexity and clone fingerprints are observed on the same
 * `ts.createSourceFile` walk and returned separately so ArchitectureExtraction
 * stays LLM-gate clean.
 */
export interface ExtractedArchitecture {
  extraction: ArchitectureExtraction;
  /**
   * Relative imports that recorded no relation and name no file in the repository
   * listing (see {@link UnresolvedRelativeImport}). Sorted by path, line, specifier; deduplicated. Scan-time
   * evidence of a gap (rendered into `analysis.limitations`), never extraction input.
   */
  unresolvedRelativeImports: readonly UnresolvedRelativeImport[];
  /** Entity id → McCabe cyclomatic. Only function-like `kind: "code"` entities. */
  cyclomaticById: ReadonlyMap<string, number>;
  /** Clone pairs between existing function-like code ids. Never invents ids. */
  clonePairs: readonly ClonePair[];
}

/**
 * The path part of a relative module specifier: a bundler `?query` (`./logo.svg?url`,
 * `./worker.ts?worker`) or `#fragment` names the same file, so it is dropped before
 * file/unit resolution. Used for the file-level import edge only — the symbol pass
 * keeps the raw specifier, since a `?raw`/`?worker` import's bindings are not the
 * target module's exports.
 */
export function relativeSpecifierPath(specifier: string): string {
  return specifier.replace(/[?#].*$/, "");
}

// What a module specifier can name once its extension is dropped: TS sources and
// declaration files (TypeScript resolves `./types/x` to `x.d.ts`), JS, and JSON.
const IMPORT_TARGET_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

/**
 * Whether a relative specifier names a file that exists in the repository: the path
 * itself, or its stem (a `.js`-family extension dropped, so `./x.js` also finds
 * `x.ts` / `x.d.ts`) or the path as a directory index, with any
 * {@link IMPORT_TARGET_EXTENSIONS} suffix. Any tracked file counts (an asset, JSON, a
 * declaration file, a `.js` the TS-repo rule skipped): such an import is not broken.
 * Never reads the disk: the answer depends only on the listing, so a local checkout and
 * a tarball agree.
 */
function isTrackedImportTarget(base: string, trackedFiles: ReadonlySet<string>): boolean {
  const stem = base.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");
  const candidates = [
    base,
    ...IMPORT_TARGET_EXTENSIONS.map(extension => `${stem}${extension}`),
    ...IMPORT_TARGET_EXTENSIONS.map(extension => `${base}/index${extension}`),
  ];
  return candidates.some(candidate => trackedFiles.has(candidate));
}

/**
 * A target inside a `node_modules` directory points into a package-manager location
 * whose contents the scanner does not model (installed or committed, it is never
 * listed), so such an import is never reported as unresolved — on every provider and
 * whatever happens to be installed.
 */
function isPackageManagerPath(base: string): boolean {
  return /(^|\/)node_modules(\/|$)/.test(base);
}

/**
 * A relative import that recorded no relation and names no file in the repository
 * listing (see `isTrackedImportTarget`).
 */
export interface UnresolvedRelativeImport {
  path: string;
  /** 1-based line of the import. */
  line: number;
  specifier: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sorted (path, line, specifier) and deduplicated — independent of discovery order. */
function canonicalUnresolvedImports(imports: readonly UnresolvedRelativeImport[]): UnresolvedRelativeImport[] {
  const sorted = [...imports].sort((left, right) =>
    compareText(left.path, right.path) || left.line - right.line || compareText(left.specifier, right.specifier));
  return sorted.filter((item, index) => {
    const previous = sorted[index - 1];
    return !previous || previous.path !== item.path || previous.line !== item.line || previous.specifier !== item.specifier;
  });
}

export function extractArchitecture(input: ExtractInput): ArchitectureExtraction {
  return collectExtractedArchitecture(input).extraction;
}

export function collectExtractedArchitecture(input: ExtractInput): ExtractedArchitecture {
  const { discovery, readFile } = input;
  const fileSet = new Set(discovery.sourceFiles);
  // Folded re-export shims (CLA-263) are not components, but importers still resolve
  // through them: an import of a shim path lands on the shim's target file, so the
  // dependency edge survives the fold instead of vanishing with the shim.
  const aliasTargetByPath = new Map((discovery.summary.reexportAliases ?? []).map(alias => [alias.path, alias.target]));
  const resolvableFiles: ReadonlySet<string> = aliasTargetByPath.size ? new Set([...fileSet, ...aliasTargetByPath.keys()]) : fileSet;
  const resolveFile = (fromFile: string, specifier: string): string | undefined => {
    const resolved = resolveRelativeImport(fromFile, specifier, resolvableFiles);
    return resolved === undefined ? undefined : aliasTargetByPath.get(resolved) ?? resolved;
  };
  const systemName = input.systemName ?? "Okie";
  const systemSlug = input.systemSlug ?? systemName;

  let systemSourceRefs: ArchitectureExtractionSourceRef[] = [];
  try {
    readFile("README.md");
    systemSourceRefs = [{ path: "README.md" }];
  } catch {
    systemSourceRefs = [];
  }

  const entityDescriptors: EntityDescriptor[] = [];
  entityDescriptors.push({
    naturalKey: "system",
    desiredId: typedId("system", systemSlug),
    kind: "softwareSystem",
    name: systemName,
    sourceRefs: systemSourceRefs,
  });
  for (const unit of discovery.units) {
    entityDescriptors.push({
      naturalKey: unit.dir,
      desiredId: typedId("container", unit.dir),
      kind: "container",
      name: unit.name,
      parentKey: "system",
      sourceRefs: [{ path: unit.evidencePath }],
    });
  }

  const relationDescriptors = new Map<string, RelationDescriptor>();
  const addRelation = (
    fromKey: string,
    toKey: string,
    desiredId: string,
    naturalKey: string,
    evidence: ArchitectureExtractionEvidence,
    kind?: "uses" | "calls",
  ): void => {
    let descriptor = relationDescriptors.get(naturalKey);
    if (!descriptor) {
      descriptor = { naturalKey, desiredId, fromKey, toKey, ...(kind ? { kind } : {}), evidence: [] };
      relationDescriptors.set(naturalKey, descriptor);
    }
    descriptor.evidence.push(evidence);
  };

  // Per third-party package: every static import site + the container it lives in. Aggregated
  // after the walk into top-N externalSystem entities (see below).
  const externalUsagesByPackage = new Map<string, Array<{ container: string; source: ArchitectureExtractionSourceRef }>>();

  interface FileScan {
    file: string;
    sourceFile: ts.SourceFile;
    kept: TopLevelDeclaration[];
    /** Declaration name → its entity naturalKey (first declaration wins on overloads). */
    keyByName: Map<string, string>;
    imports: Map<string, NamedImportBinding>;
    exports: Map<string, ExportBinding>;
    exportStars: string[];
  }

  interface ExportBinding {
    localName?: string;
    specifier?: string;
    exportedName?: string;
  }
  const moduleExportBindings = (sourceFile: ts.SourceFile): { bindings: Map<string, ExportBinding>; stars: string[] } => {
    const bindings = new Map<string, ExportBinding>();
    const stars: string[] = [];
    for (const statement of sourceFile.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
      const exported = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
      const isDefault = modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (exported && (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
        bindings.set(isDefault ? "default" : statement.name.text, { localName: statement.name.text });
      } else if (exported && ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) bindings.set(declaration.name.text, { localName: declaration.name.text });
        }
      } else if (exported && (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement))) {
        bindings.set(statement.name.text, { localName: statement.name.text });
      } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
        bindings.set("default", { localName: statement.expression.text });
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        if (!statement.exportClause) stars.push(statement.moduleSpecifier.text);
        else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            bindings.set(element.name.text, {
              specifier: statement.moduleSpecifier.text,
              exportedName: (element.propertyName ?? element.name).text,
            });
          }
        }
      } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          bindings.set(element.name.text, { localName: (element.propertyName ?? element.name).text });
        }
      }
    }
    return { bindings, stars };
  };
  const fileScans: FileScan[] = [];

  const unitDirs = discovery.units.map(unit => unit.dir);
  const unresolvedRelativeImports: UnresolvedRelativeImport[] = [];
  const trackedFiles: ReadonlySet<string> = discovery.trackedFiles ?? fileSet;

  for (const file of discovery.sourceFiles) {
    const unitDir = discovery.unitByFile.get(file)!;
    entityDescriptors.push({
      naturalKey: file,
      desiredId: typedId("component", file),
      kind: "component",
      // The container already carries the path prefix, so the card reads by its
      // DISTINCTIVE tail (`src/compile-c4.ts`), not a truncated common prefix.
      // The full path stays on sourceRefs — identity and evidence are unchanged.
      name: file.startsWith(`${unitDir}/`) ? file.slice(unitDir.length + 1) : file,
      parentKey: unitDir,
      sourceRefs: [{ path: file }],
    });

    if (file.endsWith(".rs")) {
      const outlined = rustTopLevelItems(readFile(file));
      const items = input.codeSurface === "public"
        ? outlined.filter(item => item.exported)
        : outlined;
      items.forEach((item, index) => {
        entityDescriptors.push({
          naturalKey: `${file}#${index}`,
          desiredId: typedId("code", file, item.name),
          kind: "code",
          name: item.name,
          parentKey: file,
          sourceRefs: [{ path: file, symbol: item.name, startLine: item.startLine, endLine: item.endLine }],
        });
      });
      continue;
    }

    const sourceFile = parseSource(file, readFile(file));
    const declarations = input.codeSurface === "public"
      ? topLevelDeclarations(sourceFile).filter(declaration => declaration.exported)
      : topLevelDeclarations(sourceFile);
    const keyByName = new Map<string, string>();
    declarations.forEach((declaration, index) => {
      const naturalKey = `${file}#${index}`;
      const cyclomaticComplexity = cyclomaticForDeclaration(declaration);
      const cloneFingerprint = cloneFingerprintForDeclaration(declaration);
      entityDescriptors.push({
        naturalKey,
        desiredId: typedId("code", file, declaration.name),
        kind: "code",
        name: declaration.name,
        parentKey: file,
        ...(declaration.exported ? { exposure: [{
          kind: "moduleExport",
          evidence: { source: { path: file, symbol: declaration.name, startLine: declaration.startLine, endLine: declaration.endLine }, reason: "declared module export" },
        }] } : {}),
        sourceRefs: [{ path: file, symbol: declaration.name, startLine: declaration.startLine, endLine: declaration.endLine }],
        ...(cyclomaticComplexity !== undefined ? { cyclomaticComplexity } : {}),
        ...(cloneFingerprint !== undefined ? { cloneFingerprint } : {}),
      });
      if (!keyByName.has(declaration.name)) keyByName.set(declaration.name, naturalKey);
    });
    const moduleExports = moduleExportBindings(sourceFile);
    fileScans.push({ file, sourceFile, kept: declarations, keyByName, imports: namedImportBindings(sourceFile), exports: moduleExports.bindings, exportStars: moduleExports.stars });

    for (const dependency of [...moduleImports(sourceFile), ...dynamicImports(sourceFile)]) {
      const evidence: ArchitectureExtractionEvidence = {
        source: { path: file, startLine: dependency.startLine, endLine: dependency.endLine },
      };
      if (dependency.specifier.startsWith(".")) {
        const specifierPath = relativeSpecifierPath(dependency.specifier);
        const target = resolveFile(file, specifierPath);
        if (target && target !== file) {
          addRelation(file, target, typedId("relation", file, target), `comp:${file}->${target}`, evidence);
        } else if (!target) {
          // A relative import escaping the discovered set (e.g. the generated WASM
          // pkg) still names its owning unit — keep the container-level fact.
          const targetUnit = resolveRelativeUnitImport(file, specifierPath, unitDirs);
          const targetPath = normalizeRepoPath(file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "", specifierPath);
          if (targetUnit && targetUnit !== unitDir) {
            addRelation(unitDir, targetUnit, typedId("relation", unitDir, targetUnit), `unit:${unitDir}->${targetUnit}`, evidence);
          } else if (!isPackageManagerPath(targetPath) && !isTrackedImportTarget(targetPath, trackedFiles)) {
            // No relation and no such file in the repository: the edge is lost, so say
            // so (never silent). An existing asset/JSON/skipped file is not a gap.
            unresolvedRelativeImports.push({ path: file, line: dependency.startLine, specifier: dependency.specifier });
          }
        }
      } else {
        const targetUnit = resolvePackageImport(dependency.specifier, discovery.unitByPackageName);
        if (targetUnit) {
          if (targetUnit !== unitDir) {
            addRelation(unitDir, targetUnit, typedId("relation", unitDir, targetUnit), `unit:${unitDir}->${targetUnit}`, evidence);
          }
        } else {
          // Bare specifier that is not a workspace package: a candidate third-party import.
          const pkg = packageNameOfSpecifier(dependency.specifier);
          if (pkg) {
            const usages = externalUsagesByPackage.get(pkg) ?? [];
            usages.push({ container: unitDir, source: evidence.source });
            externalUsagesByPackage.set(pkg, usages);
          }
        }
      }
    }
  }

  // Symbol-level usage pass (needs every file's declaration table, hence second pass):
  // each retained declaration's identifier references resolve against (a) the same
  // file's retained declarations and (b) named relative imports whose exported name
  // is a retained declaration of the target file. This is the L4 "how is it used"
  // graph — code→code `uses` relations with reference-site evidence. Default and
  // namespace imports, cross-package imports, and property accesses stay at the
  // file/container granularity the import relations above already carry.
  const scanByFile = new Map(fileScans.map(scan => [scan.file, scan]));
  type ResolvedExport = { key: string; file: string; name: string } | "ambiguous" | undefined;
  const resolveExport = (scan: FileScan, exportedName: string, seen = new Set<string>()): ResolvedExport => {
    const visitKey = `${scan.file}:${exportedName}`;
    if (seen.has(visitKey)) return undefined;
    seen.add(visitKey);
    const binding = scan.exports.get(exportedName);
    if (binding?.localName) {
      const key = scan.keyByName.get(binding.localName);
      if (key) return { key, file: scan.file, name: binding.localName };
      const imported = scan.imports.get(binding.localName);
      if (imported?.specifier.startsWith(".") && !imported.namespace) {
        const targetFile = resolveFile(scan.file, imported.specifier);
        const targetScan = targetFile ? scanByFile.get(targetFile) : undefined;
        return targetScan ? resolveExport(targetScan, imported.exportedName, seen) : undefined;
      }
      return undefined;
    }
    const resolveFrom = (specifier: string, name: string): ResolvedExport => {
      if (!specifier.startsWith(".")) return undefined;
      const targetFile = resolveFile(scan.file, specifier);
      const targetScan = targetFile ? scanByFile.get(targetFile) : undefined;
      return targetScan ? resolveExport(targetScan, name, seen) : undefined;
    };
    if (binding?.specifier && binding.exportedName) return resolveFrom(binding.specifier, binding.exportedName);
    if (exportedName === "default") return undefined;
    const resolved = scan.exportStars
      .map(specifier => resolveFrom(specifier, exportedName))
    if (resolved.includes("ambiguous")) return "ambiguous";
    const targets = resolved.filter((target): target is { key: string; file: string; name: string } => Boolean(target));
    const unique = new Map(targets.map(target => [target.key, target]));
    return unique.size === 1 ? unique.values().next().value : unique.size > 1 ? "ambiguous" : undefined;
  };
  const exportNames = (scan: FileScan, seen = new Set<string>()): Set<string> => {
    if (seen.has(scan.file)) return new Set();
    seen.add(scan.file);
    const names = new Set(scan.exports.keys());
    for (const specifier of scan.exportStars) {
      if (!specifier.startsWith(".")) continue;
      const file = resolveFile(scan.file, specifier);
      const target = file ? scanByFile.get(file) : undefined;
      if (target) for (const name of exportNames(target, seen)) if (name !== "default") names.add(name);
    }
    return names;
  };
  const descriptorByKey = new Map(entityDescriptors.map(descriptor => [descriptor.naturalKey, descriptor]));
  const stringsIn = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(stringsIn);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(stringsIn);
    return [];
  };
  for (const unit of discovery.units) {
    const manifestPath = unit.packageManifest;
    if (!manifestPath) continue;
    let manifest: Record<string, unknown>;
    try { manifest = JSON.parse(readFile(manifestPath)) as Record<string, unknown>; } catch { continue; }
    const publicPaths = Object.hasOwn(manifest, "exports") ? stringsIn(manifest.exports) : [...stringsIn(manifest.main), ...stringsIn(manifest.types)];
    const bins = stringsIn(manifest.bin);
    for (const [kind, paths] of [["publicApi", publicPaths], ["entryPoint", bins]] as const) {
      for (const path of paths) {
        const file = resolveFile(manifestPath, path);
        const scan = file ? scanByFile.get(file) : undefined;
        if (!scan) continue;
        const evidence: ArchitectureExtractionEvidence = { source: { path: manifestPath }, reason: kind === "publicApi" ? "package entrypoint export" : "package bin entrypoint" };
        if (kind === "entryPoint") {
          const descriptor = descriptorByKey.get(scan.file);
          if (descriptor) descriptor.exposure = [...(descriptor.exposure ?? []), { kind, evidence }];
          continue;
        }
        for (const exportedName of exportNames(scan)) {
          const resolved = resolveExport(scan, exportedName);
          if (!resolved || resolved === "ambiguous") continue;
          const descriptor = descriptorByKey.get(resolved.key);
          if (descriptor) descriptor.exposure = [...(descriptor.exposure ?? []), { kind, evidence }];
        }
      }
    }
  }
  const semanticFiles = new Set(input.languageAnalysis?.coverage.flatMap(item => item.indexedFiles) ?? []);
  for (const scan of fileScans) {
    if (semanticFiles.has(scan.file)) continue;
    if (scan.kept.length === 0) continue;
    const candidates = new Set([...scan.keyByName.keys(), ...scan.imports.keys()]);
    if (candidates.size === 0) continue;
    scan.kept.forEach((declaration, index) => {
      const fromKey = `${scan.file}#${index}`;
      const namespaces = new Set([...scan.imports.entries()]
        .filter(([, binding]) => binding.namespace)
        .map(([name]) => name));
      for (const reference of symbolReferencesIn(scan.sourceFile, declaration, candidates, namespaces)) {
        let target: { key: string; file: string; name: string } | undefined;
        const binding = scan.imports.get(reference.name);
        if (binding) {
          if (!binding.specifier.startsWith(".")) continue;
          const targetFile = resolveFile(scan.file, binding.specifier);
          const targetScan = targetFile ? scanByFile.get(targetFile) : undefined;
          if (!targetScan) continue;
          const resolved = binding.namespace
            ? (reference.member ? resolveExport(targetScan, reference.member) : undefined)
            : resolveExport(targetScan, binding.exportedName);
          target = resolved === "ambiguous" ? undefined : resolved;
        } else {
          const key = scan.keyByName.get(reference.name);
          target = key ? { key, file: scan.file, name: reference.name } : undefined;
        }
        if (!target || (target.key === fromKey && reference.kind !== "calls")) continue;
        addRelation(
          fromKey,
          target.key,
          typedId("relation", symbolRelationGroup(scan.file, declaration.name), symbolRelationGroup(target.file, target.name)),
          `sym:${reference.kind}:${fromKey}->${target.key}`,
          { source: { path: scan.file, startLine: reference.line, endLine: reference.line } },
          reference.kind,
        );
      }
    });
  }

  if (input.languageAnalysis) {
    // Resolve both endpoints through source spans. Semantic names are not unique
    // (overloads, aliases, methods), and public-only filtering can hide a target.
    const ownerOf = (location: AnalysisLocation, definition = false): EntityDescriptor | undefined => {
      const scan = scanByFile.get(location.path);
      if (scan && location.startOffset !== undefined) {
        const index = scan.kept.findIndex(declaration => (definition
          ? declaration.node.getStart(scan.sourceFile) === location.startOffset!
          : declaration.node.getStart(scan.sourceFile) <= location.startOffset!)
          && declaration.node.getEnd() >= (location.endOffset ?? location.startOffset!));
        return index >= 0 ? descriptorByKey.get(`${location.path}#${index}`) : undefined;
      }
      return entityDescriptors.filter(descriptor => descriptor.kind === "code" && descriptor.sourceRefs.some(ref =>
        ref.path === location.path && ref.startLine !== undefined && ref.endLine !== undefined
        && ref.startLine <= location.startLine && ref.endLine >= location.endLine))
        .sort((a, b) => (a.sourceRefs[0]!.endLine! - a.sourceRefs[0]!.startLine!)
          - (b.sourceRefs[0]!.endLine! - b.sourceRefs[0]!.startLine!))[0];
    };
    const definitions = new Map(input.languageAnalysis.definitions.map(definition => [definition.symbol, definition]));
    for (const reference of input.languageAnalysis.references) {
      const definition = definitions.get(reference.symbol);
      if (!definition) continue;
      const from = ownerOf(reference);
      const to = ownerOf(definition, true);
      if (reference.path !== definition.path && fileSet.has(reference.path) && fileSet.has(definition.path)) {
        addRelation(reference.path, definition.path, typedId("relation", reference.path, definition.path),
          `comp:${reference.path}->${definition.path}`, { source: { path: reference.path, startLine: reference.startLine, endLine: reference.endLine } });
      }
      if (!from || !to || (from.naturalKey === to.naturalKey && reference.kind !== "calls")) continue;
      addRelation(from.naturalKey, to.naturalKey,
        typedId("relation", symbolRelationGroup(reference.path, from.name), symbolRelationGroup(definition.path, to.name)),
        `sym:${reference.kind}:${from.naturalKey}->${to.naturalKey}`,
        { source: { path: reference.path, startLine: reference.startLine, endLine: reference.endLine } }, reference.kind);
    }
    for (const module of input.languageAnalysis.modules) {
      // A module edge into a folded shim lands on the shim's target (CLA-263).
      const targetPath = aliasTargetByPath.get(module.targetPath) ?? module.targetPath;
      if (module.path === targetPath || !fileSet.has(module.path) || !fileSet.has(targetPath)) continue;
      addRelation(module.path, targetPath, typedId("relation", module.path, targetPath),
        `comp:${module.path}->${targetPath}`, { source: { path: module.path, startLine: module.startLine, endLine: module.endLine } });
    }
  }

  // Rust crate wiring is an observed fact in Cargo.toml — `path = "…"`
  // dependencies become container edges, so a crate is never a mystery island.
  for (const unit of discovery.units) {
    if (unit.kind !== "rust") continue;
    const manifestPath = `${unit.dir}/Cargo.toml`;
    let manifestText: string;
    try { manifestText = readFile(manifestPath); } catch { continue; }
    for (const dependency of cargoPathDependencies(manifestText)) {
      const targetDir = resolveRelativeUnitImport(`${unit.dir}/Cargo.toml`, dependency.path, unitDirs);
      if (!targetDir || targetDir === unit.dir) continue;
      addRelation(
        unit.dir,
        targetDir,
        typedId("relation", unit.dir, targetDir),
        `unit:${unit.dir}->${targetDir}`,
        { source: { path: manifestPath, startLine: dependency.line, endLine: dependency.line } },
      );
    }
  }

  emitExternalSystems({ discovery, readFile, externalUsagesByPackage, entityDescriptors, addRelation });
  attachObservedLanguageTags(discovery, entityDescriptors);

  // Assign collision-free IDs in a fully canonical order (independent of discovery order).
  const sortedEntities = [...entityDescriptors].sort((left, right) =>
    left.desiredId.localeCompare(right.desiredId) || left.naturalKey.localeCompare(right.naturalKey));
  const entityIds = resolveCollisions(sortedEntities.map(descriptor => descriptor.desiredId));
  const idByKey = new Map(sortedEntities.map((descriptor, index) => [descriptor.naturalKey, entityIds[index]!]));

  const entities: ArchitectureExtractionEntity[] = sortedEntities.map((descriptor, index) => ({
    id: entityIds[index]!,
    kind: descriptor.kind,
    ...(descriptor.parentKey !== undefined ? { parentId: idByKey.get(descriptor.parentKey)! } : {}),
    name: descriptor.name,
    ...(descriptor.technology?.length ? { technology: [...descriptor.technology] } : {}),
    ...(descriptor.exposure?.length ? { exposure: descriptor.exposure.filter((entry, index, entries) =>
      entries.findIndex(candidate => candidate.kind === entry.kind
        && candidate.evidence.source.path === entry.evidence.source.path
        && candidate.evidence.reason === entry.evidence.reason) === index) } : {}),
    sourceRefs: descriptor.sourceRefs,
  }));
  const cyclomaticById = new Map<string, number>();
  const cloneBuckets = new Map<string, string[]>();
  sortedEntities.forEach((descriptor, index) => {
    const id = entityIds[index]!;
    if (descriptor.cyclomaticComplexity !== undefined) {
      cyclomaticById.set(id, descriptor.cyclomaticComplexity);
    }
    if (descriptor.cloneFingerprint !== undefined) {
      const bucket = cloneBuckets.get(descriptor.cloneFingerprint) ?? [];
      bucket.push(id);
      cloneBuckets.set(descriptor.cloneFingerprint, bucket);
    }
  });

  const sortedRelations = [...relationDescriptors.values()].sort((left, right) =>
    left.desiredId.localeCompare(right.desiredId) || left.naturalKey.localeCompare(right.naturalKey));
  const relationIds = resolveCollisions(sortedRelations.map(descriptor => descriptor.desiredId));
  const relations: ArchitectureExtractionRelation[] = sortedRelations.map((descriptor, index) => ({
    id: relationIds[index]!,
    from: idByKey.get(descriptor.fromKey)!,
    to: idByKey.get(descriptor.toKey)!,
    kind: descriptor.kind ?? "dependsOn",
    evidence: finalizeEvidence(descriptor.evidence),
  }));

  return {
    extraction: {
      schemaVersion: 1,
      entities: entities.sort((left, right) => left.id.localeCompare(right.id)),
      relations: relations.sort((left, right) => left.id.localeCompare(right.id)),
    },
    cyclomaticById,
    clonePairs: clonePairsFromBuckets(cloneBuckets),
    unresolvedRelativeImports: canonicalUnresolvedImports(unresolvedRelativeImports),
  };
}

/**
 * Overlay observed McCabe onto existing code entities. No new C4 nodes.
 * Extraction documents stay cyclomatic-free — this is scan-time, like CODEOWNERS.
 */
export function attachCyclomaticComplexity(
  snapshot: ArchitectureSnapshot,
  cyclomaticById: ReadonlyMap<string, number>,
): ArchitectureSnapshot {
  if (cyclomaticById.size === 0) {
    return snapshot.entities.every(entity => entity.cyclomaticComplexity === undefined)
      ? snapshot
      : {
        ...snapshot,
        entities: snapshot.entities.map(entity => {
          if (entity.cyclomaticComplexity === undefined) return entity;
          const rest = { ...entity };
          delete rest.cyclomaticComplexity;
          return rest;
        }),
      };
  }
  return {
    ...snapshot,
    entities: snapshot.entities.map(entity => {
      const complexity = cyclomaticById.get(entity.id);
      if (complexity === undefined) {
        if (entity.cyclomaticComplexity === undefined) return entity;
        const rest = { ...entity };
        delete rest.cyclomaticComplexity;
        return rest;
      }
      return { ...entity, cyclomaticComplexity: complexity };
    }),
  };
}

/**
 * Recompute McCabe from source when a prior extraction is reused (live enrichment).
 * Same `ts.createSourceFile` walk as minting — not a second parser.
 */
export function cyclomaticByIdFromEntities(
  entities: readonly ArchitectureExtractionEntity[],
  readFile: (repoRelativePath: string) => string,
): Map<string, number> {
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const sourceOf = (path: string): ts.SourceFile | undefined => {
    if (parsed.has(path)) return parsed.get(path);
    try {
      const sourceFile = parseSource(path, readFile(path));
      parsed.set(path, sourceFile);
      return sourceFile;
    } catch {
      parsed.set(path, undefined);
      return undefined;
    }
  };
  const cyclomaticById = new Map<string, number>();
  for (const entity of entities) {
    if (entity.kind !== "code") continue;
    const ref = entity.sourceRefs[0];
    if (!ref?.path || !ref.symbol || ref.path.endsWith(".rs")) continue;
    const sourceFile = sourceOf(ref.path);
    if (!sourceFile) continue;
    const declaration = topLevelDeclarations(sourceFile).find(candidate =>
      candidate.name === ref.symbol
      && (ref.startLine === undefined || candidate.startLine === ref.startLine));
    if (!declaration) continue;
    const complexity = cyclomaticForDeclaration(declaration);
    if (complexity !== undefined) cyclomaticById.set(entity.id, complexity);
  }
  return cyclomaticById;
}

/**
 * Overlay token/AST clone pairs as `duplicates` edges between existing code
 * entities. Invented ids are dropped. No new C4 nodes.
 */
export function attachDuplicateRelations(
  snapshot: ArchitectureSnapshot,
  pairs: readonly ClonePair[],
): ArchitectureSnapshot {
  if (pairs.length === 0) {
    return snapshot.relations.every(relation => relation.kind !== "duplicates")
      ? snapshot
      : { ...snapshot, relations: snapshot.relations.filter(relation => relation.kind !== "duplicates") };
  }
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const kept = snapshot.relations.filter(relation => relation.kind !== "duplicates");
  const existing = new Set<string>();
  const added: ArchitectureSnapshot["relations"][number][] = [];
  for (const pair of pairs) {
    const fromEntity = entityById.get(pair.from);
    const toEntity = entityById.get(pair.to);
    if (!fromEntity || !toEntity) continue;
    if (fromEntity.kind !== "code" || toEntity.kind !== "code") continue;
    if (fromEntity.id === toEntity.id) continue;
    const [left, right] = fromEntity.id < toEntity.id ? [fromEntity, toEntity] : [toEntity, fromEntity];
    const key = `${left.id}\0${right.id}`;
    if (existing.has(key)) continue;
    existing.add(key);
    const evidence = [left.sourceRefs[0], right.sourceRefs[0]]
      .filter((source): source is NonNullable<typeof source> => Boolean(source))
      .map(source => ({ source }));
    if (evidence.length === 0) continue;
    // Snapshot-only overlay (never gate-validated): deliberately unbounded so ids already
    // published for long-path clone pairs do not move (CLA-299).
    const id = unboundedTypedId("relation", "dup", left.id, right.id);
    added.push({
      id,
      from: left.id,
      to: right.id,
      kind: "duplicates",
      label: "duplicates",
      lineageId: id,
      evidence,
    });
  }
  if (added.length === 0 && kept.length === snapshot.relations.length) return snapshot;
  return {
    ...snapshot,
    relations: [...kept, ...added].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Recompute clone pairs from source when a prior extraction is reused.
 * Same `ts.createSourceFile` walk as minting — not a second parser.
 */
export function clonePairsFromEntities(
  entities: readonly ArchitectureExtractionEntity[],
  readFile: (repoRelativePath: string) => string,
): ClonePair[] {
  const parsed = new Map<string, ts.SourceFile | undefined>();
  const sourceOf = (path: string): ts.SourceFile | undefined => {
    if (parsed.has(path)) return parsed.get(path);
    try {
      const sourceFile = parseSource(path, readFile(path));
      parsed.set(path, sourceFile);
      return sourceFile;
    } catch {
      parsed.set(path, undefined);
      return undefined;
    }
  };
  const knownIds = new Set(entities.map(entity => entity.id));
  const buckets = new Map<string, string[]>();
  for (const entity of entities) {
    if (entity.kind !== "code" || !knownIds.has(entity.id)) continue;
    const ref = entity.sourceRefs[0];
    if (!ref?.path || !ref.symbol || ref.path.endsWith(".rs")) continue;
    const sourceFile = sourceOf(ref.path);
    if (!sourceFile) continue;
    const declaration = topLevelDeclarations(sourceFile).find(candidate =>
      candidate.name === ref.symbol
      && (ref.startLine === undefined || candidate.startLine === ref.startLine));
    if (!declaration) continue;
    const fingerprint = cloneFingerprintForDeclaration(declaration);
    if (!fingerprint) continue;
    const bucket = buckets.get(fingerprint) ?? [];
    bucket.push(entity.id);
    buckets.set(fingerprint, bucket);
  }
  return clonePairsFromBuckets(buckets);
}
