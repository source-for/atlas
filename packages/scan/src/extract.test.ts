import assert from "node:assert/strict";
import test from "node:test";
import { adaptArchitectureExtraction, validateArchitectureExtraction } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import {
  cargoPathDependencies,
  collectExtractedArchitecture,
  cyclomaticComplexity,
  cyclomaticForDeclaration,
  cyclomaticIsFlagged,
  CYCLOMATIC_FLAG_THRESHOLD,
  dynamicImports,
  extractArchitecture,
  attachCyclomaticComplexity,
  attachDuplicateRelations,
  cloneFingerprintForDeclaration,
  clonePairsFromEntities,
  MIN_CLONE_TOKENS,
  moduleImports,
  parseSource,
  resolvePackageImport,
  resolveRelativeImport,
  topLevelDeclarations,
  languageTagForScanPath,
} from "./extract.js";

test("topLevelDeclarations captures every top-level named decl, exported or not", () => {
  const source = parseSource("m.ts", [
    "export function foo() {}",
    "interface Bar { x: number }",
    "export const baz = 1, qux = 2;",
    "type Alias = string;",
    "export class Cls {}",
    "enum E { A }",
    "function localHelper() { const inner = 1; return inner; }",
  ].join("\n"));
  assert.deepEqual(
    topLevelDeclarations(source).map(d => d.name),
    ["foo", "Bar", "baz", "qux", "Alias", "Cls", "E", "localHelper"],
  );
  // `inner` is nested, not top-level.
  assert.equal(topLevelDeclarations(source).some(d => d.name === "inner"), false);
});

test("topLevelDeclarations parses tsx and reports 1-based line spans", () => {
  const source = parseSource("C.tsx", "const A = 1;\nexport function C() {\n  return <div />;\n}\n");
  const decls = topLevelDeclarations(source);
  const c = decls.find(d => d.name === "C")!;
  assert.equal(c.startLine, 2);
  assert.equal(c.endLine, 4);
});

test("moduleImports collects import and re-export specifiers", () => {
  const source = parseSource("m.ts", [
    "import a from './a.js';",
    "import { b } from '../b.js';",
    "export { c } from './c.js';",
    "import 'side-effect';",
    "const dynamic = 1;",
  ].join("\n"));
  assert.deepEqual(moduleImports(source).map(i => i.specifier), ["./a.js", "../b.js", "./c.js", "side-effect"]);
  // Static pass ignores dynamic import expressions.
  const dynamic = parseSource("m.ts", ["const load = () => import('./lazy.js');"].join("\n"));
  assert.deepEqual(moduleImports(dynamic).map(i => i.specifier), []);
});

test("dynamicImports collects import('…') specifiers and skips type-level / computed forms", () => {
  const source = parseSource("m.tsx", [
    "async function boot() {",
    "  const { App } = await import('./App');",
    "  return App;",
    "}",
    "const dompurify = import('dompurify').then(m => m.default);",
    "type Api = typeof import('mermaid')['default'];", // ImportTypeNode — not a call
    "const name = 'x';",
    "const bad = import(name);", // computed specifier — no syntactic identity
  ].join("\n"));
  assert.deepEqual(dynamicImports(source).map(i => i.specifier), ["./App", "dompurify"]);
  // Anchored to the call expression's line (1-based).
  assert.equal(dynamicImports(source).find(i => i.specifier === "./App")!.startLine, 2);
});

test("resolveRelativeImport maps .js/.jsx/extensionless specifiers onto discovered files", () => {
  const files = new Set(["pkg/src/model.ts", "pkg/src/ui/View.tsx", "pkg/src/util/index.ts"]);
  assert.equal(resolveRelativeImport("pkg/src/validation.ts", "./model.js", files), "pkg/src/model.ts");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./ui/View.js", files), "pkg/src/ui/View.tsx");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./util", files), "pkg/src/util/index.ts");
  assert.equal(resolveRelativeImport("pkg/src/app.ts", "./missing.js", files), undefined);
});

test("resolvePackageImport maps @scope specifiers (incl subpaths) to member dirs", () => {
  const units = new Map([["@okie/architecture", "packages/architecture"], ["@okie/scene-compiler", "packages/scene-compiler"]]);
  assert.equal(resolvePackageImport("@okie/architecture", units), "packages/architecture");
  assert.equal(resolvePackageImport("@okie/architecture/sub", units), "packages/architecture");
  assert.equal(resolvePackageImport("react", units), undefined);
});

function syntheticDiscovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile: new Map([["pkg/a/src/index.ts", "pkg/a"], ["pkg/b/src/main.ts", "pkg/b"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const syntheticFiles: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nimport './helper.js';\nexport class Beta {}\n",
};

function readSynthetic(path: string): string {
  const text = syntheticFiles[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
}

test("extractArchitecture emits a gate-clean document with C4 hierarchy and import relations", () => {
  const extraction = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);

  const byId = new Map(extraction.entities.map(e => [e.id, e]));
  assert.ok(byId.has("system:acme"));
  assert.equal(byId.get("system:acme")!.kind, "softwareSystem");
  assert.equal(byId.get("container:pkg-a")!.parentId, "system:acme");
  assert.equal(byId.get("component:pkg-a-src-index-ts")!.parentId, "container:pkg-a");
  // top-level decls become code entities with path+symbol+line anchors
  const alpha = byId.get("code:pkg-a-src-index-ts:alpha")!;
  assert.equal(alpha.parentId, "component:pkg-a-src-index-ts");
  assert.equal(alpha.sourceRefs[0]!.symbol, "alpha");
  assert.equal(alpha.sourceRefs[0]!.startLine, 1);

  // @acme/a import → container→container dependsOn; unresolved './helper.js' → no relation.
  assert.deepEqual(
    extraction.relations.map(r => [r.from, r.to, r.kind]),
    [["container:pkg-b", "container:pkg-a", "dependsOn"]],
  );
  assert.ok(extraction.relations[0]!.evidence.length >= 1);
});

test("extractArchitecture derives edges from dynamic import('…') the static pass misses", () => {
  // pkg/b reaches pkg/a's entry ONLY through a code-split `await import(...)` — the
  // real-world shape (web shell → './App'/'./scanLanding'). Both the cross-unit
  // package import and a relative same-unit dynamic import must become observed edges.
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\n",
    "pkg/b/src/main.ts": [
      "async function boot() {",
      "  const a = await import('@acme/a');", // cross-unit → container→container
      "  const local = await import('./panel.js');", // same-unit relative → component→component
      "  return a.alpha ?? local;",
      "}",
      "export class Beta {}",
    ].join("\n"),
    "pkg/b/src/panel.ts": "export function panel() {}\n",
  };
  const discovery: Discovery = {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/b/src/main.ts", "pkg/b/src/panel.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/b/src/main.ts", "pkg/b"], ["pkg/b/src/panel.ts", "pkg/b"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const readFile = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({ discovery, readFile, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const edges = extraction.relations.map(r => [r.from, r.to, r.kind]);
  assert.ok(
    edges.some(e => e[0] === "container:pkg-b" && e[1] === "container:pkg-a" && e[2] === "dependsOn"),
    "cross-unit dynamic import → container→container edge",
  );
  assert.ok(
    edges.some(e => e[0] === "component:pkg-b-src-main-ts" && e[1] === "component:pkg-b-src-panel-ts"),
    "same-unit relative dynamic import → component→component edge",
  );
});

test("extractArchitecture is independent of source-file order", () => {
  const base = syntheticDiscovery();
  const forward = extractArchitecture({ discovery: base, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const reversed = extractArchitecture({
    discovery: { ...base, sourceFiles: [...base.sourceFiles].reverse() },
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("topLevelDeclarations marks the export surface, including export-list and default forms", () => {
  const source = parseSource("m.ts", [
    "export function pub() {}",
    "function internalHelper() {}",
    "const secret = 1;",
    "const listed = 2;",
    "class DefaultThing {}",
    "export { listed };",
    "export default DefaultThing;",
  ].join("\n"));
  assert.deepEqual(
    topLevelDeclarations(source).map(d => [d.name, d.exported]),
    [["pub", true], ["internalHelper", false], ["secret", false], ["listed", true], ["DefaultThing", true]],
  );
});

test("topLevelDeclarations does not mark local names for re-exports from other modules", () => {
  const source = parseSource("m.ts", [
    "const shadow = 1;",
    "export { shadow } from './elsewhere.js';",
  ].join("\n"));
  // The re-export exports ANOTHER module's symbol; the local `shadow` stays private.
  assert.deepEqual(topLevelDeclarations(source).map(d => [d.name, d.exported]), [["shadow", false]]);
});

test("codeSurface 'public' keeps only exported declarations as code entities; default keeps all", () => {
  const files: Record<string, string> = {
    ...syntheticFiles,
    "pkg/a/src/index.ts": "export function alpha() {}\nfunction hidden() {}\nexport const A = 1;\n",
  };
  const readFile = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const everything = extractArchitecture({ discovery: syntheticDiscovery(), readFile, systemName: "Acme", systemSlug: "acme" });
  const publicOnly = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile,
    systemName: "Acme",
    systemSlug: "acme",
    codeSurface: "public",
  });
  assert.deepEqual(validateArchitectureExtraction(publicOnly), []);
  const codeNames = (extraction: typeof everything): string[] => extraction.entities
    .filter(entity => entity.kind === "code" && entity.parentId === "component:pkg-a-src-index-ts")
    .map(entity => entity.name)
    .sort();
  assert.deepEqual(codeNames(everything), ["A", "alpha", "hidden"]);
  assert.deepEqual(codeNames(publicOnly), ["A", "alpha"]);
  // The file component itself survives either way — only private symbols fold into it.
  assert.ok(publicOnly.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"));
});

function symbolDiscovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/a.ts", "pkg/a/src/b.ts"],
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }],
    unitByFile: new Map([["pkg/a/src/a.ts", "pkg/a"], ["pkg/a/src/b.ts", "pkg/a"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const symbolFiles: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/a.ts": [
    "export function alpha() { return helper(); }",
    "export function gamma() {}",
    "function helper() { return 1; }",
  ].join("\n"),
  "pkg/a/src/b.ts": [
    "import { alpha as al } from './a.js';",
    "export function beta() { return al() + al(); }",
    "export function delta(input: { alpha: number }) { return input.alpha; }",
    "export const shorthand = { al };",
  ].join("\n"),
};

const readSymbolFile = (path: string): string => {
  const text = symbolFiles[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

test("symbol pass separates direct calls from generic uses with reference evidence", () => {
  const extraction = extractArchitecture({
    discovery: symbolDiscovery(),
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const calls = extraction.relations.filter(relation => relation.kind === "calls");
  const uses = extraction.relations.filter(relation => relation.kind === "uses");
  assert.deepEqual(calls.map(relation => [relation.from, relation.to]).sort(), [
    ["code:pkg-a-src-a-ts:alpha", "code:pkg-a-src-a-ts:helper"],
    ["code:pkg-a-src-b-ts:beta", "code:pkg-a-src-a-ts:alpha"],
  ].sort());
  const pairs = uses.map(relation => [relation.from, relation.to]);
  assert.deepEqual(pairs, [["code:pkg-a-src-b-ts:shorthand", "code:pkg-a-src-a-ts:alpha"]]);
  // `input.alpha` (property access) and the parameter binding never count as references.
  assert.ok(!pairs.some(([from]) => from === "code:pkg-a-src-b-ts:delta"));
  // beta references al twice on one line → evidence dedups to the reference site.
  const beta = calls.find(relation => relation.from === "code:pkg-a-src-b-ts:beta")!;
  assert.equal(beta.evidence[0]!.source.path, "pkg/a/src/b.ts");
  assert.equal(beta.evidence[0]!.source.startLine, 2);
});

test("public surface drops relations whose endpoint folded away, keeping the public↔public graph", () => {
  const extraction = extractArchitecture({
    discovery: symbolDiscovery(),
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
    codeSurface: "public",
  });
  const pairs = extraction.relations
    .filter(relation => relation.kind === "uses" || relation.kind === "calls")
    .map(relation => [relation.from, relation.to]);
  // helper is private → alpha→helper disappears; the public cross-file edges stay.
  assert.deepEqual(pairs.sort(), [
    ["code:pkg-a-src-b-ts:beta", "code:pkg-a-src-a-ts:alpha"],
    ["code:pkg-a-src-b-ts:shorthand", "code:pkg-a-src-a-ts:alpha"],
  ].sort());
});

test("symbol pass resolves default, namespace and re-export aliases while respecting shadowing and recursion", () => {
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/src/a.ts": [
      "export function named() { return 1; }",
      "export default function defaulted() { return named(); }",
      "export { named as apiAlias };",
    ].join("\n"),
    "pkg/a/src/barrel.ts": [
      "export { default as renamedDefault, named as throughAlias } from './a.js';",
      "export * from './a.js';",
      "export { loop } from './cycle.js';",
    ].join("\n"),
    "pkg/a/src/cycle.ts": "export { loop } from './barrel.js';\n",
    "pkg/a/src/b.ts": [
      "import def, { apiAlias } from './a.js';",
      "import * as barrel from './barrel.js';",
      "export function caller() {",
      "  const apiAlias = () => 0;",
      "  return def() + barrel.throughAlias() + barrel.renamedDefault + apiAlias();",
      "}",
      "export function recurse(n: number) { return n ? recurse(n - 1) : 0; }",
      "export function typed(value: apiAlias) { return value; }",
    ].join("\n"),
  };
  const discovery: Discovery = {
    sourceFiles: ["pkg/a/src/a.ts", "pkg/a/src/barrel.ts", "pkg/a/src/cycle.ts", "pkg/a/src/b.ts"],
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }],
    unitByFile: new Map([["pkg/a/src/a.ts", "pkg/a"], ["pkg/a/src/barrel.ts", "pkg/a"], ["pkg/a/src/cycle.ts", "pkg/a"], ["pkg/a/src/b.ts", "pkg/a"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => files[path]!,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const calls = extraction.relations.filter(relation => relation.kind === "calls").map(relation => [relation.from, relation.to]);
  assert.ok(calls.some(pair => pair[0] === "code:pkg-a-src-b-ts:caller" && pair[1] === "code:pkg-a-src-a-ts:defaulted"));
  assert.ok(calls.some(pair => pair[0] === "code:pkg-a-src-b-ts:caller" && pair[1] === "code:pkg-a-src-a-ts:named"));
  assert.ok(calls.some(pair => pair[0] === "code:pkg-a-src-b-ts:recurse" && pair[1] === "code:pkg-a-src-b-ts:recurse"));
  assert.equal(calls.some(pair => pair[0] === "code:pkg-a-src-b-ts:caller" && pair[1] === "code:pkg-a-src-a-ts:named"), true);
  const callerToNamed = extraction.relations.find(relation => relation.kind === "calls"
    && relation.from === "code:pkg-a-src-b-ts:caller" && relation.to === "code:pkg-a-src-a-ts:named")!;
  assert.equal(callerToNamed.evidence.length, 1, "shadowed apiAlias must not add a second call");
  assert.equal(extraction.relations.some(relation => relation.from === "code:pkg-a-src-b-ts:typed"), false);
});

test("symbol relations are independent of source-file order", () => {
  const base = symbolDiscovery();
  const forward = extractArchitecture({ discovery: base, readFile: readSymbolFile, systemName: "Acme", systemSlug: "acme" });
  const reversed = extractArchitecture({
    discovery: { ...base, sourceFiles: [...base.sourceFiles].reverse() },
    readFile: readSymbolFile,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed));
});

test("symbol resolution keeps outer calls through block consts, but respects function-scoped vars and nested star ambiguity", () => {
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/src/root.ts": "export function target() {}\n",
    "pkg/a/src/a.ts": "export function foo() {}\n",
    "pkg/a/src/b.ts": "export function foo() {}\n",
    "pkg/a/src/c.ts": "export function foo() {}\n",
    "pkg/a/src/ambig.ts": "export * from './b.js';\nexport * from './c.js';\n",
    "pkg/a/src/barrel.ts": "export * from './ambig.js';\nexport * from './a.js';\n",
    "pkg/a/src/use.ts": [
      "import { target } from './root.js';",
      "import { foo } from './barrel.js';",
      "export function outer() {",
      "  if (true) { const target = () => 1; target(); }",
      "  return target();",
      "}",
      "export function varShadowed() {",
      "  if (true) { var target = () => 1; }",
      "  return target();",
      "}",
      "export function unresolved() { return foo(); }",
    ].join("\n"),
  };
  const paths = Object.keys(files).filter(path => path.endsWith(".ts"));
  const discovery: Discovery = {
    sourceFiles: paths,
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }],
    unitByFile: new Map(paths.map(path => [path, "pkg/a"])),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const extraction = extractArchitecture({ discovery, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  const calls = extraction.relations.filter(relation => relation.kind === "calls");
  assert.ok(calls.some(relation => relation.from === "code:pkg-a-src-use-ts:outer" && relation.to === "code:pkg-a-src-root-ts:target"));
  assert.equal(calls.some(relation => relation.from === "code:pkg-a-src-use-ts:varShadowed"), false);
  assert.equal(extraction.relations.some(relation => relation.from === "code:pkg-a-src-use-ts:unresolved"), false);
});

test("manifest exposure distinguishes module exports, public API re-exports, and bin entrypoints", () => {
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/package.json": JSON.stringify({ exports: "./src/index.ts", main: "./missing.js", types: "./src/index.ts", bin: "./src/cli.ts" }),
    "pkg/a/src/internal.ts": "export function helper() {}\nexport function api() {}\n",
    "pkg/a/src/index.ts": "export { api as publicApi } from './internal.js';\n",
    "pkg/a/src/cli.ts": "export function run() {}\n",
  };
  const paths = ["pkg/a/src/internal.ts", "pkg/a/src/index.ts", "pkg/a/src/cli.ts"];
  const discovery: Discovery = { sourceFiles: paths, units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }], unitByFile: new Map(paths.map(path => [path, "pkg/a"])), unitByPackageName: new Map([["@acme/a", "pkg/a"]]), summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] } };
  const extraction = extractArchitecture({ discovery, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  assert.deepEqual(byId.get("code:pkg-a-src-internal-ts:helper")!.exposure?.map(value => value.kind), ["moduleExport"]);
  assert.deepEqual(byId.get("code:pkg-a-src-internal-ts:api")!.exposure?.map(value => value.kind).sort(), ["moduleExport", "publicApi"]);
  assert.deepEqual(byId.get("code:pkg-a-src-cli-ts:run")!.exposure?.map(value => value.kind).sort(), ["moduleExport"]);
  const snapshot = adaptArchitectureExtraction(extraction, { snapshotId: "snapshot:acme", repositoryId: "repo:acme", commitSha: "abc123", generatedAt: "2026-01-01T00:00:00.000Z" });
  const publicEvidence = snapshot.entities.find(entity => entity.id === "code:pkg-a-src-internal-ts:api")!.exposure!.find(value => value.kind === "publicApi")!.evidence;
  assert.equal(publicEvidence.source.path, "pkg/a/package.json");
  assert.equal(publicEvidence.source.commitSha, "abc123");
  assert.equal(publicEvidence.reason, "package entrypoint export");
});

test("component names are container-relative while ids and evidence keep the full path", () => {
  const extraction = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile: readSynthetic,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const component = extraction.entities.find(entity => entity.id === "component:pkg-a-src-index-ts")!;
  assert.equal(component.name, "src/index.ts");
  assert.equal(component.sourceRefs[0]!.path, "pkg/a/src/index.ts");
});

test("a relative import escaping the discovered set maps to the owning unit as a container edge", () => {
  const discovery: Discovery = {
    sourceFiles: ["apps/web/src/adapter.ts"],
    units: [
      { kind: "member", dir: "apps/web", name: "@acme/web", packageName: "@acme/web", evidencePath: "apps/web", packageManifest: "apps/web/package.json" },
      { kind: "rust", dir: "crates/engine-wasm", name: "engine-wasm", evidencePath: "crates/engine-wasm", packageManifest: undefined },
    ],
    unitByFile: new Map([["apps/web/src/adapter.ts", "apps/web"]]),
    unitByPackageName: new Map([["@acme/web", "apps/web"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "apps/web/src/adapter.ts": "import init from '../../../crates/engine-wasm/pkg/engine_wasm.js';\nexport const boot = init;\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const edge = extraction.relations.find(relation =>
    relation.from === "container:apps-web" && relation.to === "container:crates-engine-wasm");
  assert.ok(edge, "expected apps/web → crates/engine-wasm container edge from the escaped relative import");
  assert.equal(edge!.evidence[0]!.source.path, "apps/web/src/adapter.ts");
});

test("cargoPathDependencies reads inline tables, subsections, and target-scoped sections; skips dev deps", () => {
  const manifest = [
    "[package]",
    'name = "engine-wasm"',
    "",
    "[dependencies]",
    'engine-core = { path = "../engine-core" }',
    "serde.workspace = true",
    "",
    "[dependencies.protocol]",
    'path = "../protocol"',
    "",
    "[target.'cfg(target_arch = \"wasm32\")'.dependencies]",
    'bindgen-helper = { version = "1", path = "../bindgen-helper" }',
    "",
    "[dev-dependencies]",
    'test-util = { path = "../test-util" }',
  ].join("\n");
  assert.deepEqual(cargoPathDependencies(manifest).map(dep => [dep.name, dep.path]), [
    ["engine-core", "../engine-core"],
    ["protocol", "../protocol"],
    ["bindgen-helper", "../bindgen-helper"],
  ]);
});

test("Cargo path dependencies become container edges between crate units", () => {
  const discovery: Discovery = {
    sourceFiles: [],
    units: [
      { kind: "rust", dir: "crates/engine-wasm", name: "engine-wasm", evidencePath: "crates/engine-wasm", packageManifest: undefined },
      { kind: "rust", dir: "crates/engine-core", name: "engine-core", evidencePath: "crates/engine-core", packageManifest: undefined },
    ],
    unitByFile: new Map(),
    unitByPackageName: new Map(),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "crates/engine-wasm/Cargo.toml": '[dependencies]\nengine-core = { path = "../engine-core" }\n',
    "crates/engine-core/Cargo.toml": "[dependencies]\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const edge = extraction.relations.find(relation =>
    relation.from === "container:crates-engine-wasm" && relation.to === "container:crates-engine-core");
  assert.ok(edge, "expected engine-wasm → engine-core edge from Cargo path dependency");
  assert.equal(edge!.evidence[0]!.source.path, "crates/engine-wasm/Cargo.toml");
  assert.equal(edge!.evidence[0]!.source.startLine, 2);
});

test("languageTagForScanPath maps observed extensions; jsx is JavaScript, tsx is TypeScript", () => {
  assert.equal(languageTagForScanPath("apps/web/src/App.tsx"), "TypeScript");
  assert.equal(languageTagForScanPath("packages/scan/src/excerpt.ts"), "TypeScript");
  assert.equal(languageTagForScanPath("scripts/build-wasm.mjs"), "JavaScript");
  assert.equal(languageTagForScanPath("crates/atlas-engine/src/lod.rs"), "Rust");
  assert.equal(languageTagForScanPath("README.md"), undefined);
});

test("observed language tags land on system, containers, and file components (CLA-102)", () => {
  const discovery: Discovery = {
    sourceFiles: ["pkg/app/src/a.ts", "pkg/app/src/widget.tsx", "scripts/build.mjs", "crates/engine/src/lib.rs"],
    units: [
      { kind: "member", dir: "pkg/app", name: "@acme/app", packageName: "@acme/app", evidencePath: "pkg/app", packageManifest: "pkg/app/package.json" },
      { kind: "tooling", dir: "tooling", name: "Build tooling", evidencePath: "scripts", packageManifest: undefined },
      { kind: "rust", dir: "crates/engine", name: "engine", evidencePath: "crates/engine", packageManifest: undefined },
    ],
    unitByFile: new Map([
      ["pkg/app/src/a.ts", "pkg/app"],
      ["pkg/app/src/widget.tsx", "pkg/app"],
      ["scripts/build.mjs", "tooling"],
      ["crates/engine/src/lib.rs", "crates/engine"],
    ]),
    unitByPackageName: new Map([["@acme/app", "pkg/app"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/app/src/a.ts": "export const a = 1;\n",
    "pkg/app/src/widget.tsx": "export const Widget = () => null;\n",
    "scripts/build.mjs": "export const build = 1;\n",
    "crates/engine/Cargo.toml": "[dependencies]\n",
    "crates/engine/src/lib.rs": "pub fn boot() {}\n",
  };
  const extraction = extractArchitecture({
    discovery,
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  assert.deepEqual(byId.get("system:acme")!.technology, ["TypeScript", "JavaScript", "Rust"]);
  assert.deepEqual(byId.get("container:pkg-app")!.technology, ["TypeScript"]);
  assert.deepEqual(byId.get("container:tooling")!.technology, ["JavaScript"]);
  assert.deepEqual(byId.get("container:crates-engine")!.technology, ["Rust"]);
  assert.deepEqual(byId.get("component:pkg-app-src-a-ts")!.technology, ["TypeScript"]);
  assert.deepEqual(byId.get("component:pkg-app-src-widget-tsx")!.technology, ["TypeScript"]);
  assert.deepEqual(byId.get("component:scripts-build-mjs")!.technology, ["JavaScript"]);
  assert.deepEqual(byId.get("component:crates-engine-src-lib-rs")!.technology, ["Rust"]);
  assert.ok(extraction.entities.some(entity => entity.parentId === "container:crates-engine"), "Rust crate drills to L3 file-components");
  assert.equal(byId.get("code:pkg-app-src-a-ts:a")!.technology, undefined, "L4 stays untagged — language lives on the file card");
});

function declarationNamed(source: string, name: string) {
  const file = parseSource("m.ts", source);
  const declaration = topLevelDeclarations(file).find(item => item.name === name);
  assert.ok(declaration, `expected top-level declaration ${name}`);
  return declaration!;
}

test("McCabe cyclomatic walks the same createSourceFile tree as L4 minting", () => {
  assert.equal(CYCLOMATIC_FLAG_THRESHOLD, 6, "product flag is Complexity Kink ~6.5, not McCabe 10");
  assert.equal(cyclomaticForDeclaration(declarationNamed("export function simple() { return 1; }\n", "simple")), 1);
  assert.equal(
    cyclomaticForDeclaration(declarationNamed(
      "export function branched(x: number) {\n  if (x > 0) return 1;\n  if (x < 0) return -1;\n  return 0;\n}\n",
      "branched",
    )),
    3,
  );
  assert.equal(
    cyclomaticForDeclaration(declarationNamed(
      "export const gate = (a: boolean, b: boolean, c: boolean) => a && b || c;\n",
      "gate",
    )),
    3,
  );
  assert.equal(
    cyclomaticForDeclaration(declarationNamed(
      [
        "export function pick(x: number) {",
        "  switch (x) {",
        "    case 1: return 'a';",
        "    case 2: return 'b';",
        "    default: return 'c';",
        "  }",
        "}",
      ].join("\n"),
      "pick",
    )),
    3,
  );
  // Nested helpers are their own CFG; they are not L4 nodes, so they are omitted
  // rather than folded into the outer function (classic McCabe).
  assert.equal(
    cyclomaticForDeclaration(declarationNamed(
      "export function outer() { function inner() { if (true) { return 1; } } if (false) { return 0; } }\n",
      "outer",
    )),
    2,
  );
  assert.equal(
    cyclomaticForDeclaration(declarationNamed(
      "export function withCallback(items: number[]) { return items.map(item => item > 0 ? item : 0); }\n",
      "withCallback",
    )),
    1,
  );
  assert.equal(cyclomaticForDeclaration(declarationNamed("export declare function ambient(x: number): number;\n", "ambient")), undefined);
  assert.equal(cyclomaticForDeclaration(declarationNamed("export type Alias = string;\n", "Alias")), undefined);
  assert.equal(cyclomaticForDeclaration(declarationNamed("export interface Box { x: number }\n", "Box")), undefined);
  assert.equal(cyclomaticForDeclaration(declarationNamed("export class Cls { m() { if (true) { return 1; } } }\n", "Cls")), undefined);
  assert.equal(cyclomaticForDeclaration(declarationNamed("export const A = 1;\n", "A")), undefined);
  assert.equal(cyclomaticComplexity(parseSource("m.ts", "const x = 1;\n")), 1);
});

test("cyclomatic flags complexity > 6 and leaves 6 unflagged", () => {
  const sixIfs = Array.from({ length: 5 }, (_, index) => `  if (x === ${index}) return ${index};`).join("\n");
  const sevenIfs = Array.from({ length: 6 }, (_, index) => `  if (x === ${index}) return ${index};`).join("\n");
  const atThreshold = cyclomaticForDeclaration(declarationNamed(`export function atSix(x: number) {\n${sixIfs}\n  return x;\n}\n`, "atSix"));
  const overThreshold = cyclomaticForDeclaration(declarationNamed(`export function overSix(x: number) {\n${sevenIfs}\n  return x;\n}\n`, "overSix"));
  assert.equal(atThreshold, 6);
  assert.equal(overThreshold, 7);
  assert.equal(cyclomaticIsFlagged(atThreshold!), false);
  assert.equal(cyclomaticIsFlagged(overThreshold!), true);
  assert.equal(cyclomaticIsFlagged(10), true, "McCabe 10 is above the product flag, not the threshold itself");
});

test("extract attaches McCabe on existing code entities and does not mint new ones", () => {
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/src/index.ts": [
      "export function alpha() { return 1; }",
      "export const A = 1;",
      "export type Alias = string;",
      "export function tangled(x: number) {",
      "  if (x === 1) return 1;",
      "  if (x === 2) return 2;",
      "  if (x === 3) return 3;",
      "  if (x === 4) return 4;",
      "  if (x === 5) return 5;",
      "  if (x === 6) return 6;",
      "  return x;",
      "}",
    ].join("\n"),
    "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  };
  const collected = collectExtractedArchitecture({
    discovery: syntheticDiscovery(),
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const extraction = collected.extraction;
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  assert.ok(extraction.entities.every(entity => !("cyclomaticComplexity" in entity)), "extraction stays overlay-free");
  const ids = extraction.entities.map(entity => entity.id).sort();
  const baseline = extractArchitecture({
    discovery: syntheticDiscovery(),
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(baseline.entities.map(entity => entity.id).sort(), ids);
  const alpha = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const tangled = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:tangled")!;
  const alias = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alias")!;
  const constant = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:a")!;
  const cls = extraction.entities.find(entity => entity.id === "code:pkg-b-src-main-ts:beta")!;
  assert.equal(collected.cyclomaticById.get(alpha.id), 1);
  assert.equal(collected.cyclomaticById.get(tangled.id), 7);
  assert.equal(cyclomaticIsFlagged(collected.cyclomaticById.get(tangled.id)!), true);
  assert.equal(collected.cyclomaticById.has(alias.id), false);
  assert.equal(collected.cyclomaticById.has(constant.id), false);
  assert.equal(collected.cyclomaticById.has(cls.id), false);
  assert.ok([...collected.cyclomaticById.keys()].every(id => ids.includes(id)), "cyclomatic never invents entity ids");
});

test("cyclomatic overlay writes the number onto existing snapshot entities only", () => {
  const snapshot = {
    schemaVersion: 1 as const,
    id: "snapshot:acme",
    repositoryId: "repo:acme",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities: [
      { id: "system:acme", kind: "softwareSystem" as const, name: "Acme", sourceRefs: [] },
      { id: "code:pkg-a-src-index-ts:alpha", kind: "code" as const, name: "alpha", sourceRefs: [] },
      { id: "code:pkg-a-src-index-ts:alias", kind: "code" as const, name: "Alias", sourceRefs: [] },
    ],
    relations: [],
  };
  const overlaid = attachCyclomaticComplexity(snapshot, new Map([
    ["code:pkg-a-src-index-ts:alpha", 1],
    ["code:invented", 9],
  ]));
  assert.deepEqual(overlaid.entities.map(entity => entity.id), snapshot.entities.map(entity => entity.id));
  assert.equal(overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")?.cyclomaticComplexity, 1);
  assert.equal(overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alias")?.cyclomaticComplexity, undefined);
  assert.equal(overlaid.entities.some(entity => entity.id === "code:invented"), false);
});

const cloneSource = (name: string, param: string): string => [
  `export function ${name}(${param}: number): number {`,
  `  if (${param} > 0) {`,
  `    const next = ${param} + 1;`,
  `    if (next % 2 === 0) return next * 3;`,
  `    return next - 1;`,
  `  }`,
  `  return 0;`,
  `}`,
].join("\n");

test("token/AST clone walk matches Type-2 function bodies on the same createSourceFile tree", () => {
  assert.ok(MIN_CLONE_TOKENS >= 16);
  const alpha = cloneFingerprintForDeclaration(declarationNamed(`${cloneSource("alpha", "value")}\n`, "alpha"));
  const beta = cloneFingerprintForDeclaration(declarationNamed(`${cloneSource("beta", "count")}\n`, "beta"));
  const different = cloneFingerprintForDeclaration(declarationNamed([
    "export function gamma(value: number): number {",
    "  if (value < 0) return value;",
    "  return value + 4;",
    "}",
  ].join("\n"), "gamma"));
  assert.ok(alpha);
  assert.equal(alpha, beta, "renamed identifiers still clone");
  assert.notEqual(alpha, different);
  assert.equal(cloneFingerprintForDeclaration(declarationNamed("export function tiny() { return 1; }\n", "tiny")), undefined);
  assert.equal(cloneFingerprintForDeclaration(declarationNamed("export type Alias = string;\n", "Alias")), undefined);
  assert.equal(cloneFingerprintForDeclaration(declarationNamed("export const A = 1;\n", "A")), undefined);
  assert.equal(cloneFingerprintForDeclaration(declarationNamed("export class Cls { m() { if (true) { return 1; } } }\n", "Cls")), undefined);
});

test("extract emits duplicates between existing code ids only and does not mint clone nodes", () => {
  const files: Record<string, string> = {
    "README.md": "# Acme",
    "pkg/a/src/index.ts": `${cloneSource("alpha", "value")}\nexport const A = 1;\nexport type Alias = string;\n`,
    "pkg/b/src/main.ts": `${cloneSource("beta", "count")}\nexport class Beta {}\n`,
  };
  const collected = collectExtractedArchitecture({
    discovery: syntheticDiscovery(),
    readFile: path => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    systemName: "Acme",
    systemSlug: "acme",
  });
  const extraction = collected.extraction;
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  assert.equal(extraction.relations.some(relation => relation.kind === "duplicates"), false, "extraction stays overlay-free");
  const ids = extraction.entities.map(entity => entity.id).sort();
  const alpha = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const beta = extraction.entities.find(entity => entity.id === "code:pkg-b-src-main-ts:beta")!;
  const alias = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alias")!;
  assert.deepEqual(collected.clonePairs, [{ from: alpha.id, to: beta.id }]);
  assert.ok(collected.clonePairs.every(pair => ids.includes(pair.from) && ids.includes(pair.to)));
  assert.equal(ids.includes("code:invented"), false);
  const recomputed = clonePairsFromEntities(extraction.entities, path => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  });
  assert.deepEqual(recomputed, collected.clonePairs);
  assert.equal(alias.kind, "code");
});

test("duplicates overlay writes edges onto existing snapshot ids only", () => {
  const snapshot = {
    schemaVersion: 1 as const,
    id: "snapshot:acme",
    repositoryId: "repo:acme",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities: [
      { id: "system:acme", kind: "softwareSystem" as const, name: "Acme", sourceRefs: [] },
      { id: "code:pkg-a-src-index-ts:alpha", kind: "code" as const, name: "alpha", sourceRefs: [{ path: "pkg/a/src/index.ts", commitSha: "abc123", symbol: "alpha", startLine: 1, endLine: 8 }] },
      { id: "code:pkg-b-src-main-ts:beta", kind: "code" as const, name: "beta", sourceRefs: [{ path: "pkg/b/src/main.ts", commitSha: "abc123", symbol: "beta", startLine: 1, endLine: 8 }] },
    ],
    relations: [],
  };
  const overlaid = attachDuplicateRelations(snapshot, [
    { from: "code:pkg-a-src-index-ts:alpha", to: "code:pkg-b-src-main-ts:beta" },
    { from: "code:invented", to: "code:pkg-a-src-index-ts:alpha" },
    { from: "code:pkg-a-src-index-ts:alpha", to: "system:acme" },
  ]);
  assert.deepEqual(overlaid.entities.map(entity => entity.id), snapshot.entities.map(entity => entity.id));
  assert.equal(overlaid.entities.some(entity => entity.id === "code:invented"), false);
  assert.equal(overlaid.relations.length, 1);
  assert.equal(overlaid.relations[0]!.kind, "duplicates");
  assert.equal(overlaid.relations[0]!.from, "code:pkg-a-src-index-ts:alpha");
  assert.equal(overlaid.relations[0]!.to, "code:pkg-b-src-main-ts:beta");
  assert.equal(overlaid.relations[0]!.label, "duplicates");
  const again = attachDuplicateRelations(overlaid, [
    { from: "code:pkg-a-src-index-ts:alpha", to: "code:pkg-b-src-main-ts:beta" },
  ]);
  assert.deepEqual(again.relations, overlaid.relations);
});

function exposureFixture(manifest: object, sources: Record<string, string>, root = false) {
  const dir = root ? "synthetic-root" : "pkg/a";
  const paths = Object.keys(sources);
  const discovery: Discovery = { sourceFiles: paths, units: [{ kind: root ? "root" : "member", dir, name: "a", packageName: "a", packageManifest: root ? "package.json" : `${dir}/package.json`, evidencePath: root ? "package.json" : dir }], unitByFile: new Map(paths.map(path => [path, dir])), unitByPackageName: new Map([["a", dir]]), summary: { singlePackage: root, includedJs: false, skippedJsFiles: 0, skippedMembers: [] } };
  return extractArchitecture({ discovery, readFile: path => path === (root ? "package.json" : "pkg/a/package.json") ? JSON.stringify(manifest) : sources[path]!, systemName: "Acme", systemSlug: "acme" });
}
test("export-star-only package entrypoints expose reachable public declarations", () => {
  const result = exposureFixture({ exports: "./src/index.ts" }, { "pkg/a/src/index.ts": "export * from './api.js'", "pkg/a/src/api.ts": "export function api() {}" });
  assert.ok(result.entities.find(e => e.name === "api")?.exposure?.some(e => e.kind === "publicApi"));
});
test("package exports supersedes private main and types targets", () => {
  const result = exposureFixture({ exports: "./src/index.ts", main: "./src/private.ts", types: "./src/private.ts" }, { "pkg/a/src/index.ts": "export function api() {}", "pkg/a/src/private.ts": "export function privateHelper() {}" });
  assert.equal(result.entities.find(e => e.name === "privateHelper")?.exposure?.some(e => e.kind === "publicApi"), false);
});
test("bin identifies only the executable file, not uncalled exported functions", () => {
  const result = exposureFixture({ bin: "./src/cli.ts" }, { "pkg/a/src/cli.ts": "export function neverCalled() {}\nconsole.log('cli')" });
  assert.equal(result.entities.find(e => e.name === "neverCalled")?.exposure?.some(e => e.kind === "entryPoint"), false);
  assert.ok(result.entities.find(e => e.kind === "component")?.exposure?.some(e => e.kind === "entryPoint"));
});
test("single package synthetic root resolves actual root manifest exports and bin", () => {
  const result = exposureFixture({ exports: "./src/index.ts", bin: "./src/cli.ts" }, { "src/index.ts": "export function api() {}", "src/cli.ts": "console.log('cli')" }, true);
  assert.ok(result.entities.find(e => e.name === "api")?.exposure?.some(e => e.kind === "publicApi"));
  assert.ok(result.entities.find(e => e.sourceRefs[0]?.path === "src/cli.ts")?.exposure?.some(e => e.kind === "entryPoint"));
});
test("switch lexical declarations shadow outer calls across every case", () => {
  const result = exposureFixture({}, { "pkg/a/src/index.ts": "function target() {}\nfunction run(n: number) { switch(n) { case 0: target(); break; case 1: let target = () => {}; target(); } }\nfunction outside() { target(); }" });
  assert.equal(result.relations.some(r => r.from.endsWith(":run") && r.to.endsWith(":target")), false);
  assert.ok(result.relations.some(r => r.from.endsWith(":outside") && r.to.endsWith(":target") && r.kind === "calls"));
});

// CLA-578: a relative import that resolves to no file and no unit is reported, never silent.
test("unresolved relative imports are recorded with path, line and specifier: sorted, deduplicated", () => {
  const files: Record<string, string> = {
    "pkg/b/src/z.ts": "import { gone } from './missing.js';\nexport const z = gone;\n",
    "pkg/a/src/index.ts": [
      "import { ok } from './ok.js';",
      "import data from '../../../generated/data.json';",
      "import { gone } from './missing.js';",
      "import { gone as again } from './missing.js';",
      "import { gone as same } from './missing.js'; import type { T } from './missing.js';",
      "import { b } from '../../b/src/z.js';",
      "import asset from './logo.svg';",
      "import './gone.css';",
      "import legacy from './legacy.js';",
      "export const all = [ok, data, gone, again, same, b, asset, legacy];",
    ].join("\n"),
    "pkg/a/src/ok.ts": "export const ok = 1;\n",
  };
  const paths = ["pkg/a/src/index.ts", "pkg/a/src/ok.ts", "pkg/b/src/z.ts"];
  const units = [
    { kind: "member" as const, dir: "pkg/a", name: "a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
    { kind: "member" as const, dir: "pkg/b", name: "b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
  ];
  // Tracked but not source: an asset and a `.js` the TS-repo rule skipped.
  const trackedFiles = new Set([...paths, "pkg/a/src/logo.svg", "pkg/a/src/legacy.js"]);
  const discovery: Discovery = { sourceFiles: paths, units, unitByFile: new Map(paths.map(path => [path, path.slice(0, 5)])), unitByPackageName: new Map(), trackedFiles, summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] } };
  const collect = (order: string[]) => collectExtractedArchitecture({ discovery: { ...discovery, sourceFiles: order }, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  const collected = collect(paths);
  assert.deepEqual(collected.unresolvedRelativeImports, [
    { path: "pkg/a/src/index.ts", line: 2, specifier: "../../../generated/data.json" },
    { path: "pkg/a/src/index.ts", line: 3, specifier: "./missing.js" },
    { path: "pkg/a/src/index.ts", line: 4, specifier: "./missing.js" },
    { path: "pkg/a/src/index.ts", line: 5, specifier: "./missing.js" },
    { path: "pkg/a/src/index.ts", line: 8, specifier: "./gone.css" },
    { path: "pkg/b/src/z.ts", line: 1, specifier: "./missing.js" },
  ], "resolved files and tracked non-source files (logo.svg, legacy.js) are not reported; a missing asset is; one entry per (path, line, specifier)");
  assert.deepEqual(collect([...paths].reverse()).unresolvedRelativeImports, collected.unresolvedRelativeImports, "independent of discovery order");
});

// CLA-578 round 2: bundler `?query` / `#fragment` suffixes name the same file.
test("queried relative imports resolve by their path: existing files record an edge or stay quiet; missing ones are reported verbatim", () => {
  const files: Record<string, string> = {
    "pkg/a/src/index.ts": [
      "import Worker from './worker.ts?worker';",
      "import url from './logo.svg?url';",
      "import text from './text.txt?raw';",
      "import gone from './gone.svg?url';",
      "import frag from './frag.css#section';",
      "export const all = [Worker, url, text, gone, frag];",
    ].join("\n"),
    "pkg/a/src/worker.ts": "export const work = 1;\n",
  };
  const paths = ["pkg/a/src/index.ts", "pkg/a/src/worker.ts"];
  const trackedFiles = new Set([...paths, "pkg/a/src/logo.svg", "pkg/a/src/text.txt", "pkg/a/src/frag.css"]);
  const discovery: Discovery = { sourceFiles: paths, units: [{ kind: "member", dir: "pkg/a", name: "a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }], unitByFile: new Map(paths.map(path => [path, "pkg/a"])), unitByPackageName: new Map(), trackedFiles, summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] } };
  const collected = collectExtractedArchitecture({ discovery, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(collected.unresolvedRelativeImports, [
    { path: "pkg/a/src/index.ts", line: 4, specifier: "./gone.svg?url" },
  ], "existing ?url/?raw/#fragment targets are not reported; a missing one keeps its original specifier");
  assert.ok(collected.extraction.relations.some(relation => relation.from === "component:pkg-a-src-index-ts" && relation.to === "component:pkg-a-src-worker-ts"), "./worker.ts?worker records the file-level edge");
});

// CLA-578 round QA.
test("declaration files count as existing import targets: ./types/x -> x.d.ts, ./gen.js -> gen.d.ts, .d.mts", () => {
  const files: Record<string, string> = {
    "pkg/a/src/index.ts": "import type { A } from '../types/anymatch';\nimport type { G } from './gen.js';\nimport type { M } from './esm';\nimport type { N } from './nope';\nexport type All = [A, G, M, N];\n",
  };
  const paths = ["pkg/a/src/index.ts"];
  const trackedFiles = new Set([...paths, "pkg/a/types/anymatch.d.ts", "pkg/a/src/gen.d.ts", "pkg/a/src/esm.d.mts"]);
  const discovery: Discovery = { sourceFiles: paths, units: [{ kind: "member", dir: "pkg/a", name: "a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }], unitByFile: new Map(paths.map(path => [path, "pkg/a"])), unitByPackageName: new Map(), trackedFiles, summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] } };
  const collected = collectExtractedArchitecture({ discovery, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(collected.unresolvedRelativeImports, [{ path: "pkg/a/src/index.ts", line: 4, specifier: "./nope" }]);
});

test("extensionless relative imports resolve to .js/.jsx/.cjs modules and JS directory indexes", () => {
  const files: Record<string, string> = {
    "e2e/esm/dynamicImport.js": "export * from './index';\nexport { V } from './view';\nexport { c } from './common';\nexport { u } from './util';\n",
    "e2e/esm/index.js": "export const i = 1;\n",
    "e2e/esm/view.jsx": "export const V = 1;\n",
    "e2e/esm/common.cjs": "exports.c = 1;\n",
    "e2e/esm/util/index.js": "export const u = 1;\n",
  };
  const paths = Object.keys(files).sort();
  const discovery: Discovery = { sourceFiles: paths, units: [{ kind: "root", dir: "esm", name: "esm", evidencePath: "esm", packageManifest: undefined }], unitByFile: new Map(paths.map(path => [path, "esm"])), unitByPackageName: new Map(), summary: { singlePackage: true, includedJs: true, skippedJsFiles: 0, skippedMembers: [] } };
  const { extraction } = collectExtractedArchitecture({ discovery, readFile: path => files[path]!, systemName: "Acme", systemSlug: "acme" });
  const targets = extraction.relations.filter(relation => relation.from === "component:e2e-esm-dynamic-import-js").map(relation => relation.to).sort();
  assert.deepEqual(targets, ["component:e2e-esm-common-cjs", "component:e2e-esm-index-js", "component:e2e-esm-util-index-js", "component:e2e-esm-view-jsx"]);
});
