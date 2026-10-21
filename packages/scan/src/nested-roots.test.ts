import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRepository, normalizeScanRoot } from "./discover.js";
import { scanOutputFiles, scanRepository, type ScanArtifacts } from "./scan.js";

/** CLA-605: an aa-router-shaped tree (pnpm in typescript/, Cargo in rust/, a standalone worker). */
const AA_ROUTER_FIXTURE = fileURLToPath(new URL("../../../fixtures/nested-roots/aa-router", import.meta.url));

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z" },
  }).trim();
}

/** A committed temporary Git repository: an initial README commit, then the aa-router fixture. */
function withAaRouterRepo(run: (dir: string, commits: { before: string; head: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-nested-roots-"));
  try {
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "README.md"), "# aa-router\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "readme only"]);
    const before = git(dir, ["rev-parse", "HEAD"]);
    cpSync(AA_ROUTER_FIXTURE, dir, { recursive: true });
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "aa-router layout"]);
    run(dir, { before, head: git(dir, ["rev-parse", "HEAD"]) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Container names, and container-to-container edges as `from -> to`, both sorted. */
function containerGraph(artifacts: ScanArtifacts): { containers: string[]; edges: string[] } {
  const containers = new Map(artifacts.snapshot.entities.filter(entity => entity.kind === "container").map(entity => [entity.id, entity.name]));
  const edges = artifacts.snapshot.relations
    .filter(relation => containers.has(relation.from) && containers.has(relation.to))
    .map(relation => `${containers.get(relation.from)} -> ${containers.get(relation.to)}`);
  return { containers: [...containers.values()].sort(), edges: edges.sort() };
}

const EXPECTED_CONTAINERS = ["@aa/core", "@aa/sdk", "@aa/web", "Build & fixture tooling", "aa-core", "aa-router-worker", "aa-server"];
const EXPECTED_EDGES = [
  "@aa/sdk -> @aa/core",
  "@aa/web -> @aa/sdk",
  "Build & fixture tooling -> @aa/core",
  "aa-router-worker -> @aa/core",
  // Inherited `aa-core = { workspace = true }`: resolved against rust/Cargo.toml, not a repo-root manifest.
  "aa-server -> aa-core",
];

for (const analysisMode of ["quick", "full"] as const) {
  test(`aa-router fixture (${analysisMode}): nested pnpm + Cargo roots and a standalone worker give the expected containers and edges, byte-stable`, () => {
    withAaRouterRepo(dir => {
      const first = scanRepository(dir, { analysisMode });
      assert.deepEqual(containerGraph(first), { containers: EXPECTED_CONTAINERS, edges: EXPECTED_EDGES });
      // The worker's `@aa/core/policy` subpath import is evidence on the same package edge.
      const worker = first.snapshot.entities.find(entity => entity.name === "aa-router-worker")!;
      const core = first.snapshot.entities.find(entity => entity.name === "@aa/core")!;
      const workerEdge = first.snapshot.relations.find(relation => relation.from === worker.id && relation.to === core.id)!;
      assert.deepEqual(workerEdge.evidence.map(evidence => `${evidence.source.path}:${evidence.source.startLine}`),
        ["typescript/apps/cloudflare-worker/src/index.ts:1", "typescript/apps/cloudflare-worker/src/index.ts:2"]);
      // Example and vendored roots are never promoted (no `aa-demo` / `legacy` container).
      assert.deepEqual(first.discoverySummary.nestedWorkspaceRoots, ["rust", "typescript"]);
      assert.deepEqual(first.discoverySummary.standalonePackages, ["typescript/apps/cloudflare-worker"]);
      const second = scanRepository(dir, { analysisMode });
      assert.deepEqual(scanOutputFiles(second), scanOutputFiles(first), "two scans of the same commit are byte-identical");
    });
  });
}

test("--root keeps repository-relative paths and the real commit, scans only that committed subtree", () => {
  withAaRouterRepo((dir, commits) => {
    const typescript = scanRepository(dir, { analysisMode: "quick", root: "./typescript/" });
    assert.equal(typescript.snapshot.commitSha, commits.head);
    assert.equal(typescript.discoverySummary.scanRoot, "typescript");
    assert.deepEqual(containerGraph(typescript), {
      containers: ["@aa/core", "@aa/sdk", "@aa/web", "Build & fixture tooling", "aa-router-worker"],
      edges: ["@aa/sdk -> @aa/core", "@aa/web -> @aa/sdk", "Build & fixture tooling -> @aa/core", "aa-router-worker -> @aa/core"],
    });
    const paths = new Set([
      ...typescript.snapshot.entities.flatMap(entity => entity.sourceRefs.map(ref => ref.path)),
      ...typescript.snapshot.relations.flatMap(relation => relation.evidence.map(evidence => evidence.source.path)),
    ]);
    assert.ok(paths.has("typescript/apps/cloudflare-worker/src/index.ts"), "evidence keeps the typescript/ prefix");
    for (const path of paths) {
      assert.ok(path === "README.md" || path === "scripts" || path.startsWith("typescript/"), `${path} stays repository-relative inside --root`);
    }
    for (const ref of typescript.snapshot.relations.flatMap(relation => relation.evidence.map(evidence => evidence.source))) {
      assert.equal(ref.commitSha, commits.head, "evidence cites the real commit");
    }

    // Only the committed tree is read: dirty and untracked files under the root change nothing.
    appendFileSync(join(dir, "typescript/packages/core/src/policy.ts"), "export const dirty = 1;\n");
    mkdirSync(join(dir, "typescript/packages/untracked/src"), { recursive: true });
    writeFileSync(join(dir, "typescript/packages/untracked/package.json"), JSON.stringify({ name: "@aa/untracked" }));
    writeFileSync(join(dir, "typescript/packages/untracked/src/index.ts"), "export const u = 1;\n");
    assert.deepEqual(scanOutputFiles(scanRepository(dir, { analysisMode: "quick", root: "typescript" })), scanOutputFiles(typescript));

    const rust = scanRepository(dir, { analysisMode: "quick", root: "rust" });
    assert.equal(rust.snapshot.commitSha, commits.head);
    assert.ok(containerGraph(rust).edges.includes("aa-server -> aa-core"));
    assert.ok(!containerGraph(rust).containers.some(name => name.startsWith("@aa/")), "nothing from typescript/ leaks into --root rust");
  });
});

test("--root fails loudly on traversal, absolute, missing, file, symlinked and not-yet-existing roots", () => {
  assert.throws(() => normalizeScanRoot("/etc"), /repository-relative/);
  assert.throws(() => normalizeScanRoot("typescript/../../x"), /inside the repository/);
  assert.equal(normalizeScanRoot("."), undefined);
  withAaRouterRepo((dir, commits) => {
    symlinkSync("typescript", join(dir, "ts-link"));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "link"]);
    for (const root of ["missing", "typescript/package.json", "ts-link"]) {
      assert.throws(() => scanRepository(dir, { analysisMode: "quick", root }), /no committed files under this directory/, root);
    }
    // An older pinned revision without typescript/ fails rather than scanning the whole repository.
    assert.throws(() => scanRepository(dir, { analysisMode: "quick", root: "typescript", revision: commits.before }), /no committed files/);
  });
});

/** A staged (uncommitted) repo is enough for discovery: `git ls-files` lists staged files. */
function withStagedRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "okie-nested-roots-"));
  try {
    git(dir, ["init", "-q"]);
    for (const [relative, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, relative)), { recursive: true });
      writeFileSync(join(dir, relative), content);
    }
    git(dir, ["add", "-A"]);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("nested roots: yarn object-form workspaces and a Cargo root package; the deepest root's globs decide; fixture roots stay out", () => {
  withStagedRepo({
    // The outer workspace would claim js/libs/hidden via `**`; the nested root's globs exclude it.
    "package.json": JSON.stringify({ name: "outer", workspaces: ["apps/*", "js/**"] }),
    "apps/site/package.json": JSON.stringify({ name: "site" }),
    "apps/site/index.ts": "export const site = 1;\n",
    "js/package.json": JSON.stringify({ name: "js-root", private: true, workspaces: { packages: ["libs/*", "!libs/hidden"] } }),
    "js/yarn.lock": "# yarn lockfile v1\n",
    "js/libs/a/package.json": JSON.stringify({ name: "@js/a" }),
    "js/libs/a/index.ts": "export const a = 1;\n",
    "js/libs/hidden/package.json": JSON.stringify({ name: "@js/hidden" }),
    "js/libs/hidden/index.ts": "export const hidden = 1;\n",
    // A Cargo workspace root that is also a package is a crate of its own.
    "engine/Cargo.toml": "[package]\nname = \"engine\"\n\n[workspace]\nmembers = [\"plugins/*\"]\n",
    "engine/src/lib.rs": "pub fn run() {}\n",
    "engine/plugins/p1/Cargo.toml": "[package]\nname = \"p1\"\n",
    "engine/plugins/p1/src/lib.rs": "pub fn p1() {}\n",
    // Test-fixture roots below a real root are not discovered, and their lockfile package is no container.
    "apps/site/fixtures/ws/pnpm-workspace.yaml": "packages:\n  - \"pkgs/*\"\n",
    "apps/site/fixtures/ws/pkgs/f/package.json": JSON.stringify({ name: "fixture-pkg" }),
    "apps/site/fixtures/ws/pkgs/f/package-lock.json": "{}",
    "apps/site/fixtures/ws/pkgs/f/f.ts": "export const f = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    const unitOf = (file: string): string | undefined => discovery.unitByFile.get(file);
    assert.equal(unitOf("js/libs/a/index.ts"), "js/libs/a");
    assert.notEqual(unitOf("js/libs/hidden/index.ts"), "js/libs/hidden", "the nested root's negation wins over the outer `js/**`");
    assert.equal(unitOf("engine/src/lib.rs"), "engine");
    assert.equal(unitOf("engine/plugins/p1/src/lib.rs"), "engine/plugins/p1");
    assert.equal(unitOf("apps/site/fixtures/ws/pkgs/f/f.ts"), "apps/site", "a fixture root's files stay with their real owner");
    assert.deepEqual(discovery.summary.nestedWorkspaceRoots, ["engine", "js"]);
    assert.equal(discovery.summary.standalonePackages, undefined);
    assert.equal(discovery.unitByPackageName.get("@js/a"), "js/libs/a");
  });
});

