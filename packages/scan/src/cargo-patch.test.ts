import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cargoPatchApplies, cargoPatchPaths, cargoPathDependencies, cargoSourcedDependencies, unfollowedCargoPatches } from "./extract.js";
import { cargoRequirementMatches } from "./dependency-facts.js";
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
  "container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6",
  "container:app -> container:net @ Cargo.toml:14 app/Cargo.toml:9",
  "container:app -> container:util @ Cargo.toml:6 app/Cargo.toml:7",
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
    { name: "plain", key: "plain", line: 2, source: "crates-io", version: "1" },
    { name: "table", key: "table", line: 3, source: "crates-io", version: "1" },
    { name: "real-name", key: "renamed", line: 4, source: "crates-io", version: "1" },
    { name: "private", key: "private", line: 5, source: "corp", version: "1" },
    { name: "gitdep", key: "gitdep", line: 6, source: "https://github.com/acme/gitdep" },
    { name: "sub", key: "sub", line: 10, source: "crates-io", version: "2" },
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

// CLA-587 review round 1 (Codex): four ways a valid [patch] override was dropped or
// mis-resolved. Each runs in quick and full mode on a two-crate workspace.

/** Runs a quick and a full scan (hermetic fake rust-analyzer) twice each; asserts byte-stability. */
function scanBothModes(files: Record<string, string>, check: (mode: "quick" | "full", artifacts: ScanArtifacts) => void): void {
  const repo = committedRepo(files);
  const bin = mkdtempSync(join(tmpdir(), "okie-cargo-patch-bin-"));
  writeFileSync(join(bin, "rust-analyzer"), "#!/bin/sh\necho 'fake rust-analyzer: no index' >&2\nexit 1\n");
  chmodSync(join(bin, "rust-analyzer"), 0o755);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${savedPath ?? ""}`;
    for (const mode of ["quick", "full"] as const) {
      const first = scanRepository(repo, { analysisMode: mode });
      check(mode, first);
      const second = scanRepository(repo, { analysisMode: mode });
      assert.equal(JSON.stringify(second.extraction), JSON.stringify(first.extraction), `${mode}: extraction byte-stable`);
      assert.equal(JSON.stringify(second.analysis), JSON.stringify(first.analysis), `${mode}: analysis byte-stable`);
    }
  } finally {
    process.env.PATH = savedPath;
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}

const TWO_CRATES = (root: string, appDependencies: string): Record<string, string> => ({
  "Cargo.toml": root,
  "core/Cargo.toml": '[package]\nname = "core"\nversion = "1.0.0"\n',
  "core/src/lib.rs": "pub fn core() {}\n",
  "app/Cargo.toml": `[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\n${appDependencies}`,
  "app/src/lib.rs": "pub fn app() {}\n",
});
const patchLimitations = (artifacts: ScanArtifacts): string[] =>
  (artifacts.analysis.limitations ?? []).filter(line => line.startsWith("Cargo [patch]"));

test("cargoPatchPaths: a renamed patch entry patches its `package`, inline or subsection, in any field order", () => {
  assert.deepEqual(cargoPatchPaths([
    "[patch.crates-io]",
    'core_alias = { package = "core", path = "core" }',
    'util_alias = { path = "util", package = "util" }',
    "[patch.crates-io.net_alias]",
    'path = "net"',
    'package = "net"',
    "[patch.crates-io.plain]",
    'path = "plain"',
  ].join("\n")).map(patch => [patch.name, patch.path, patch.line]), [
    ["core", "core", 2],
    ["util", "util", 3],
    ["net", "net", 5],
    ["plain", "plain", 8],
  ]);
});

test("round 1: a renamed [patch] entry (`alias = { package = \"core\", path = \"core\" }`) is an edge to core (quick + full)", () => {
  scanBothModes(TWO_CRATES('[workspace]\nmembers = ["core", "app"]\n\n[patch.crates-io]\ncore_alias = { package = "core", path = "core" }\n', 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], mode);
    assert.deepEqual(patchLimitations(artifacts), [], mode);
  });
});

