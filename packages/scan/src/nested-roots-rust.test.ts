import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeRust } from "./analyze-rust.js";
import { discoverRepository, rustAnalysisScope } from "./discover.js";
import { scanRepository, type ScanArtifacts } from "./scan.js";
import { observeScanSpawns } from "./scan-env.js";
import { acquireCommittedTree } from "./pin.js";
import { rustAnalyzerVersion } from "./scip-cache.js";

/** CLA-605 P7: one Cargo context per rust-analyzer run (several per scan are CLA-644). */

function git(cwd: string, args: readonly string[]): void {
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  }
}

function withCommittedRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-nested-rust-"));
  try {
    git(dir, ["init", "-q"]);
    writeTree(dir, files);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "fixture"]);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const crate = (name: string, extra = ""): string => `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n${extra}`;
const CORE = "pub fn calculate() -> u32 {\n    41\n}\n";
const APP = (core: string): string => `pub fn total() -> u32 {\n    ${core}::calculate() + 1\n}\n`;

/** A Cargo workspace at `dir` (`""` = repository root) with crates `app` -> `core` (a path dependency). */
function workspace(dir: string, prefix: string): Record<string, string> {
  const at = (path: string): string => (dir ? `${dir}/${path}` : path);
  return {
    [at("Cargo.toml")]: `[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n`,
    [at("crates/core/Cargo.toml")]: crate(`${prefix}_core`),
    [at("crates/core/src/lib.rs")]: CORE,
    [at("crates/app/Cargo.toml")]: crate(`${prefix}_app`, `\n[dependencies]\n${prefix}_core = { path = "../core" }\n`),
    [at("crates/app/src/lib.rs")]: APP(`${prefix}_core`),
  };
}

/** Root workspace plus a cargo-fuzz style nested `[workspace]` package depending on a root crate. */
const ROOT_AND_FUZZ: Record<string, string> = {
  ...workspace("", "root"),
  "fuzz/Cargo.toml": `${crate("root_fuzz")}\n[dependencies]\nroot_core = { path = "../crates/core" }\n\n[workspace]\nmembers = ["."]\n`,
  "fuzz/src/lib.rs": "pub fn fuzz() -> u32 {\n    root_core::calculate()\n}\n",
};

function scopeOf(dir: string, root?: string) {
  return rustAnalysisScope(discoverRepository(dir, root ? { root } : {}));
}

test("P7 selection: base context wins, else the one nested context at any depth, else none (named, CLA-644)", () => {
  withCommittedRepo(ROOT_AND_FUZZ, dir => {
    const scope = scopeOf(dir);
    assert.equal(scope.indexDir, "", "the root workspace keeps its semantics (as on main)");
    assert.deepEqual(scope.deferred, ["fuzz"]);
    assert.deepEqual(scope.admitted, ["crates/app/src/lib.rs", "crates/core/src/lib.rs"]);
    assert.deepEqual(scopeOf(dir, "fuzz").indexDir, "fuzz", "--root fuzz indexes its own manifest");
  });
  withCommittedRepo(workspace("rust", "r"), dir => assert.equal(scopeOf(dir).indexDir, "rust"));
  withCommittedRepo(workspace("services/rust", "r"), dir => {
    const scope = scopeOf(dir);
    assert.equal(scope.indexDir, "services/rust", "depth 2");
    assert.deepEqual(scope.deferred, []);
  });
  withCommittedRepo({ ...workspace("a", "a"), ...workspace("deep/b", "b") }, dir => {
    const scope = scopeOf(dir);
    assert.equal(scope.indexDir, undefined, "two nested contexts and none at the base: no run");
    assert.deepEqual(scope.deferred, ["a", "deep/b"]);
    assert.deepEqual(scope.admitted, []);
    assert.equal(scopeOf(dir, "deep/b").indexDir, "deep/b", "--root picks one");
  });
});

test("P7 Cargo per context: a root [patch] never applies to an independent nested workspace; a nested [patch] applies inside its own", () => {
  withCommittedRepo({
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n[patch.crates-io]\nfoo = { path = "crates/foo" }\n`,
    "crates/foo/Cargo.toml": crate("foo"),
    "crates/foo/src/lib.rs": "pub fn f() {}\n",
    "rust/Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n\n[patch.crates-io]\nbar = { path = "crates/bar" }\n`,
    "rust/crates/x/Cargo.toml": crate("x", `\n[dependencies]\nfoo = "0.1"\nbar = "0.1"\n`),
    "rust/crates/x/src/lib.rs": "pub fn x() {}\n",
    "rust/crates/bar/Cargo.toml": crate("bar"),
    "rust/crates/bar/src/lib.rs": "pub fn b() {}\n",
  }, dir => {
    for (const root of [undefined, "rust"]) {
      const artifacts = scanRepository(dir, { analysisMode: "quick", ...(root ? { root } : {}) });
      const pathOf = new Map(artifacts.snapshot.entities.filter(entity => entity.kind === "container").map(entity => [entity.id, entity.sourceRefs[0]!.path]));
      const edges = artifacts.snapshot.relations.filter(relation => pathOf.has(relation.from) && pathOf.has(relation.to));
      assert.deepEqual(edges.map(relation => `${pathOf.get(relation.from)} -> ${pathOf.get(relation.to)}`), ["rust/crates/x -> rust/crates/bar"], `root=${root}`);
      assert.deepEqual(edges[0]!.evidence.map(evidence => `${evidence.source.path}:${evidence.source.startLine}`).sort(), ["rust/Cargo.toml:5", "rust/crates/x/Cargo.toml:8"]);
      assert.ok(!(artifacts.analysis.limitations ?? []).some(line => line.includes("[patch") && line.startsWith("Cargo")), "no limitation cites a patch outside the crate's context");
    }
  });
});

