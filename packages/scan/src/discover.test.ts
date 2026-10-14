import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cargoWorkspaceMembers, discoverExtractedTree, discoverRepository } from "./discover.js";
import { discoveryLimitations, scanRepository, UNRESOLVED_IMPORTS_SHOWN, unresolvedImportLimitations } from "./scan.js";

/** Builds a tiny staged git repo (git ls-files sees staged files — no commit needed). */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [relative, content] of Object.entries(files)) {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}

function withRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = makeRepo(files);
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("single-package repo (no workspace) becomes one root container named from package.json", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "acme-lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/util.ts": "export function y() {}\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.singlePackage, true);
    const root = discovery.units.find(unit => unit.kind === "root")!;
    assert.ok(root, "one root container");
    assert.equal(root.dir, "acme-lib");
    assert.equal(root.name, "acme-lib");
    assert.equal(root.evidencePath, "package.json");
    assert.ok(!discovery.units.some(unit => unit.kind === "tooling"), "no synthetic tooling container");
    assert.deepEqual([...new Set(discovery.unitByFile.values())], ["acme-lib"]);
    assert.deepEqual(discovery.sourceFiles, ["src/index.ts", "src/util.ts"]);
  });
});

test("discovers .mts/.cts/.cjs/.jsx and hand-written .js in a TS repo; a pure-JS repo includes every .js", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "m" }),
    "tsconfig.json": "{}",
    "a.mts": "export const a = 1;\n",
    "b.cts": "export const b = 1;\n",
    "c.cjs": "module.exports = {};\n",
    "d.jsx": "export const D = 1;\n",
    "e.ts": "export const e = 1;\n",
    "legacy.js": "module.exports = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    for (const file of ["a.mts", "b.cts", "c.cjs", "d.jsx", "e.ts", "legacy.js"]) assert.ok(discovery.sourceFiles.includes(file), `${file} discovered`);
    assert.equal(discovery.summary.includedJs, false, "a TS repo filters .js");
    assert.equal(discovery.summary.skippedJsFiles, 0);
    assert.equal("skippedJsByReason" in discovery.summary, false, "absent when nothing was skipped");
  });
  withRepo({
    "package.json": JSON.stringify({ name: "j" }),
    "index.js": "module.exports = 1;\n",
    "lib.mjs": "export const x = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.includedJs, true, "pure-JS repo (no tsconfig, no TS source) includes .js");
    assert.ok(discovery.sourceFiles.includes("index.js"));
    assert.equal(discovery.summary.skippedJsFiles, 0);
  });
});

test("excludes *.spec.*, __tests__/, __mocks__/, *.bench.*, rust tests/ and *_qa.rs", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "m" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/index.spec.ts": "1;\n",
    "src/foo.test.ts": "1;\n",
    "src/bar.bench.ts": "1;\n",
    "src/__tests__/z.ts": "1;\n",
    "src/__mocks__/m.ts": "1;\n",
    "crates/engine/Cargo.toml": "[package]\nname = \"engine\"\n",
    "crates/engine/src/lib.rs": "pub fn f() {}\n",
    "crates/engine/src/lib_qa.rs": "fn qa() {}\n",
    "crates/engine/tests/smoke.rs": "fn smoke() {}\n",
    "crates/engine/src/hit_test.rs": "pub fn hit_test() {}\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.sourceFiles, ["crates/engine/src/hit_test.rs", "crates/engine/src/lib.rs", "src/index.ts"]);
    assert.equal(discovery.unitByFile.get("crates/engine/src/lib.rs"), "crates/engine");
  });
});

test("skips fixture/example/playground/e2e members with a summary count; --include-members overrides", () => {
  const files = {
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - 'playground/*'\n",
    "package.json": JSON.stringify({ name: "root" }),
    "tsconfig.json": "{}",
    "packages/core/package.json": JSON.stringify({ name: "@x/core" }),
    "packages/core/src/index.ts": "export const x = 1;\n",
    "playground/demo/package.json": JSON.stringify({ name: "demo" }),
    "playground/demo/src/app.ts": "export const y = 1;\n",
  };
  withRepo(files, dir => {
    const discovery = discoverRepository(dir);
    assert.ok(discovery.units.some(unit => unit.dir === "packages/core"), "real member kept");
    assert.ok(!discovery.units.some(unit => unit.dir === "playground/demo"), "playground member skipped");
    assert.deepEqual(discovery.summary.skippedMembers, ["playground/demo"]);
    assert.ok(!discovery.sourceFiles.includes("playground/demo/src/app.ts"), "fixture files dropped");

    const included = discoverRepository(dir, { includeAllMembers: true });
    assert.ok(included.units.some(unit => unit.dir === "playground/demo"), "--include-members scans it");
    assert.equal(included.summary.skippedMembers.length, 0);
  });
});

