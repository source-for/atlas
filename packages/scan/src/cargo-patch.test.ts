import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cargoPatchApplies, cargoPatchPaths, cargoPathDependencies, cargoSourcedDependencies, unfollowedCargoPatches } from "./extract.js";
import { scanRepository, type ScanArtifacts } from "./scan.js";

// CLA-587: a root `[patch.<source>]` path override (tokio: `[patch.crates-io] tokio =
// { path = "tokio" }`) wires in-repo crates that depend on each other by registry
// version. Those dependencies are crate edges; out-of-repo patch paths are reported.

function committedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-cargo-patch-"));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
  return dir;
}

const ROOT_MANIFEST = [
  "[workspace]",
  'members = ["core", "util", "app", "net"]',
  "",
  "[patch.crates-io]",
  'core = { path = "core" }',
  'util = { path = "./util/" }',
  'outside = { path = "../outside" }',
  'ghost = { path = "vendor/ghost" }',
  "",
  "[patch.crates-io.extra]",
  'path = "../extra"',
  "",
  '[patch."https://github.com/acme/net.git"]',
  'net = { path = "net" }',
  "",
].join("\n");

const PATCHED_WORKSPACE: Record<string, string> = {
  "Cargo.toml": ROOT_MANIFEST,
  "core/Cargo.toml": '[package]\nname = "core"\nversion = "1.0.0"\n',
  "core/src/lib.rs": "pub fn core() {}\n",
  "util/Cargo.toml": '[package]\nname = "util"\nversion = "0.2.0"\n\n[dependencies.core]\nversion = "1"\n',
  "util/src/lib.rs": "pub fn util() {}\n",
  "net/Cargo.toml": '[package]\nname = "net"\nversion = "0.1.0"\n',
  "net/src/lib.rs": "pub fn net() {}\n",
  "app/Cargo.toml": [
    "[package]",
    'name = "app"',
    'version = "0.1.0"',
    "",
    "[dependencies]",
    'core = "1"',
    'util = { version = "0.2", features = ["x"] }',
    'outside = "1"',
    'net = { git = "https://github.com/acme/net/" }',
    'serde = "1"',
    "",
    "[dev-dependencies]",
    'ghost = "1"',
    "",
  ].join("\n"),
  "app/src/lib.rs": "pub fn app() {}\n",
};

/** `from -> to @ evidence…` for every container→container relation. */
function crateEdges(artifacts: ScanArtifacts): string[] {
  const kind = new Map(artifacts.extraction.entities.map(entity => [entity.id, entity.kind]));
  return artifacts.extraction.relations
    .filter(relation => kind.get(relation.from) === "container" && kind.get(relation.to) === "container")
    .map(relation => `${relation.from} -> ${relation.to} @ ${relation.evidence.map(item => `${item.source.path}:${item.source.startLine}`).join(" ")}`);
}

const EXPECTED_EDGES = [
  "container:app -> container:core @ app/Cargo.toml:6 Cargo.toml:5",
  "container:app -> container:net @ app/Cargo.toml:9 Cargo.toml:14",
  "container:app -> container:util @ app/Cargo.toml:7 Cargo.toml:6",
  "container:util -> container:core @ Cargo.toml:5 util/Cargo.toml:5",
];

const EXPECTED_PATCH_LIMITATIONS = [
  "Cargo [patch] path resolves outside the repository; not followed, no crate edge recorded: Cargo.toml:7: [patch.crates-io] outside = { path = '../outside' }",
  "Cargo [patch] path names no scanned crate; no crate edge recorded: Cargo.toml:8: [patch.crates-io] ghost = { path = 'vendor/ghost' }",
  "Cargo [patch] path resolves outside the repository; not followed, no crate edge recorded: Cargo.toml:11: [patch.crates-io] extra = { path = '../extra' }",
];

test("cargoPatchPaths reads inline and subsection [patch.<source>] path overrides; skips non-path redirects", () => {
  assert.deepEqual(cargoPatchPaths(ROOT_MANIFEST + '\n[patch.crates-io]\nredirect = { git = "https://example.com/r" }\n'), [
    { source: "crates-io", name: "core", path: "core", line: 5 },
    { source: "crates-io", name: "util", path: "./util/", line: 6 },
    { source: "crates-io", name: "outside", path: "../outside", line: 7 },
    { source: "crates-io", name: "ghost", path: "vendor/ghost", line: 8 },
    { source: "crates-io", name: "extra", path: "../extra", line: 11 },
    { source: "https://github.com/acme/net.git", name: "net", path: "net", line: 14 },
  ]);
});

