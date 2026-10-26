import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeRust, RUST_LOCKDOWN_LIMITATION, rustDependencyLimitation, scrubCargoError, scrubScipError, unsafeRustProjectJson } from "./analyze-rust.js";
import { observeScanSpawns } from "./scan-env.js";
import { rustAnalyzerVersion } from "./scip-cache.js";

/**
 * CLA-305 acceptance: a repository whose build script, proc macro, `.cargo/config.toml` rustc wrappers / `build.rustc`,
 * `rust-toolchain.toml` path toolchain and `rust-analyzer.toml` override would each execute repository code during a
 * full-mode Rust analysis. Every payload ONLY writes a marker file into a private temp dir whose absolute path is baked
 * into the fixture at generation time (the scanner's environment is minimal, so env vars can't carry it). No network.
 */
function write(root: string, path: string, text: string, executable = false): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  if (executable) chmodSync(join(root, path), 0o755);
}

function maliciousWorkspace(root: string, markers: string): void {
  const marker = (name: string) => JSON.stringify(join(markers, name));
  const script = (name: string, tail: string) => `#!/bin/sh\necho ran >> ${marker(name)}\n${tail}\n`;
  write(root, "Cargo.toml", '[workspace]\nmembers = ["pm", "app"]\nresolver = "2"\n');
  write(root, "pm/Cargo.toml", '[package]\nname = "pm"\nversion = "0.1.0"\nedition = "2021"\n[lib]\nproc-macro = true\n');
  write(root, "pm/src/lib.rs", `use proc_macro::TokenStream;\n#[proc_macro]\npub fn mark(_input: TokenStream) -> TokenStream {\n    let _ = std::fs::write(${marker("proc-macro")}, "ran");\n    "pub fn generated() {}".parse().unwrap()\n}\n`);
  write(root, "app/Cargo.toml", '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\npm = { path = "../pm" }\n');
  write(root, "app/build.rs", `fn main() {\n    let _ = std::fs::write(${marker("build-script")}, "ran");\n}\n`);
  write(root, "app/src/lib.rs", "pm::mark!();\n\npub fn hello() -> u32 { helper() }\n\nfn helper() -> u32 { 1 }\n");
  // cargo metadata runs `rustc -vV` through these (build.rustc replaces the compiler outright).
  write(root, "evil/wrapper.sh", script("rustc-wrapper", 'exec "$@"'), true);
  write(root, "evil/workspace-wrapper.sh", script("rustc-workspace-wrapper", 'exec "$@"'), true);
  write(root, "evil/rustc.sh", script("build-rustc", 'exec rustc "$@"'), true);
  write(root, ".cargo/config.toml", `[build]\nrustc = ${JSON.stringify(join(root, "evil/rustc.sh"))}\nrustc-wrapper = ${JSON.stringify(join(root, "evil/wrapper.sh"))}\nrustc-workspace-wrapper = ${JSON.stringify(join(root, "evil/workspace-wrapper.sh"))}\n`);
  // A path toolchain of repository binaries: any rustup proxy resolved in the tree would run them.
  for (const tool of ["rustc", "cargo", "rust-analyzer"]) write(root, `toolchain/bin/${tool}`, script(`toolchain-${tool}`, "exit 1"), true);
  write(root, "rust-toolchain.toml", `[toolchain]\npath = ${JSON.stringify(join(root, "toolchain"))}\n`);
  // rust-analyzer's own per-repository config (not read by `scip` 1.87; asserted anyway).
  write(root, "evil/ratoml.sh", script("rust-analyzer-toml", "exit 0"), true);
  write(root, "rust-analyzer.toml", `cargo.buildScripts.overrideCommand = [${JSON.stringify(join(root, "evil/ratoml.sh"))}]\nprocMacro.server = ${JSON.stringify(join(root, "evil/ratoml.sh"))}\n`);
}