test("system name derives from root package.json name (fix 6)", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "cool-lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
  }, dir => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    const artifacts = scanRepository(dir);
    assert.equal(artifacts.snapshot.entities.find(entity => entity.kind === "softwareSystem")?.name, "cool-lib");
  });
});

/** Writes a plain (non-git) directory tree — the shape an extracted tarball has (no .git). */
function withTree(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-scan-tree-"));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const full = join(dir, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function comparableDiscovery(discovery: ReturnType<typeof discoverRepository>) {
  return {
    sourceFiles: discovery.sourceFiles,
    units: discovery.units,
    unitByFile: [...discovery.unitByFile.entries()].sort(),
    unitByPackageName: [...discovery.unitByPackageName.entries()].sort(),
    summary: discovery.summary,
  };
}

test("tarball walk (discoverExtractedTree) equals git discovery on identical content — provider parity", () => {
  // A workspace repo exercising members, tooling (a non-member script), and a Rust crate.
  const files = {
    "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    "package.json": JSON.stringify({ name: "root" }),
    "tsconfig.json": "{}",
    "apps/web/package.json": JSON.stringify({ name: "@x/web" }),
    "apps/web/src/main.tsx": "export const App = 1;\n",
    "packages/core/package.json": JSON.stringify({ name: "@x/core" }),
    "packages/core/src/index.ts": "export const x = 1;\n",
    "scripts/build.mjs": "export const build = 1;\n",
    "crates/engine/Cargo.toml": "[package]\nname = \"engine\"\n",
    "crates/engine/src/lib.rs": "pub fn f() {}\n",
  };
  withRepo(files, dir => {
    // Same directory: git sees tracked files; the walk skips .git and sees the same set.
    assert.deepEqual(comparableDiscovery(discoverExtractedTree(dir)), comparableDiscovery(discoverRepository(dir)));
    const tarball = discoverExtractedTree(dir);
    assert.ok(tarball.units.some(unit => unit.dir === "apps/web"), "member from tarball walk");
    assert.ok(tarball.units.some(unit => unit.kind === "tooling"), "tooling from tarball walk");
    assert.ok(tarball.units.some(unit => unit.kind === "rust" && unit.dir === "crates/engine"), "rust crate from tarball walk");
    assert.ok(tarball.sourceFiles.includes("crates/engine/src/lib.rs"), "crate .rs files are scanned");
    assert.equal(tarball.unitByFile.get("crates/engine/src/lib.rs"), "crates/engine");
  });
});