test("cargoSourcedDependencies: registry/git declarations with their [patch] source; path ones stay in cargoPathDependencies", () => {
  const manifest = [
    "[dependencies]",
    'plain = "1"',
    'table = { version = "1", default-features = false }',
    'renamed = { version = "1", package = "real-name" }',
    'private = { version = "1", registry = "corp" }',
    'gitdep = { git = "https://github.com/acme/gitdep" }',
    'local = { version = "1", path = "../local" }',
    "inherited.workspace = true",
    "",
    "[dependencies.sub]",
    'version = "2"',
    "",
    "[dependencies.subpath]",
    'version = "2"',
    'path = "../subpath"',
    "",
    "[build-dependencies]",
    'builder = "1"',
  ].join("\n");
  assert.deepEqual(cargoSourcedDependencies(manifest), [
    { name: "plain", line: 2, source: "crates-io" },
    { name: "table", line: 3, source: "crates-io" },
    { name: "real-name", line: 4, source: "crates-io" },
    { name: "private", line: 5, source: "corp" },
    { name: "gitdep", line: 6, source: "https://github.com/acme/gitdep" },
    { name: "sub", line: 10, source: "crates-io" },
  ]);
  assert.deepEqual(cargoPathDependencies(manifest).map(dependency => [dependency.name, dependency.path, dependency.line]), [
    ["local", "../local", 7],
    ["inherited", "", 8],
    ["subpath", "../subpath", 15],
  ], "the path-dependency view is unchanged");
});

test("cargoPatchApplies matches the patch source key; git URLs compare without .git, trailing slash or case", () => {
  assert.equal(cargoPatchApplies("crates-io", "crates-io"), true);
  assert.equal(cargoPatchApplies("crates-io", "corp"), false);
  assert.equal(cargoPatchApplies("https://github.com/Acme/net.git", "https://github.com/acme/net/"), true);
  assert.equal(cargoPatchApplies("https://github.com/acme/net", "https://github.com/acme/other"), false);
});

test("unfollowedCargoPatches: out-of-repo paths and in-repo non-crates, never a crate that exists", () => {
  assert.deepEqual(unfollowedCargoPatches(ROOT_MANIFEST, new Set(["core", "util", "app", "net"])).map(patch => [patch.name, patch.reason]), [
    ["outside", "outside-repository"],
    ["ghost", "no-crate"],
    ["extra", "outside-repository"],
  ]);
  assert.deepEqual(unfollowedCargoPatches('[patch.crates-io]\nescape = { path = "core/../../core" }\n', new Set(["core"])).map(patch => patch.reason),
    ["outside-repository"], "a path that dips above the root is outside even when it lands on a crate name");
});

for (const mode of ["quick", "full"] as const) {
  test(`${mode} scan: registry dependencies on [patch]-overridden in-repo crates are crate edges; out-of-repo patches are reported`, { skip: mode === "full" && process.platform === "win32" ? "fake analyzer is a POSIX shell script" : false }, () => {
    const repo = committedRepo(PATCHED_WORKSPACE);
    // Full mode spawns rust-analyzer from PATH; a failing stand-in keeps the test hermetic
    // (crate edges come from Cargo.toml, not the analyzer).
    const bin = mkdtempSync(join(tmpdir(), "okie-cargo-patch-bin-"));
    writeFileSync(join(bin, "rust-analyzer"), "#!/bin/sh\necho 'fake rust-analyzer: no index' >&2\nexit 1\n");
    chmodSync(join(bin, "rust-analyzer"), 0o755);
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${savedPath ?? ""}`;
      const first = scanRepository(repo, { analysisMode: mode });
      assert.deepEqual(crateEdges(first), EXPECTED_EDGES);
      const limitations = first.analysis.limitations ?? [];
      assert.deepEqual(limitations.filter(line => line.startsWith("Cargo [patch]")), EXPECTED_PATCH_LIMITATIONS);
      const second = scanRepository(repo, { analysisMode: mode });
      assert.equal(JSON.stringify(second.extraction), JSON.stringify(first.extraction), "extraction is byte-stable across runs");
      assert.equal(JSON.stringify(second.analysis), JSON.stringify(first.analysis), "analysis is byte-stable across runs");
    } finally {
      process.env.PATH = savedPath;
      rmSync(repo, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });
}

test("a crate without [patch] keeps registry dependencies on a same-named member external (no edge)", () => {
  const files = { ...PATCHED_WORKSPACE, "Cargo.toml": '[workspace]\nmembers = ["core", "util", "app", "net"]\n' };
  const repo = committedRepo(files);
  try {
    const artifacts = scanRepository(repo, { analysisMode: "quick" });
    assert.deepEqual(crateEdges(artifacts), []);
    assert.ok(!(artifacts.analysis.limitations ?? []).some(line => line.startsWith("Cargo [patch]")));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