test("rust lockdown: a malicious workspace runs none of its build script, proc macro, wrappers, toolchain or rust-analyzer.toml, and is still indexed", { timeout: 300_000 }, t => {
  if (process.platform === "win32") { t.skip("shell-script payloads"); return; }
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "okie-rust-lockdown-tree-"));
  const markers = mkdtempSync(join(tmpdir(), "okie-rust-lockdown-markers-"));
  const cacheDir = mkdtempSync(join(tmpdir(), "okie-rust-lockdown-cache-"));
  try {
    maliciousWorkspace(root, markers);
    // With a cache dir the rustc identity is resolved too (it used to run `rustc -vV` in the tree).
    const analysis = analyzeRust(root, ["app/src/lib.rs", "pm/src/lib.rs", "app/build.rs"], { indexCacheDir: cacheDir });
    assert.deepEqual(readdirSync(markers).sort(), [], "no repository payload ran");
    assert.equal(existsSync(join(root, "target")), false, "nothing was built in the tree");
    const coverage = analysis.coverage[0];
    assert.equal(coverage?.coverage, "semantic", JSON.stringify(analysis.coverage));
    assert.ok(coverage?.limitations.includes(RUST_LOCKDOWN_LIMITATION), "the limitation says generated code is not indexed");
    assert.ok(analysis.definitions.some(definition => definition.path === "app/src/lib.rs" && definition.name === "hello"), "the index was still produced");
    assert.ok(analysis.references.some(reference => reference.path === "app/src/lib.rs" && reference.kind === "calls"), "and still resolves calls");
  } finally { for (const path of [root, markers, cacheDir]) rmSync(path, { recursive: true, force: true }); }
});