test("tarball walk applies the same extension/exclusion filters and skips node_modules", () => {
  withTree({
    "package.json": JSON.stringify({ name: "lib" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/index.spec.ts": "1;\n",
    "src/legacy.js": "module.exports = 1;\n",
    "src/bundle.min.js": "1;\n",
    "dist/index.js": "1;\n",
    "types.d.ts": "export {};\n",
    "node_modules/dep/index.ts": "export const dep = 1;\n",
  }, dir => {
    const discovery = discoverExtractedTree(dir);
    assert.deepEqual(discovery.sourceFiles, ["src/index.ts", "src/legacy.js"]);
    assert.equal(discovery.summary.skippedJsFiles, 1, "minified .js counted, not silently dropped");
    assert.deepEqual(discovery.summary.skippedJsByReason, { testOrVendorDirectory: 0, minified: 1, compiledSibling: 0 });
    assert.ok(!discovery.sourceFiles.some(f => f.startsWith("node_modules/")), "node_modules never walked");
  });
});

test("tarball walk supports a single-package (non-workspace) repo", () => {
  withTree({
    "package.json": JSON.stringify({ name: "solo" }),
    "tsconfig.json": "{}",
    "index.ts": "export const x = 1;\n",
  }, dir => {
    const discovery = discoverExtractedTree(dir);
    assert.equal(discovery.summary.singlePackage, true);
    assert.equal(discovery.units.find(unit => unit.kind === "root")?.name, "solo");
    assert.deepEqual(discovery.sourceFiles, ["index.ts"]);
  });
});

test("conventional testdata/ directories are excluded and counted (CLA-299)", () => {
  const files = {
    "package.json": JSON.stringify({ name: "compiler" }),
    "tsconfig.json": "{}",
    "src/checker.ts": "export const check = 1;\n",
    "tsc/testdata/tests/cases/await-using.ts": "await using x = y;\n",
    "tsc/testdata/baselines/reference/a.js": "1;\n",
    "testdata/fixture.tsx": "export {};\n",
    // Already excluded by the per-file rules: never counted as a testdata exclusion.
    "tsc/testdata/lib.d.ts": "export {};\n",
    "tsc/testdata/runner.test.ts": "1;\n",
    "src/testdata-helpers.ts": "export const helper = 1;\n",
  };
  withRepo(files, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.sourceFiles, ["src/checker.ts", "src/testdata-helpers.ts"], "only a testdata/ DIRECTORY is excluded");
    assert.equal(discovery.summary.excludedTestDataFiles, 3, "only files newly excluded by the testdata rule are counted (.d.ts / *.test.ts were already out; a TS repo scans .js, so testdata .js counts)");
  });
  withTree(files, dir => assert.equal(discoverExtractedTree(dir).summary.excludedTestDataFiles, 3));
  withRepo({ "package.json": JSON.stringify({ name: "plain" }), "index.ts": "export {};\n" }, dir => {
    assert.equal("excludedTestDataFiles" in discoverRepository(dir).summary, false, "absent when nothing was excluded");
    assert.equal("skippedEntries" in discoverRepository(dir).summary, false);
  });
});

// CLA-578: workspace declarations beyond pnpm-workspace.yaml.

const memberDirs = (dir: string): string[] => discoverRepository(dir).units.filter(unit => unit.kind === "member").map(unit => unit.dir);

test("root package.json workspaces (array form) declares members", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*", "./apps/web/"] }),
    "tsconfig.json": "{}",
    "packages/a/package.json": JSON.stringify({ name: "@m/a" }),
    "packages/a/src/index.ts": "export const a = 1;\n",
    "apps/web/package.json": JSON.stringify({ name: "@m/web" }),
    "apps/web/src/main.ts": "export const web = 1;\n",
    "apps/other/package.json": JSON.stringify({ name: "@m/other" }),
    "apps/other/src/main.ts": "export const other = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.singlePackage, false);
    assert.deepEqual(memberDirs(dir), ["apps/web", "packages/a"], "./ prefix and trailing / are normalized; undeclared apps/other is not a member");
    assert.equal(discovery.unitByPackageName.get("@m/a"), "packages/a");
  });
});

test("root package.json workspaces (yarn object form) declares members; nohoist is ignored", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mono", workspaces: { packages: ["libs/**"], nohoist: ["**/react-native"] } }),
    "libs/core/package.json": JSON.stringify({ name: "@m/core" }),
    "libs/core/index.ts": "export const core = 1;\n",
    "libs/ui/button/package.json": JSON.stringify({ name: "@m/button" }),
    "libs/ui/button/index.ts": "export const button = 1;\n",
  }, dir => assert.deepEqual(memberDirs(dir), ["libs/core", "libs/ui/button"], "`**` matches nested member dirs"));
});

test("pnpm-workspace.yaml and package.json workspaces: union of includes, negations applied after", () => {
  withRepo({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!packages/legacy'\n",
    "package.json": JSON.stringify({ name: "mono", workspaces: ["apps/*", "!apps/admin"] }),
    "packages/a/package.json": JSON.stringify({ name: "@m/a" }),
    "packages/a/index.ts": "export const a = 1;\n",
    "packages/legacy/package.json": JSON.stringify({ name: "@m/legacy" }),
    "packages/legacy/index.ts": "export const legacy = 1;\n",
    "apps/web/package.json": JSON.stringify({ name: "@m/web" }),
    "apps/web/index.ts": "export const web = 1;\n",
    "apps/admin/package.json": JSON.stringify({ name: "@m/admin" }),
    "apps/admin/index.ts": "export const admin = 1;\n",
  }, dir => {
    assert.deepEqual(memberDirs(dir), ["apps/web", "packages/a"], "members from both files; each file's negation removes a member");
    const discovery = discoverRepository(dir);
    assert.equal(discovery.unitByFile.get("packages/legacy/index.ts"), "\0tooling", "a negated member's files fall to the tooling bucket");
  });
});