test("round 1: workspace inheritance looks up the declaration key, the patch matches the resolved package (quick + full)", () => {
  const root = [
    "[workspace]",
    'members = ["core", "app"]',
    "",
    "[workspace.dependencies]",
    'renamed = { package = "core", version = "1" }',
    "",
    "[patch.crates-io]",
    'core = { path = "core" }',
    "",
  ].join("\n");
  scanBothModes(TWO_CRATES(root, "renamed = { workspace = true }\n"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:8 app/Cargo.toml:6"], mode);
  });
});

test("round 1: an absolute [patch] path never resolves to the same-named member; it is reported outside (quick + full)", () => {
  scanBothModes(TWO_CRATES('[workspace]\nmembers = ["core", "app"]\n\n[patch.crates-io]\ncore = { path = "/core" }\n', 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], mode);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] path resolves outside the repository; not followed, no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = '/core' }",
    ], mode);
  });
  for (const absolute of ["/core", "C:/core", "C:\\core", "\\\\server\\core"]) {
    assert.deepEqual(unfollowedCargoPatches(`[patch.crates-io]\ncore = { path = ${JSON.stringify(absolute)} }\n`, new Set(["core"])).map(patch => patch.reason),
      ["outside-repository"], absolute);
  }
});

test("cargoPatchPaths: comments after headers are ignored, `#` in quotes is kept, any later header ends the patch table", () => {
  assert.deepEqual(cargoPatchPaths([
    "[patch.crates-io] # local overrides",
    'core = { path = "core" } # the in-repo crate',
    '"we#ird" = { path = "dir#1" }',
    "[workspace.metadata] # not a patch table",
    'other = { path = "other" }',
    "[patch.crates-io]",
    'util = { path = "util" }',
    "[[bin]]",
    'fake = { path = "fake" }',
  ].join("\n")).map(patch => [patch.name, patch.path]), [
    ["core", "core"],
    ["we#ird", "dir#1"],
    ["util", "util"],
  ]);
});

test("round 1: a comment after the [patch.crates-io] header keeps its overrides (quick + full)", () => {
  scanBothModes(TWO_CRATES('[workspace]\nmembers = ["core", "app"]\n\n[patch.crates-io] # local override\ncore = { path = "core" }\n', 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], mode);
  });
});

// CLA-587 review round 2 (Codex): Cargo does no shell expansion, so a leading `~` is a
// literal in-repo directory name, never an absolute path.
test("round 2: a [patch] path with a leading `~` is a literal in-repo directory (quick + full)", () => {
  const files = {
    "Cargo.toml": '[workspace]\nmembers = ["~/core", "app"]\n\n[patch.crates-io]\ncore = { path = "~/core" }\n',
    "~/core/Cargo.toml": '[package]\nname = "core"\nversion = "1.0.0"\n',
    "~/core/src/lib.rs": "pub fn core() {}\n",
    "app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ncore = "1"\n',
    "app/src/lib.rs": "pub fn app() {}\n",
  };
  scanBothModes(files, (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], mode);
    assert.deepEqual(patchLimitations(artifacts), [], mode);
  });
  assert.deepEqual(unfollowedCargoPatches('[patch.crates-io]\ncore = { path = "~core" }\n', new Set(["~core"])), [], "`~core` names the member");
});

// CLA-587 review round 3 (Opus). Every scan case below was checked by the reviewer against
// offline `cargo metadata`; each runs in quick and full mode.

const CORE_APP = (root: string, appDependencies: string, coreVersion = 'version = "1.0.0"'): Record<string, string> => ({
  ...TWO_CRATES(root, appDependencies),
  "core/Cargo.toml": `[package]\nname = "core"\n${coreVersion}\n`,
});
const MEMBERS = '[workspace]\nmembers = ["core", "app"]\n';

