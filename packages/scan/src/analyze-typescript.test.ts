import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeTypeScript, compilerMessageRelativizer, relativizeCompilerMessage } from "./analyze-typescript.js";
import { collectExtractedArchitecture } from "./extract.js";
import { discoverExtractedTree } from "./discover.js";

function fixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "okie-semantic-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("compiler resolves aliases, type uses, shadowing and direct call evidence", () => {
  const repo = fixture({
    "package.json": '{"name":"semantic-example"}',
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] }, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["**/*.ts"] }),
    "lib/api.ts": "export function run() { return 1; }\nexport interface Shape { value: number; }",
    "main.ts": "import { run as execute, Shape } from '@lib/api';\nexport function caller(input: Shape) { execute(); const saved = execute; return saved; }\nexport function shadow(execute: () => void) { execute(); }",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const run = analysis.definitions.find(item => item.name === "run")!;
    assert.ok(run);
    assert.deepEqual(analysis.references.filter(item => item.path === "main.ts" && item.symbol === run.symbol).map(item => item.kind).sort(), ["calls", "uses"]);
    const shape = analysis.definitions.find(item => item.name === "Shape")!;
    assert.equal(analysis.references.filter(item => item.symbol === shape.symbol).length, 1);
    assert.ok(!analysis.coverage[0]!.limitations.some(item => item.includes("TS")));
    assert.ok(analysis.coverage[0]!.limitations.some(item => item.includes("dynamic call dispatch")));
    assert.deepEqual(analysis, analyzeTypeScript(repo.root));
    const extraction = collectExtractedArchitecture({ discovery: discoverExtractedTree(repo.root), readFile: path => readFileSync(join(repo.root, path), "utf8"), languageAnalysis: analysis }).extraction;
    const caller = extraction.entities.find(item => item.name === "caller")!;
    const api = extraction.entities.find(item => item.name === "run")!;
    assert.deepEqual(extraction.relations.filter(item => item.from === caller.id && item.to === api.id).map(item => item.kind).sort(), ["calls", "uses"]);
    const shadow = extraction.entities.find(item => item.name === "shadow")!;
    assert.ok(!extraction.relations.some(item => item.from === shadow.id && item.to === shadow.id && item.kind === "calls"));
  } finally { repo.cleanup(); }
});