test("cargoWorkspaceMembers reads members/exclude: globs, paths, multi-line arrays, comments, quotes", () => {
  const manifest = [
    "[package]",
    'name = "root" # members = ["nope"]',
    "",
    "[workspace]",
    'resolver = "2"',
    "members = [",
    '  "crates/*", # glob',
    "  'tools/gen',",
    '  "engine/#core",',
    "  # \"commented/out\",",
    "]",
    'exclude = ["crates/scratch"]',
    "",
    "[workspace.package]",
    'members = ["not/workspace"]',
    "",
    "[[bin]]",
    'name = "x"',
  ].join("\n");
  assert.deepEqual(cargoWorkspaceMembers(manifest), { members: ["crates/*", "tools/gen", "engine/#core"], exclude: ["crates/scratch"] });
  assert.deepEqual(cargoWorkspaceMembers('[package]\nname = "solo"\n'), { members: [], exclude: [] });
});

test("root Cargo.toml [workspace] members decide Rust crates (globs, paths, exclude, tracked manifest only)", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mixed" }),
    "Cargo.toml": '[workspace]\nmembers = [\n  "crates/*",\n  "tools/gen", # a plain path\n  "rust/*",\n]\nexclude = ["crates/scratch"]\n',
    "crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
    "crates/engine/src/lib.rs": "pub fn run() {}\n",
    "crates/scratch/Cargo.toml": '[package]\nname = "scratch"\n',
    "crates/scratch/src/lib.rs": "pub fn scratch() {}\n",
    "tools/gen/Cargo.toml": '[package]\nname = "gen"\n',
    "tools/gen/src/main.rs": "fn main() {}\n",
    "rust/no-manifest/src/lib.rs": "pub fn orphan() {}\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.units.filter(unit => unit.kind === "rust").map(unit => unit.dir), ["crates/engine", "tools/gen"]);
    assert.equal(discovery.unitByFile.get("tools/gen/src/main.rs"), "tools/gen", "a member outside crates/ is a crate unit");
    assert.notEqual(discovery.unitByFile.get("crates/scratch/src/lib.rs"), "crates/scratch", "an excluded member is not a crate unit");
    assert.notEqual(discovery.unitByFile.get("rust/no-manifest/src/lib.rs"), "rust/no-manifest", "a matched dir without a tracked Cargo.toml is not a crate");
  });
});

test("without declared [workspace] members, crates/*/Cargo.toml is the Rust crate fallback", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mixed" }),
    "Cargo.toml": '[workspace]\nresolver = "2"\n',
    "crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
    "crates/engine/src/lib.rs": "pub fn run() {}\n",
    "tools/gen/Cargo.toml": '[package]\nname = "gen"\n',
    "tools/gen/src/main.rs": "fn main() {}\n",
  }, dir => {
    assert.deepEqual(discoverRepository(dir).units.filter(unit => unit.kind === "rust").map(unit => unit.dir), ["crates/engine"]);
  });
});

// CLA-578: `.js` in a TypeScript repo.

test("TS repo scans hand-written .js; skips test/vendor dirs, *.min.js and compiled siblings, counted by reason", () => {
  const files = {
    "package.json": JSON.stringify({ name: "m" }),
    "tsconfig.json": "{}",
    "src/index.ts": "export const x = 1;\n",
    "src/index.js": "exports.x = 1;\n",
    "src/view.tsx": "export const View = 1;\n",
    "src/view.js": "exports.View = 1;\n",
    "src/legacy.js": "module.exports = 1;\n",
    "src/typed.js": "module.exports = 1;\n",
    "src/typed.d.ts": "export declare const typed: number;\n",
    "src/lib/chart.min.js": "1;\n",
    "test/helper.js": "1;\n",
    "src/tests/setup.js": "1;\n",
    "src/fixture/a.js": "1;\n",
    "src/fixtures/b.js": "1;\n",
    "src/__fixtures__/c.js": "1;\n",
    "vendor/jquery.js": "1;\n",
    "third_party/lib.js": "1;\n",
    "contest/entry.js": "1;\n",
    "vendored-ui/button.js": "1;\n",
    "vendor/keep.mjs": "export const keep = 1;\n",
    "test/keep.cjs": "module.exports = 1;\n",
    "dist/out.js": "1;\n",
  };
  const check = (discovery: ReturnType<typeof discoverRepository>): void => {
    assert.deepEqual(discovery.sourceFiles, [
      "contest/entry.js",
      "src/index.ts",
      "src/legacy.js",
      "src/typed.js",
      "src/view.tsx",
      "test/keep.cjs",
      "vendor/keep.mjs",
      "vendored-ui/button.js",
    ], "whole-segment dirs only; a .d.ts alone does not make a .js compiled; .mjs/.cjs always scanned");
    assert.equal(discovery.summary.includedJs, false);
    assert.equal(discovery.summary.skippedJsFiles, 10);
    assert.deepEqual(discovery.summary.skippedJsByReason, { testOrVendorDirectory: 7, minified: 1, compiledSibling: 2 });
    assert.deepEqual(discoveryLimitations(discovery.summary), [
      "10 .js file(s) in this TypeScript repository were not scanned: 7 under a test/fixture/vendor directory; 1 minified (*.min.js); 2 compiled output beside a .ts/.tsx source.",
    ]);
  };
  withRepo(files, dir => check(discoverRepository(dir)));
  withTree(files, dir => check(discoverExtractedTree(dir)));
});