test("round 3: literal-string and dotted-key [patch] paths are followed, or reported when outside (quick + full)", () => {
  scanBothModes(CORE_APP(`${MEMBERS}\n[patch.crates-io]\ncore = { path = 'core' }\n`, 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: literal string`);
  });
  scanBothModes(CORE_APP(`${MEMBERS}\n[patch.crates-io]\ncore.path = "core"\n`, 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: dotted key`);
  });
  scanBothModes(CORE_APP(`${MEMBERS}\n[patch.crates-io]\ncore = { path = '../core' }\n`, 'core = "1"\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], mode);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] path resolves outside the repository; not followed, no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = '../core' }",
    ], `${mode}: an out-of-repo literal-string path is reported`);
  });
});

test("round 3: a patch is used only when the patched version satisfies the requirement; otherwise it is reported (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(patched, 'core = "1"\n', 'version = "2.0.0"'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: core 2.0.0 does not satisfy ^1`);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] accepted by no scanned crate's normal dependency: version 2.0.0 does not satisfy app/Cargo.toml:6 requires '1'; no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = 'core' }",
    ], mode);
  });
  // `version.workspace = true` takes the [workspace.package] version.
  const inheriting = (version: string): string => `${MEMBERS}\n[workspace.package]\nversion = "${version}"\n\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(inheriting("1.4.0"), 'core = "1.2"\n', "version.workspace = true"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:8 app/Cargo.toml:6"], `${mode}: 1.4.0 satisfies ^1.2`);
    assert.deepEqual(patchLimitations(artifacts), [], mode);
  });
  scanBothModes(CORE_APP(inheriting("2.0.0"), 'core = "1.2"\n', "version.workspace = true"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: inherited 2.0.0 does not satisfy ^1.2`);
    assert.equal(patchLimitations(artifacts).length, 1, mode);
  });
});

test("round 3: dependency forms Cargo accepts all meet a patch; a multi-line git table does not (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  for (const [form, dependency] of [
    ["dotted key", 'core.version = "1"\n'],
    ["quoted key", '"core" = "1"\n'],
    ["literal string", "core = '1'\n"],
  ] as const) {
    scanBothModes(CORE_APP(patched, dependency), (mode, artifacts) => {
      assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: ${form}`);
    });
  }
  scanBothModes(CORE_APP(patched, 'core = { features = [\n  "x",\n], git = "https://example.com/core" }\n'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: a git dependency is not overridden by [patch.crates-io]`);
  });
});

test("round 3: git sources are canonicalised like Cargo — case-folded and https only for github.com (quick + full)", () => {
  const gitPatch = (url: string, dependency: string): Record<string, string> =>
    CORE_APP(`${MEMBERS}\n[patch.${JSON.stringify(url)}]\ncore = { path = "core" }\n`, `core = { git = ${JSON.stringify(dependency)} }\n`);
  scanBothModes(gitPatch("https://gitlab.com/Acme/Core", "https://gitlab.com/acme/core"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: gitlab paths are case-sensitive`);
  });
  scanBothModes(gitPatch("https://github.com/Acme/Core.git", "http://github.com/acme/core/"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: github.com is canonicalised`);
  });
});

// CLA-587 review round 4 (Codex). Each scan case was checked by the reviewer against
// offline `cargo metadata`.

