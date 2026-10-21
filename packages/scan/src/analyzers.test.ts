import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzerPlatform, loadAnalyzers, rustParser, rustParserUnavailable, ts } from "./analyzers.js";

const installedVersion = (name: string): string =>
  (JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")) as { version: string }).version;

test("loadAnalyzers reports the resolved analyser versions, Rust only when asked", () => {
  const typescriptOnly = loadAnalyzers();
  assert.deepEqual(typescriptOnly, { ok: true, versions: { typescript: installedVersion("typescript") }, errors: [], platform: analyzerPlatform() });
  const withRust = loadAnalyzers({ rust: true });
  assert.deepEqual(withRust.versions, {
    typescript: installedVersion("typescript"),
    "tree-sitter": installedVersion("tree-sitter"),
    "tree-sitter-rust": installedVersion("tree-sitter-rust"),
  });
  assert.equal(withRust.ok, true);
  assert.match(withRust.platform, new RegExp(`^${process.platform}-${process.arch} \\(node abi \\d+\\)$`));
});

test("the lazy TypeScript API and the shared Rust parser behave like the packages themselves", () => {
  assert.equal(ts.version, installedVersion("typescript"));
  assert.ok("SyntaxKind" in ts);
  const source = ts.createSourceFile("a.ts", "export const x = 1;", ts.ScriptTarget.Latest, true);
  assert.ok(ts.isVariableStatement(source.statements[0]!));
  assert.equal(rustParserUnavailable(), undefined);
  assert.equal(rustParser(), rustParser());
  assert.equal(rustParser().parse("pub fn f() {}").rootNode.namedChildren[0]?.type, "function_item");
});