test("a pure-JS repo still scans every .js (min, test/ and vendor/ included)", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "j" }),
    "index.js": "module.exports = 1;\n",
    "lib/chart.min.js": "1;\n",
    "vendor/jquery.js": "1;\n",
    "test/helper.js": "1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.summary.includedJs, true);
    assert.deepEqual(discovery.sourceFiles, ["index.js", "lib/chart.min.js", "test/helper.js", "vendor/jquery.js"]);
    assert.equal(discovery.summary.skippedJsFiles, 0);
    assert.deepEqual(discoveryLimitations(discovery.summary), []);
  });
});

// CLA-578: unresolved relative imports become scan-level limitations.

test("a quick scan lists unresolved relative imports in analysis.limitations (file:line and specifier)", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "broken" }),
    "tsconfig.json": "{}",
    "src/index.ts": "import { ok } from './ok.js';\nimport { gone } from './gone.js';\nexport const all = [ok, gone];\n",
    "src/ok.ts": "export const ok = 1;\n",
  }, dir => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    const artifacts = scanRepository(dir, { analysisMode: "quick" });
    assert.deepEqual(artifacts.analysis.limitations, [
      "1 relative import(s) name no file in the repository; no relation was recorded for them.",
      "Unresolved relative import src/index.ts:2: './gone.js'",
    ]);
  });
});

test("unresolved-import limitations are capped with a +N more count", () => {
  assert.deepEqual(unresolvedImportLimitations([]), [], "nothing to say when every import resolved");
  const many = Array.from({ length: UNRESOLVED_IMPORTS_SHOWN + 7 }, (_, index) => ({ path: "src/a.ts", line: index + 1, specifier: `./m${index}.js` }));
  const lines = unresolvedImportLimitations(many);
  assert.equal(lines.length, 1 + UNRESOLVED_IMPORTS_SHOWN + 1);
  assert.equal(lines[0], `${UNRESOLVED_IMPORTS_SHOWN + 7} relative import(s) name no file in the repository; no relation was recorded for them.`);
  assert.equal(lines[1], "Unresolved relative import src/a.ts:1: './m0.js'");
  assert.equal(lines.at(-1), "+7 more unresolved relative import(s) not itemized.");
});

// CLA-578 review round 1.

test("Cargo [workspace] exclude also filters the crates/* fallback (no members, or members that normalize to none)", () => {
  for (const workspace of ['[workspace]\nexclude = ["crates/scratch"]\n', '[workspace]\nmembers = ["."]\nexclude = ["crates/scratch"]\n']) {
    withRepo({
      "package.json": JSON.stringify({ name: "mixed" }),
      "Cargo.toml": workspace,
      "crates/engine/Cargo.toml": '[package]\nname = "engine"\n',
      "crates/engine/src/lib.rs": "pub fn run() {}\n",
      "crates/scratch/Cargo.toml": '[package]\nname = "scratch"\n',
      "crates/scratch/src/lib.rs": "pub fn scratch() {}\n",
    }, dir => {
      assert.deepEqual(discoverRepository(dir).units.filter(unit => unit.kind === "rust").map(unit => unit.dir), ["crates/engine"], workspace);
    });
  }
});