test("round 4: a dotted key with whitespace around the dot (`core . workspace = true`) keeps its path edge (quick + full)", () => {
  const root = `${MEMBERS}\n[workspace.dependencies]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(root, "core . workspace = true\n"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ app/Cargo.toml:6"], mode);
  });
  assert.deepEqual(cargoPathDependencies("[dependencies]\ncore . workspace = true\n"), [{ name: "core", path: "", line: 2, inherited: true }]);
});

test("round 4: cargoRequirementMatches follows the semver crate: partial bounds and prerelease admission", () => {
  for (const [requirement, version, expected] of [
    ["<=1", "1.4.0", true], ["<1.2", "1.1.9", true], ["<1.2", "1.2.0", false], [">1", "1.9.0", false], [">1", "2.0.0", true],
    [">=1.2", "1.2.0", true], ["=1.2", "1.2.7", true], ["~1", "1.9.0", true], ["^0", "0.9.0", true], ["^0.0", "0.0.5", true], ["^0.0", "0.1.0", false],
    ["1", "1.0.0-alpha", false], ["*", "1.0.0-rc.1", false], ["^1.0.0-alpha", "1.0.0-alpha.2", true], [">=1.0.0-alpha", "1.0.1-beta", false],
    ["1.0.0-beta", "1.0.0-alpha", false], ["1.0.0-alpha.2", "1.0.0-alpha.10", true], [">=1.0.0-alpha, <1.0.0", "1.0.0-rc.1", true],
    // unchanged behaviour (dependency-facts' existing cases + tokio's six requirements)
    ["0.7", "0.8.5", false], ["^0.7", "0.7.3", true], ["~1.2", "1.2.9", true], [">=1, <2", "2.0.0", false], ["=1.2.3", "1.2.3", true],
    ["1.*", "1.9.0", true], ["^1.51.0", "1.53.3", true], ["~2.7.0", "2.7.2", true], ["0.7.0", "0.7.20", true], ["0.1.1", "0.1.19", true],
  ] as const) {
    assert.equal(cargoRequirementMatches(requirement, version), expected, `${requirement} vs ${version}`);
  }
  assert.equal(cargoRequirementMatches("git junk", "1.0.0"), undefined);
  assert.equal(cargoRequirementMatches("1", "not-a-version"), undefined);
});

test("round 4: partial comparator bounds and prereleases gate patches like Cargo (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(patched, 'core = "<=1"\n', 'version = "1.4.0"'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: <=1 admits 1.4.0`);
    assert.deepEqual(patchLimitations(artifacts), [], mode);
  });
  scanBothModes(CORE_APP(patched, 'core = "1"\n', 'version = "1.0.0-alpha"'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: 1 does not admit the prerelease 1.0.0-alpha`);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] accepted by no scanned crate's normal dependency: version 1.0.0-alpha does not satisfy app/Cargo.toml:6 requires '1'; no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = 'core' }",
    ], mode);
  });
});

test("round 4: `version = { workspace = true }` inherits [workspace.package] like the dotted form (quick + full)", () => {
  const inheriting = (version: string): string => `${MEMBERS}\n[workspace.package]\nversion = "${version}"\n\n[patch.crates-io]\ncore = { path = "core" }\n`;
  for (const spelling of ["version = { workspace = true }", "version.workspace = true"]) {
    scanBothModes(CORE_APP(inheriting("2.0.0"), 'core = "1"\n', spelling), (mode, artifacts) => {
      assert.deepEqual(crateEdges(artifacts), [], `${mode} ${spelling}: inherited 2.0.0 does not satisfy ^1`);
      assert.equal(patchLimitations(artifacts).length, 1, `${mode} ${spelling}`);
    });
    scanBothModes(CORE_APP(inheriting("1.4.0"), 'core = "1"\n', spelling), (mode, artifacts) => {
      assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:8 app/Cargo.toml:6"], `${mode} ${spelling}: inherited 1.4.0 satisfies ^1`);
    });
  }
});

// CLA-587 review round 4 (Opus round 2): a crate without `version` is 0.0.0 for Cargo.
test("round 4: a patched crate without [package] version is 0.0.0 in the version check (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(patched, 'core = "1"\n', ""), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: ^1 does not admit 0.0.0`);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] accepted by no scanned crate's normal dependency: version 0.0.0 does not satisfy app/Cargo.toml:6 requires '1'; no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = 'core' }",
    ], mode);
  });
  scanBothModes(CORE_APP(patched, 'core = "0"\n', ""), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: ^0 admits 0.0.0`);
  });
});

// CLA-594 item 1: an explicit operator keeps its meaning when the version has a wildcard
// (`^1.2.*` is `^1.2`, `>=1.*` is `>=1`); only an implicit operator makes `1.2.*` a wildcard.
test("CLA-594: cargoRequirementMatches keeps an explicit operator alongside a wildcard", () => {
  for (const [requirement, version, expected] of [
    ["^1.2.*", "1.3.0", true], ["^1.2.*", "1.2.0", true], ["^1.2.*", "1.1.9", false], ["^1.2.*", "2.0.0", false],
    [">=1.*", "2.0.0", true], [">=1.*", "1.0.0", true], [">=1.*", "0.9.9", false],
    ["<1.*", "0.9.9", true], ["<1.*", "1.0.0", false], [">1.*", "1.9.0", false], [">1.*", "2.0.0", true],
    ["~1.*", "1.9.0", true], ["~1.*", "2.0.0", false], ["=1.2.*", "1.2.7", true], ["=1.2.*", "1.3.0", false],
    // the implicit operator is still a wildcard
    ["1.2.*", "1.3.0", false], ["1.2.*", "1.2.9", true], ["1.*", "2.0.0", false], ["1.x", "1.4.0", true],
  ] as const) {
    assert.equal(cargoRequirementMatches(requirement, version), expected, `${requirement} vs ${version}`);
  }
});

test("CLA-594: explicit-operator wildcard requirements meet a patch like Cargo (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  for (const [requirement, coreVersion] of [["^1.2.*", "1.3.0"], [">=1.*", "2.0.0"]] as const) {
    scanBothModes(CORE_APP(patched, `core = "${requirement}"\n`, `version = "${coreVersion}"`), (mode, artifacts) => {
      assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: ${requirement} admits ${coreVersion}`);
      assert.deepEqual(patchLimitations(artifacts), [], `${mode}: ${requirement}`);
    });
  }
  scanBothModes(CORE_APP(patched, 'core = "1.2.*"\n', 'version = "1.3.0"'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: the implicit wildcard 1.2.* still rejects 1.3.0`);
    assert.equal(patchLimitations(artifacts).length, 1, mode);
  });
});

// CLA-594 item 2: a quoted `"version"` key in [package] is the same field as `version`; it
// must not fall back to the 0.0.0 of a package that has no version.
test("CLA-594: a quoted [package] \"version\" key is read, not treated as missing (quick + full)", () => {
  const patched = `${MEMBERS}\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(patched, 'core = "1"\n', '"version" = "1.0.0"'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), ["container:app -> container:core @ Cargo.toml:5 app/Cargo.toml:6"], `${mode}: quoted 1.0.0 satisfies ^1`);
    assert.deepEqual(patchLimitations(artifacts), [], mode);
  });
  scanBothModes(CORE_APP(patched, 'core = "1"\n', "'version' = '2.0.0'"), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: quoted 2.0.0 does not satisfy ^1`);
    assert.deepEqual(patchLimitations(artifacts), [
      "Cargo [patch] accepted by no scanned crate's normal dependency: version 2.0.0 does not satisfy app/Cargo.toml:6 requires '1'; no crate edge recorded: Cargo.toml:5: [patch.crates-io] core = { path = 'core' }",
    ], `${mode}: the mismatch cites the version as written`);
  });
  const inheriting = `${MEMBERS}\n[workspace.package]\n"version" = "2.0.0"\n\n[patch.crates-io]\ncore = { path = "core" }\n`;
  scanBothModes(CORE_APP(inheriting, 'core = "1"\n', '"version".workspace = true'), (mode, artifacts) => {
    assert.deepEqual(crateEdges(artifacts), [], `${mode}: quoted inheritance of a quoted workspace 2.0.0 rejects ^1`);
    assert.equal(patchLimitations(artifacts).length, 1, mode);
  });
});