const rustCoverage = (artifacts: ScanArtifacts) => artifacts.analysis.adapters.find(item => item.language === "rust");
function callEdges(artifacts: ScanArtifacts): string[] {
  const pathOf = new Map(artifacts.snapshot.entities.map(entity => [entity.id, entity.sourceRefs[0]?.path ?? ""]));
  return artifacts.snapshot.relations.filter(relation => relation.kind === "calls").map(relation => `${pathOf.get(relation.from)} -> ${pathOf.get(relation.to)}`).sort();
}

test("P7 real rust-analyzer: one context at depth 1 / depth 2 / --root gets semantic calls with repository paths; several contexts never run", { timeout: 600_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const positive = (files: Record<string, string>, prefix: string, root?: string) => withCommittedRepo(files, dir => {
    const artifacts = scanRepository(dir, { analysisMode: "full", ...(root ? { root } : {}) });
    const coverage = rustCoverage(artifacts);
    assert.equal(coverage?.coverage, "semantic", JSON.stringify(coverage));
    assert.ok(!coverage!.limitations.some(line => line.startsWith("Not indexed")), coverage!.limitations.join("\n"));
    assert.ok(callEdges(artifacts).includes(`${prefix}/crates/app/src/lib.rs -> ${prefix}/crates/core/src/lib.rs`), callEdges(artifacts).join("\n"));
  });
  positive(workspace("rust", "r"), "rust");
  positive(workspace("services/rust", "r"), "services/rust");
  positive({ ...workspace("a", "a"), ...workspace("deep/b", "b") }, "deep/b", "deep/b");

  for (const files of [{ ...workspace("a", "a"), ...workspace("b", "b") }, { ...workspace("a", "a"), ...workspace("deep/b", "b") }]) {
    withCommittedRepo(files, dir => {
      const spawned: string[] = [];
      observeScanSpawns(spawn => { spawned.push(spawn.file); });
      let artifacts: ScanArtifacts;
      try { artifacts = scanRepository(dir, { analysisMode: "full" }); } finally { observeScanSpawns(undefined); }
      assert.deepEqual(spawned.filter(file => file === "rust-analyzer"), [], "no SCIP run");
      const coverage = rustCoverage(artifacts);
      assert.equal(coverage?.coverage, "unavailable");
      const contexts = Object.keys(files).filter(path => /^(a|b|deep\/b)\/Cargo\.toml$/.test(path)).map(path => path.slice(0, -"/Cargo.toml".length)).sort();
      assert.deepEqual(coverage!.limitations, [`Rust semantic analysis skipped: 2 independent Cargo contexts (${contexts.join(", ")}) and none at the scan root; rust-analyzer never indexes several contexts together, so none received Rust semantic edges (manifest and path dependency edges are kept). Indexing each context is tracked in CLA-644.`]);
      assert.deepEqual(callEdges(artifacts), [], "zero Rust semantic relations");
      const pathOf = new Map(artifacts.snapshot.entities.filter(entity => entity.kind === "container").map(entity => [entity.id, entity.sourceRefs[0]!.path]));
      const manifestEdges = artifacts.snapshot.relations.filter(relation => pathOf.has(relation.from) && pathOf.has(relation.to)).map(relation => `${pathOf.get(relation.from)} -> ${pathOf.get(relation.to)}`).sort();
      assert.deepEqual(manifestEdges, contexts.map(context => `${context}/crates/app -> ${context}/crates/core`), "manifest edges kept for every context");
    });
  }
});