/** A committed temporary Git repository holding exactly `files`. */
function withCommittedRepo(files: Record<string, string>, run: (dir: string) => void): void {
  withStagedRepo(files, dir => {
    git(dir, ["commit", "-qm", "fixture"]);
    run(dir);
  });
}

/** Container-to-container edges keyed by each container's evidence path, sorted. */
function edgesByPath(artifacts: ScanArtifacts): string[] {
  const pathOf = new Map(artifacts.snapshot.entities.filter(entity => entity.kind === "container").map(entity => [entity.id, entity.sourceRefs[0]!.path]));
  return artifacts.snapshot.relations
    .filter(relation => pathOf.has(relation.from) && pathOf.has(relation.to))
    .map(relation => `${pathOf.get(relation.from)} -> ${pathOf.get(relation.to)}`)
    .sort();
}

const pkg = (name: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ name, ...extra });

test("independent nested roots reusing a package name: own root first; an outside-workspace importer resolves only a unique name, else no edge plus a limitation", () => {
  withCommittedRepo({
    "a/package.json": pkg("a-root", { private: true, workspaces: ["packages/*"] }),
    "a/packages/core/package.json": pkg("@scope/core"),
    "a/packages/core/index.ts": "export const core = 'a';\n",
    "a/packages/core/sub.ts": "export const sub = 'a';\n",
    "a/packages/unique/package.json": pkg("@scope/unique"),
    "a/packages/unique/index.ts": "export const unique = 1;\n",
    "a/packages/app/package.json": pkg("@scope/app-a"),
    "a/packages/app/main.ts": "import { core } from \"@scope/core\";\nimport { sub } from \"@scope/core/sub\";\nexport const app = core + sub;\n",
    // Physically under a/, but outside a's `packages/*` and with its own lockfile: in no workspace.
    "a/apps/worker/package.json": pkg("worker"),
    "a/apps/worker/package-lock.json": "{}",
    "a/apps/worker/src/index.ts": "import { core } from \"@scope/core\";\nimport { unique } from \"@scope/unique\";\nexport const w = core + unique;\n",
    "b/package.json": pkg("b-root", { private: true, workspaces: ["packages/*"] }),
    "b/packages/core/package.json": pkg("@scope/core"),
    "b/packages/core/index.ts": "export const core = 'b';\n",
    "b/packages/app/package.json": pkg("@scope/app-b"),
    "b/packages/app/main.ts": "import { core } from \"@scope/core\";\nexport const app = core;\n",
  }, dir => {
    const artifacts = scanRepository(dir, { analysisMode: "quick" });
    assert.deepEqual(edgesByPath(artifacts), [
      "a/apps/worker -> a/packages/unique",
      "a/packages/app -> a/packages/core",
      "b/packages/app -> b/packages/core",
    ]);
    const appEdge = artifacts.snapshot.relations.find(relation => relation.evidence.some(evidence => evidence.source.path === "a/packages/app/main.ts"))!;
    assert.deepEqual(appEdge.evidence.map(evidence => evidence.source.startLine), [1, 2], "the scoped subpath import is evidence on the own-root edge");
    const limitations = artifacts.analysis.limitations ?? [];
    assert.ok(limitations.includes("Ambiguous workspace package import a/apps/worker/src/index.ts:1: '@scope/core' — @scope/core is defined in a, b"), limitations.join("\n"));
    assert.equal(limitations.filter(line => line.startsWith("Ambiguous workspace package import")).length, 1);
    // `--root a` leaves one @scope/core, so the worker's import is unique there.
    assert.deepEqual(edgesByPath(scanRepository(dir, { analysisMode: "quick", root: "a" })), [
      "a/apps/worker -> a/packages/core",
      "a/apps/worker -> a/packages/unique",
      "a/packages/app -> a/packages/core",
    ]);
  });
});

test("a nested package.json with an empty workspaces list is still a root: an outer `**` glob does not claim its packages", () => {
  withStagedRepo({
    "package.json": pkg("outer", { workspaces: ["js/**"] }),
    "js/package.json": pkg("js-root", { workspaces: [] }),
    "js/pkg/package.json": pkg("@js/pkg"),
    "js/pkg/index.ts": "export const p = 1;\n",
    "js/other/package.json": pkg("@js/other", { workspaces: { packages: [] } }),
    "js/other/inner/package.json": pkg("@js/inner"),
    "js/other/inner/index.ts": "export const i = 1;\n",
  }, dir => {
    const discovery = discoverRepository(dir);
    assert.notEqual(discovery.unitByFile.get("js/pkg/index.ts"), "js/pkg");
    assert.notEqual(discovery.unitByFile.get("js/other/inner/index.ts"), "js/other/inner");
    assert.deepEqual(discovery.summary.nestedWorkspaceRoots, ["js", "js/other"]);
  });
});