test("deepest root wins across Rust crates and JS members: a JS member nested in a crate owns its files", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mixed", workspaces: ["engine/web", "engine/examples/*"] }),
    "tsconfig.json": "{}",
    "Cargo.toml": '[workspace]\nmembers = ["engine"]\n',
    "engine/Cargo.toml": '[package]\nname = "engine"\n',
    "engine/src/lib.rs": "pub fn run() {}\n",
    "engine/web/package.json": JSON.stringify({ name: "@m/web" }),
    "engine/web/src/index.ts": "export const web = 1;\n",
    "engine/examples/demo/package.json": JSON.stringify({ name: "@m/demo" }),
    "engine/examples/demo/main.ts": "export const demo = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.equal(discovery.unitByFile.get("engine/web/src/index.ts"), "engine/web");
    assert.equal(discovery.unitByFile.get("engine/src/lib.rs"), "engine");
    assert.ok(discovery.units.some(unit => unit.kind === "member" && unit.dir === "engine/web"), "the nested web member keeps its unit");
    assert.equal(discovery.unitByFile.has("engine/examples/demo/main.ts"), false, "a winning fixture member is still skipped, not handed to the crate");
  });
});

test("an import of an existing tracked file is never unresolved: single-package root and tooling bucket", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "demo" }),
    "tsconfig.json": "{}",
    "src/index.ts": "import './app.css';\nimport logo from './logo.svg';\nimport data from '../data/seed.json';\nimport './gone.css';\nexport const all = [logo, data];\n",
    "src/app.css": "body {}\n",
    "src/logo.svg": "<svg/>\n",
    "data/seed.json": "{}\n",
  }, dir => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    assert.deepEqual(scanRepository(dir, { analysisMode: "quick" }).analysis.limitations, [
      "1 relative import(s) name no file in the repository; no relation was recorded for them.",
      "Unresolved relative import src/index.ts:4: './gone.css'",
    ], "the root unit key is a slug, not a dir: tracked assets must still count as existing");
  });
  withRepo({
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "package.json": JSON.stringify({ name: "mono" }),
    "tsconfig.json": "{}",
    "packages/a/package.json": JSON.stringify({ name: "@m/a" }),
    "packages/a/index.ts": "export const a = 1;\n",
    "scripts/build.mjs": "import config from './config.json' with { type: 'json' };\nimport legacy from './legacy.min.js';\nexport default [config, legacy];\n",
    "scripts/config.json": "{}\n",
    "scripts/legacy.min.js": "1;\n",
  }, dir => {
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    const limitations = scanRepository(dir, { analysisMode: "quick" }).analysis.limitations ?? [];
    assert.ok(!limitations.some(line => line.includes("relative import")), `tooling imports of tracked JSON / a skipped .js are not unresolved: ${limitations.join(" | ")}`);
  });
});

test("same dir as both a JS member and a Rust crate: one Rust unit that keeps the npm name alias", () => {
  withRepo({
    "package.json": JSON.stringify({ name: "mono", workspaces: ["engine", "app"] }),
    "tsconfig.json": "{}",
    "Cargo.toml": '[workspace]\nmembers = ["engine"]\n',
    "engine/package.json": JSON.stringify({ name: "@m/engine" }),
    "engine/Cargo.toml": '[package]\nname = "engine"\n',
    "engine/src/lib.rs": "pub fn run() {}\n",
    "engine/src/index.ts": "export const e = 1;\n",
    "app/package.json": JSON.stringify({ name: "@m/app" }),
    "app/main.ts": "import { e } from '@m/engine';\nexport const a = e;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.deepEqual(discovery.units.filter(unit => unit.dir === "engine"), [
      { kind: "rust", dir: "engine", name: "engine", evidencePath: "engine", packageName: "@m/engine" },
    ], "exactly one unit owns the dir");
    assert.equal(discovery.unitByPackageName.get("@m/engine"), "engine");
    assert.equal(discovery.unitByFile.get("engine/src/index.ts"), "engine");
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
    const { snapshot } = scanRepository(dir, { analysisMode: "quick" });
    assert.deepEqual(snapshot.entities.filter(entity => entity.kind === "container").map(entity => entity.id).sort(), ["container:app", "container:engine"]);
    assert.ok(snapshot.relations.some(relation => relation.from === "container:app" && relation.to === "container:engine"), "an import of the npm name resolves to the merged unit");
  });
});