test("P7 real rust-analyzer: root + nested fuzz workspace keeps root semantics and names the deferred context", { timeout: 300_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  withCommittedRepo(ROOT_AND_FUZZ, dir => {
    const artifacts = scanRepository(dir, { analysisMode: "full" });
    const coverage = rustCoverage(artifacts)!;
    assert.equal(coverage.coverage, "semantic");
    assert.ok(callEdges(artifacts).includes("crates/app/src/lib.rs -> crates/core/src/lib.rs"));
    assert.ok(coverage.limitations.includes("Rust semantic analysis covers one Cargo context (.); 1 independent Cargo context(s) received no Rust semantic edges (manifest and path dependency edges are kept): fuzz. Indexing each context is tracked in CLA-644."));
    assert.ok(!coverage.limitations.some(line => line.startsWith("Not indexed")), "the deferred context is named, not listed file by file");
    const fuzz = scanRepository(dir, { analysisMode: "full", root: "fuzz" });
    assert.equal(rustCoverage(fuzz)?.coverage, "semantic", JSON.stringify(rustCoverage(fuzz)));
    assert.deepEqual(callEdges(fuzz), [], "the path dependency into the root context is not ingested (no crates/ target exists in this scan)");
    for (const relation of fuzz.snapshot.relations) for (const evidence of relation.evidence) assert.ok(evidence.source.path.startsWith("fuzz/") || evidence.source.path === "README.md", evidence.source.path);
  });
});

test("P7 real rust-analyzer cache: whole-tree digest (an out-of-context path dependency change misses), context in the key", { timeout: 600_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const shared = (type: string) => ({
    "rust/Cargo.toml": `[workspace]\nmembers = ["app"]\nresolver = "2"\n`,
    "rust/app/Cargo.toml": crate("app", `\n[dependencies]\nshared = { path = "../../shared" }\n`),
    "rust/app/src/lib.rs": "pub fn go() -> u64 {\n    shared::value() as u64\n}\n",
    "shared/Cargo.toml": crate("shared"),
    "shared/src/lib.rs": `pub fn value() -> ${type} {\n    1\n}\n`,
  });
  const cacheDir = mkdtempSync(join(tmpdir(), "okie-nested-rust-cache-"));
  const seen: string[] = [];
  // rust-analyzer may write a Cargo.lock into the tree, so each run indexes a fresh copy (as a scan does).
  const run = (files: Record<string, string>, root?: string) => withCommittedRepo(files, dir => {
    const discovery = discoverRepository(dir, root ? { root } : {});
    const copy = mkdtempSync(join(tmpdir(), "okie-nested-rust-copy-"));
    try {
      cpSync(dir, copy, { recursive: true });
      analyzeRust(copy, discovery.sourceFiles, { indexCacheDir: cacheDir, scope: rustAnalysisScope(discovery), onIndex: (_variant, cache) => { seen.push(cache); } });
    } finally { rmSync(copy, { recursive: true, force: true }); }
  });
  try {
    run(shared("u8"));
    run(shared("u8"));
    run(shared("u16"));
    run(ROOT_AND_FUZZ);
    run(ROOT_AND_FUZZ, "fuzz");
    run(ROOT_AND_FUZZ, "fuzz");
    assert.deepEqual(seen, ["miss", "hit", "miss", "miss", "miss", "hit"], "unchanged hits; shared/ (outside rust/) changed misses; the same tree indexed at another context is a distinct key");
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test("P7 repository ancestors of a nested context: rust-project.json refused before any run; cargo config listed with repository paths; umask cannot loosen tree dirs", () => {
  withCommittedRepo({ ...workspace("rust", "r"), "rust-project.json": JSON.stringify({ sysroot: "/evil", crates: [] }), "rust/.keep": "" }, dir => {
    const spawned: string[] = [];
    observeScanSpawns(spawn => { spawned.push(spawn.file); });
    let artifacts: ScanArtifacts;
    try { artifacts = scanRepository(dir, { analysisMode: "full" }); } finally { observeScanSpawns(undefined); }
    const coverage = rustCoverage(artifacts)!;
    assert.equal(coverage.coverage, "unavailable");
    assert.deepEqual(coverage.limitations, ["Rust analysis skipped: rust-project.json, above the analysed Cargo context, would be loaded by rust-analyzer instead of it."]);
    assert.deepEqual(spawned.filter(file => file === "rust-analyzer" || file === "cargo"), []);
  });
  withCommittedRepo({ ...workspace("services/rust", "r"), ".cargo/config.toml": "[build]\nrustc-wrapper = \"/evil\"\n" }, dir => {
    const discovery = discoverRepository(dir);
    const previous = process.umask(0o002);
    let acquired: ReturnType<typeof acquireCommittedTree>;
    try { acquired = acquireCommittedTree(dir); } finally { process.umask(previous); }
    try {
      for (const relative of ["", "services", "services/rust", "services/rust/crates"]) {
        assert.equal(statSync(join(acquired.root, relative)).mode & 0o022, 0, `${relative || "."} is not group/other-writable under umask 002`);
      }
      const result = analyzeRust(acquired.root, discovery.sourceFiles, { scope: rustAnalysisScope(discovery), checkoutRoot: acquired.checkoutRoot });
      const limitations = result.coverage[0]!.limitations;
      assert.ok(!limitations.some(line => /writable|owned by another user/.test(line)), limitations.join("\n"));
      assert.ok(limitations.includes("Repository cargo config above the analysed Cargo context applies to Rust analysis: .cargo/config.toml."), limitations.join("\n"));
    } finally { acquired.cleanup(); }
  });
});