test("rust lockdown: a rust-project.json naming a proc-macro dylib or a sysroot is refused before rust-analyzer runs", () => {
  const cases: Record<string, unknown> = {
    dylib: { crates: [{ root_module: "src/lib.rs", edition: "2021", deps: [], is_proc_macro: true, proc_macro_dylib_path: "libevil.so" }] },
    sysroot: { sysroot: "fake-sysroot", crates: [{ root_module: "src/lib.rs", edition: "2021", deps: [] }] },
    sysrootSrc: { sysroot_src: "fake-sysroot/lib/rustlib/src/rust/library", crates: [] },
  };
  const spawned: string[] = [];
  observeScanSpawns(spawn => { spawned.push(spawn.file); });
  try {
    for (const [name, project] of Object.entries(cases)) {
      const root = mkdtempSync(join(tmpdir(), "okie-rust-project-json-"));
      try {
        write(root, "src/lib.rs", "pub fn f() {}\n");
        // CLA-654: a credential-shaped directory in the refused path is redacted in the limitation like any diagnostic.
        write(root, name === "dylib" ? "u:CLA654REFUSAL@host/rust-project.json" : "rust-project.json", JSON.stringify(project));
        const reason = unsafeRustProjectJson(root);
        assert.ok(reason, name);
        const analysis = analyzeRust(root, ["src/lib.rs"]);
        assert.equal(analysis.coverage[0]?.coverage, "unavailable", name);
        assert.match(analysis.coverage[0]!.limitations[0]!, /Rust analysis skipped: rust-analyzer would load or execute repository-supplied binaries/, name);
        assert.ok(!analysis.coverage[0]!.limitations[0]!.includes("CLA654REFUSAL"), `${name}: ${analysis.coverage[0]!.limitations[0]}`);
        assert.deepEqual(spawned.filter(file => file === "rust-analyzer"), [], `${name}: rust-analyzer never ran`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
    const safe = mkdtempSync(join(tmpdir(), "okie-rust-project-json-"));
    try {
      write(safe, "rust-project.json", JSON.stringify({ crates: [{ root_module: "src/lib.rs", edition: "2021", deps: [] }] }));
      assert.equal(unsafeRustProjectJson(safe), undefined, "a plain crate list is loadable");
      write(safe, "tools/.rust-project.json", "{ not json");
      assert.match(unsafeRustProjectJson(safe) ?? "", /tools\/\.rust-project\.json \(unparseable\)/);
      rmSync(join(safe, "tools"), { recursive: true });
      // rust-analyzer opens `rust-project.json` on a case-insensitive FS (APFS) even when it is committed as
      // `Rust-Project.JSON`: the check folds case and normalization itself, so this holds on any filesystem.
      write(safe, "nested/Rust-Project.JSON", JSON.stringify({ sysroot: "fake-sysroot", crates: [] }));
      assert.match(unsafeRustProjectJson(safe) ?? "", /nested\/Rust-Project\.JSON \(sysroot\)/);
      rmSync(join(safe, "nested"), { recursive: true });
      // U+017F LATIN SMALL LETTER LONG S folds to `s` on APFS: rust-analyzer's exists("rust-project.json") finds it.
      // Refused by the name layer on any filesystem, and by the direct lstat layer where the FS folds it.
      write(safe, "deep/ru\u017Ft-project.json", JSON.stringify({ crates: [{ root_module: "x.rs", edition: "2021", deps: [], proc_macro_dylib_path: "libevil.dylib" }] }));
      assert.match(unsafeRustProjectJson(safe) ?? "", /deep\/(ru\u017Ft|rust)-project\.json \(proc_macro_dylib_path\)/);
    } finally { rmSync(safe, { recursive: true, force: true }); }
  } finally { observeScanSpawns(undefined); }
});

test("rust dependency limitation: truthful in both CARGO_HOME modes (an unresolvable git dependency with the opt-in set)", { timeout: 300_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const make = (dependencies: string) => {
    const root = mkdtempSync(join(tmpdir(), "okie-rust-deps-"));
    write(root, "Cargo.toml", `[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\n${dependencies}`);
    write(root, "src/lib.rs", "pub fn hello() -> u32 { 1 }\n");
    return root;
  };
  const operatorHome = mkdtempSync(join(tmpdir(), "okie-rust-deps-cargo-home-"));
  const gitDep = make('schemars = { git = "https://example.invalid/schemars.git", branch = "main" }\n');
  const noDeps = make("");
  const previous = process.env.OKIE_SCAN_CARGO_HOME;
  const lines = (root: string) => analyzeRust(root, ["src/lib.rs"]).coverage[0]!.limitations;
  try {
    // Opt-in set, but the git dependency can't be checked out offline: the limitation must say so.
    process.env.OKIE_SCAN_CARGO_HOME = operatorHome;
    const optIn = lines(gitDep);
    const failed = optIn.find(line => line.startsWith("Dependency resolution failed offline ("));
    assert.ok(failed, JSON.stringify(optIn));
    assert.ok(!failed.includes(gitDep) && !failed.includes(operatorHome), `machine paths are scrubbed: ${failed}`);
    assert.ok(!optIn.some(line => line.startsWith("crates.io dependencies are not resolved")));
    // Opt-in set and nothing to resolve: no dependency line at all.
    assert.ok(!lines(noDeps).some(line => /Dependency resolution failed|dependencies are not resolved/.test(line)));
    // Default isolated CARGO_HOME: the isolated wording, with cargo's reason.
    delete process.env.OKIE_SCAN_CARGO_HOME;
    const isolated = lines(gitDep).find(line => line.startsWith("crates.io dependencies are not resolved (offline, isolated CARGO_HOME: "));
    assert.ok(isolated, "the default mode names the failure");
    assert.ok(!lines(noDeps).some(line => /dependencies are not resolved/.test(line)), "a tree with nothing to resolve resolves fine offline");
  } finally {
    if (previous === undefined) delete process.env.OKIE_SCAN_CARGO_HOME; else process.env.OKIE_SCAN_CARGO_HOME = previous;
    for (const path of [operatorHome, gitDep, noDeps]) rmSync(path, { recursive: true, force: true });
  }
});

test("rust dependency limitation: a vendored [source] replacement in the tree's .cargo/config.toml resolves (cargo runs in the tree)", { timeout: 300_000 }, t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "okie-rust-vendored-"));
  try {
    write(root, "Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nvd = "0.1"\n');
    write(root, "src/lib.rs", "pub fn f() { vd::g() }\n");
    write(root, ".cargo/config.toml", '[source.crates-io]\nreplace-with = "vendored"\n[source.vendored]\ndirectory = "vendor"\n');
    write(root, "vendor/vd/Cargo.toml", '[package]\nname = "vd"\nversion = "0.1.0"\nedition = "2021"\n');
    write(root, "vendor/vd/src/lib.rs", "pub fn g() {}\n");
    write(root, "vendor/vd/.cargo-checksum.json", '{"files":{},"package":null}');
    const coverage = analyzeRust(root, ["src/lib.rs"]).coverage[0]!;
    assert.equal(coverage.coverage, "semantic", JSON.stringify(coverage));
    assert.ok(!coverage.limitations.some(line => /dependencies are not resolved|Dependency resolution failed/.test(line)), JSON.stringify(coverage.limitations));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rust dependency limitation: cargo errors are reduced to one line without machine paths", () => {
  const stderr = "    Updating git repository `https://example.invalid/x.git`\nerror: failed to load source for dependency `x` at /work/scan-1/tree/Cargo.toml (CARGO_HOME /srv/cargo, home /home/u)\n\nCaused by: ...\n";
  assert.equal(scrubCargoError(stderr, [["tree", "/work/scan-1/tree"], ["CARGO_HOME", "/srv/cargo"], ["home", "/home/u"]]), "failed to load source for dependency `x` at <tree>/Cargo.toml (CARGO_HOME <CARGO_HOME>, home <home>)");
  // Cargo source ids name the tree inside a `path+file://` URL; the label still applies there.
  assert.equal(
    scrubCargoError("error: package `x v0.1.0 (path+file:///work/scan-1/tree/x)` cannot be built", [["tree", "/work/scan-1/tree"]]),
    "package `x v0.1.0 (path+file://<tree>/x)` cannot be built",
  );
  assert.match(rustDependencyLimitation("operator", "boom"), /^Dependency resolution failed offline \(boom\): external references omitted/);
  assert.match(rustDependencyLimitation("isolated", undefined), /^crates\.io dependencies are not resolved \(offline, isolated CARGO_HOME\):/);
});

test("CLA-586: a failed rust-analyzer run is one stable line, never its timestamps, temp paths or backtrace", () => {
  const tree = "/w/okie-scan-work/okie-committed-bHtUY7/fxr";
  const stderr = [
    "Generating SCIP start...",
    "2026-10-15T03:42:55.292267+10:00 ERROR Config Error(s) error_sink=ConfigErrors([])",
    "rust-analyzer: Loading Querying project metadata",
    `Error: Failed to load the project at ${tree}/Cargo.toml`,
    "",
    "Caused by:",
    `    1: Failed to run \`cd "${tree}" && RUSTUP_TOOLCHAIN="/Users/me/.rustup/toolchains/1.87.0" cargo metadata\``,
    "Stack backtrace:",
    "   0: std::backtrace::Backtrace::create",
  ].join("\n");
  const paths = [["tree", tree], ["checkout", "/w/okie-scan-work/okie-committed-bHtUY7"], ["work-root", "/w/okie-scan-work"], ["home", "/Users/me"]] as const;
  assert.equal(scrubScipError(stderr, paths), "Failed to load the project at <tree>/Cargo.toml");
  assert.equal(scrubScipError("error: spawnSync rust-analyzer ETIMEDOUT", paths), "spawnSync rust-analyzer ETIMEDOUT");
  assert.equal(scrubScipError("Generating SCIP start...\n2026-10-15T03:42:55Z INFO done", paths), "rust-analyzer exited unsuccessfully.");
  // A panic has no `error` line: its location and message, not the generic fallback.
  assert.equal(
    scrubScipError(`Generating SCIP start...\nthread 'main' panicked at crates/project-model/src/workspace.rs:12:5:\nno sysroot under ${tree}/target\nnote: run with \`RUST_BACKTRACE=1\``, paths),
    "thread 'main' panicked at crates/project-model/src/workspace.rs:12:5: no sysroot under <tree>/target",
  );
  assert.equal(scrubScipError("thread 'main' panicked at 'boom', src/main.rs:1:1", paths), "thread 'main' panicked at 'boom', src/main.rs:1:1");
});