test("compiler resolves committed workspace package exports without built declarations or symlinks", () => {
  const repo = fixture({
    "package.json": '{"name":"workspace","workspaces":["packages/*"]}',
    "tsconfig.json": '{"files":[],"references":[{"path":"packages/lib"},{"path":"packages/app"}]}',
    "packages/lib/package.json": '{"name":"@example/lib","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"}}}',
    "packages/lib/tsconfig.json": '{"compilerOptions":{"composite":true,"rootDir":"src","outDir":"dist","module":"NodeNext","moduleResolution":"NodeNext"},"include":["src"]}',
    "packages/lib/src/index.ts": "export function api() { return 1; }",
    "packages/app/package.json": '{"name":"@example/app"}',
    "packages/app/tsconfig.json": '{"compilerOptions":{"composite":true,"rootDir":"src","outDir":"dist","module":"NodeNext","moduleResolution":"NodeNext"},"references":[{"path":"../lib"}],"include":["src"]}',
    "packages/app/src/index.ts": "import { api } from '@example/lib';\nexport function caller() { return api(); }",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const api = analysis.definitions.find(item => item.name === "api")!;
    assert.ok(api);
    assert.ok(analysis.references.some(item => item.path === "packages/app/src/index.ts" && item.symbol === api.symbol && item.kind === "calls"), JSON.stringify(analysis));
    assert.ok(!analysis.coverage[0]!.limitations.some(item => item.includes("TS2307")), JSON.stringify(analysis.coverage));
  } finally { repo.cleanup(); }
});

test("missing dependencies are reported instead of invented semantic targets", () => {
  const repo = fixture({ "main.ts": "import { missing } from 'not-installed';\nexport function caller() { missing(); }" });
  try {
    const analysis = analyzeTypeScript(repo.root);
    assert.ok(analysis.coverage[0]!.limitations.some(item => item.includes("TS2307")));
    assert.ok(analysis.coverage[0]!.limitations.some(item => item.includes("Inferred")));
    assert.equal(analysis.references.length, 0);
  } finally { repo.cleanup(); }
});

test("compiler follows cyclic re-exports, namespace members and default aliases deterministically", () => {
  const repo = fixture({
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","target":"ES2022"},"include":["*.ts"]}',
    "api.ts": "export default function primary() { return 1; }\nexport function helper() { return 2; }",
    "barrel-a.ts": "export { default, helper } from './api.js';\nexport * from './barrel-b.js';",
    "barrel-b.ts": "export * from './barrel-a.js';",
    "main.ts": "import entry from './barrel-a.js';\nimport * as api from './barrel-b.js';\nexport function caller() { entry(); api.helper(); return api.helper; }",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const mainReferences = analysis.references.filter(item => item.path === "main.ts");
    const primary = analysis.definitions.find(item => item.name === "default" || item.name === "primary")!;
    const helper = analysis.definitions.find(item => item.name === "helper")!;
    assert.ok(primary);
    assert.ok(helper);
    assert.deepEqual(mainReferences.filter(item => item.symbol === primary.symbol).map(item => item.kind), ["calls"]);
    assert.deepEqual(mainReferences.filter(item => item.symbol === helper.symbol).map(item => item.kind).sort(), ["calls", "uses"]);
    assert.equal(analysis.coverage[0]!.limitations.length, 0);
    assert.deepEqual(analysis, analyzeTypeScript(repo.root));
  } finally { repo.cleanup(); }
});

test("ambiguous dynamic dispatch does not invent a definite call to a candidate or binding", () => {
  const repo = fixture({
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["*.ts"]}',
    "api.ts": "export function left() {}\nexport function right() {}\nexport const chosen = Math.random() ? left : right;\nexport class Left { run() {} }\nexport class Right { run() {} }\nexport function dispatch(value: Left | Right) { chosen(); value.run(); }",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const calls = analysis.references.filter(item => item.kind === "calls");
    assert.equal(calls.length, 0, JSON.stringify(calls));
    assert.ok(analysis.coverage[0]!.limitations.some(item => item.includes("dispatch")));
    const chosen = analysis.definitions.find(item => item.name === "chosen")!;
    assert.ok(analysis.references.some(item => item.symbol === chosen.symbol && item.kind === "uses"));
    assert.deepEqual(analysis, analyzeTypeScript(repo.root));
  } finally { repo.cleanup(); }
});

test("concrete arrow functions and overloaded implementations retain definite calls", () => {
  const repo = fixture({
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["*.ts"]}',
    "api.ts": "export const arrow = () => 1;\nexport function overloaded(value: string): string;\nexport function overloaded(value: number): number;\nexport function overloaded(value: string | number) { return value; }\nexport function caller() { (arrow)(); overloaded(1); }",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const calls = analysis.references.filter(item => item.kind === "calls");
    assert.equal(calls.length, 2);
    const targets = calls.map(call => analysis.definitions.find(definition => definition.symbol === call.symbol)!);
    assert.deepEqual(targets.map(target => target.name).sort(), ["arrow", "overloaded"]);
    assert.equal(targets.find(target => target.name === "overloaded")!.startLine, 4);
    assert.equal(analysis.coverage[0]!.limitations.length, 0);
  } finally { repo.cleanup(); }
});

test("CLA-586: compiler messages name scanned files root-relative and other locations by label", () => {
  const root = "/work/okie-scan-work/okie-committed-Ab12/repo";
  const paths = { checkoutRoot: "/work/okie-scan-work/okie-committed-Ab12", workRoot: "/work/okie-scan-work", installationRoot: "/home/me/repo", home: "/home/me" };
  const relativize = compilerMessageRelativizer(root, paths);
  assert.equal(
    relativize(`File '${root}/lib/b.ts' is not under 'rootDir' '${root}/src'. Root '${root}'. At ${root}.`),
    "File 'lib/b.ts' is not under 'rootDir' 'src'. Root '.'. At ..",
  );
  // Longest prefix wins; a prefix only matches as a whole path, at both ends.
  assert.equal(
    relativize("/home/me/repo/node_modules/x/index.d.ts, /home/me/other, /home/me/repo-old/a.ts, /home/me/repo.bak"),
    "<installation>/node_modules/x/index.d.ts, <home>/other, <home>/repo-old/a.ts, <home>/repo.bak",
  );
  assert.equal(relativize("'/Volumes/X/home/me/a.ts'"), "'/Volumes/X/home/me/a.ts'");
  // A root-relative path is never written into a URL; a label is.
  assert.equal(relativize(`file://${root}/a.ts`), `file://${root}/a.ts`);
  assert.equal(relativize("file:///home/me/repo/x.d.ts file:///home/me/y"), "file://<installation>/x.d.ts file://<home>/y");
  assert.equal(relativize(`${root}-sibling/a.ts`), "../repo-sibling/a.ts");
  // Anything else under the scan's checkout or work dir is root-relative too, at any depth.
  assert.equal(
    relativize("Cannot read file '/work/okie-scan-work/okie-committed-Ab12/missing/tsconfig.json'; '/work/okie-scan-work/okie-base.json'; '/work/okie-scan-work'"),
    "Cannot read file '../missing/tsconfig.json'; '../../okie-base.json'; '../..'",
  );
  assert.equal(
    relativizeCompilerMessage("/gh/okie-scan-gh-x/repo.tar.gz /gh/okie-scan-gh-xy", "/gh/okie-scan-gh-x/tree/top", { checkoutRoot: "/gh/okie-scan-gh-x" }),
    "../../repo.tar.gz /gh/okie-scan-gh-xy",
  );
  // A work dir that does not contain the root (a test's own temp root) is a label, never `../../../…`.
  assert.equal(relativizeCompilerMessage("/srv/work/x.json", "/tmp/repo", { workRoot: "/srv/work" }), "<work-root>/x.json");
});
