import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
      // Every container is anchored on a committed path (no invented root `scripts`).
      assert.deepEqual(first.snapshot.entities.filter(entity => entity.kind === "container").flatMap(entity => entity.sourceRefs.map(ref => ref.path)).sort(), [
        "rust/crates/aa-core", "rust/crates/aa-server", "typescript/apps/cloudflare-worker", "typescript/apps/web",
        "typescript/packages/core", "typescript/packages/sdk", "typescript/scripts",
      ]);
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
      // README.md is repository-wide softwareSystem evidence, kept under --root by design.
      assert.ok(path === "README.md" || path.startsWith("typescript/"), `${path} stays repository-relative inside --root`);
      assert.ok(existsSync(join(dir, path)), `${path} is a committed path`);
    }
    const tooling = typescript.snapshot.entities.find(entity => entity.name === "Build & fixture tooling")!;
    assert.deepEqual(tooling.sourceRefs.map(ref => ref.path), ["typescript/scripts"]);
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
    assert.equal(discovery.resolution.packages.find(declaration => declaration.name === "@js/a")?.unit, "js/libs/a");
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

test("independent nested roots reusing a package name (full mode, every band): own root first; an importer in no workspace resolves only a unique name, else no relation plus a limitation", () => {
  const core = (label: string): string => `export function calculate(): string {\n  return "${label}";\n}\n`;
  withCommittedRepo({
    "a/package.json": pkg("a-root", { private: true, workspaces: ["packages/*"] }),
    "a/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "a/packages/core/index.ts": core("a"),
    "a/packages/core/sub.ts": "export function sub(): string {\n  return \"a\";\n}\n",
    "a/packages/unique/package.json": pkg("@scope/unique", { main: "./index.ts" }),
    "a/packages/unique/index.ts": "export function unique(): number {\n  return 1;\n}\n",
    "a/packages/app/package.json": pkg("@scope/app-a"),
    "a/packages/app/main.ts": "import { calculate } from \"@scope/core\";\nimport { sub } from \"@scope/core/sub\";\nexport function app(): string {\n  return calculate() + sub();\n}\n",
    // The a/ root package's own tooling: its nearest package is the root, so it resolves in a/.
    "a/scripts/build.ts": "import { calculate } from \"@scope/core\";\nexport function build(): string {\n  return calculate();\n}\n",
    // Physically under a/, but outside a's `packages/*`: in no workspace, with or without a lockfile.
    "a/apps/worker/package.json": pkg("worker"),
    "a/apps/worker/package-lock.json": "{}",
    "a/apps/worker/src/index.ts": "import { calculate } from \"@scope/core\";\nimport { unique } from \"@scope/unique\";\nexport function work(): string {\n  return calculate() + unique();\n}\n",
    "a/apps/unlocked/package.json": pkg("unlocked"),
    "a/apps/unlocked/index.ts": "import { calculate } from \"@scope/core\";\nexport function loose(): string {\n  return calculate();\n}\n",
    "b/package.json": pkg("b-root", { private: true, workspaces: ["packages/*"] }),
    "b/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "b/packages/core/index.ts": core("b"),
    "b/packages/app/package.json": pkg("@scope/app-b"),
    "b/packages/app/main.ts": "import { calculate } from \"@scope/core\";\nexport function app(): string {\n  return calculate();\n}\n",
  }, dir => {
    const artifacts = scanRepository(dir, { analysisMode: "full" });
    assert.deepEqual(edgesByPath(artifacts), [
      "a/apps/worker -> a/packages/unique",
      "a/packages/app -> a/packages/core",
      "a/scripts -> a/packages/core",
      "b/packages/app -> b/packages/core",
    ]);
    // Every band (container, component, code `uses`/`calls`), keyed by the entities' paths.
    const pathOf = new Map(artifacts.snapshot.entities.map(entity => [entity.id, entity.sourceRefs[0]?.path ?? ""]));
    const relations = artifacts.snapshot.relations.map(relation => ({ from: pathOf.get(relation.from)!, to: pathOf.get(relation.to)!, kind: relation.kind }));
    const between = (from: string, to: string) => relations.filter(relation => relation.from.startsWith(from) && relation.to.startsWith(to));
    assert.deepEqual(between("a/", "b/"), [], "nothing under a/ points into b/");
    assert.deepEqual(between("b/", "a/"), [], "nothing under b/ points into a/");
    for (const ambiguous of ["a/apps/worker", "a/apps/unlocked"]) {
      assert.deepEqual(between(ambiguous, "a/packages/core"), [], `${ambiguous} gets no relation to either @scope/core`);
    }
    assert.ok(between("a/packages/app/main.ts", "a/packages/core/index.ts").some(relation => relation.kind === "calls"), "own-root semantic call edge");
    assert.ok(between("b/packages/app/main.ts", "b/packages/core/index.ts").some(relation => relation.kind === "calls"));
    assert.ok(between("a/scripts/build.ts", "a/packages/core/index.ts").some(relation => relation.kind === "calls"), "the root package's own tooling resolves in its root");
    assert.ok(between("a/apps/worker/src/index.ts", "a/packages/unique/index.ts").some(relation => relation.kind === "calls"), "a unique name still resolves for a standalone package");
    const appEdge = artifacts.snapshot.relations.find(relation => pathOf.get(relation.from) === "a/packages/app" && pathOf.get(relation.to) === "a/packages/core")!;
    assert.deepEqual(appEdge.evidence.map(evidence => evidence.source.startLine), [1, 2], "the scoped subpath import is evidence on the own-root edge");
    const ambiguity = (artifacts.analysis.limitations ?? []).filter(line => line.startsWith("Ambiguous workspace package import"));
    assert.deepEqual(ambiguity, [
      "Ambiguous workspace package import a/apps/unlocked/index.ts:1: '@scope/core' — @scope/core is defined in a, b",
      "Ambiguous workspace package import a/apps/worker/src/index.ts:1: '@scope/core' — @scope/core is defined in a, b",
    ]);
    // `--root a` leaves one @scope/core, so the worker's import is unique there.
    assert.ok(edgesByPath(scanRepository(dir, { analysisMode: "quick", root: "a" })).includes("a/apps/worker -> a/packages/core"));
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

const SCOPE_APP = "import { calculate } from \"@scope/core\";\nexport function app(): string {\n  return calculate();\n}\n";
const scopeCore = (label: string): string => `export function calculate(): string {\n  return "${label}";\n}\n`;
/** Every relation (all bands) as `kind from -> to`, keyed by entity evidence paths. */
function allRelations(artifacts: ScanArtifacts): string[] {
  const pathOf = new Map(artifacts.snapshot.entities.map(entity => [entity.id, entity.sourceRefs[0]?.path ?? ""]));
  return artifacts.snapshot.relations.map(relation => `${relation.kind} ${pathOf.get(relation.from)} -> ${pathOf.get(relation.to)}`).sort();
}

test("own root first even without scanned source: a sourceless or skipped own member never falls through to another root (every band)", () => {
  for (const own of [
    { "a/packages/core/package.json": pkg("@scope/core", { main: "./index.vue" }), "a/packages/core/index.vue": "<template/>\n" },
    { "a/packages/examples/package.json": pkg("@scope/core", { main: "./index.ts" }), "a/packages/examples/index.ts": scopeCore("skipped") },
  ]) {
    withCommittedRepo({
      "a/package.json": pkg("a", { private: true, workspaces: ["packages/*"] }),
      ...own,
      "a/packages/app/package.json": pkg("@scope/app-a"),
      "a/packages/app/main.ts": SCOPE_APP,
      "b/package.json": pkg("b", { private: true, workspaces: ["packages/*"] }),
      "b/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
      "b/packages/core/index.ts": scopeCore("b"),
    }, dir => {
      for (const analysisMode of ["quick", "full"] as const) {
        const relations = allRelations(scanRepository(dir, { analysisMode }));
        assert.deepEqual(relations.filter(line => line.includes(" a/") && line.includes("-> b/")), [], `${analysisMode}: ${relations.join("\n")}`);
      }
    });
  }
});

test("--root a / --root b (full) keep in-root container, component and call edges when the sibling root reuses the name", () => {
  withCommittedRepo({
    "a/package.json": pkg("a", { private: true, workspaces: ["packages/*"] }),
    "a/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "a/packages/core/index.ts": scopeCore("a"),
    "a/packages/app/package.json": pkg("@scope/app-a"),
    "a/packages/app/main.ts": SCOPE_APP,
    "b/package.json": pkg("b", { private: true, workspaces: ["packages/*"] }),
    "b/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "b/packages/core/index.ts": scopeCore("b"),
    "b/packages/app/package.json": pkg("@scope/app-b"),
    "b/packages/app/main.ts": SCOPE_APP,
  }, dir => {
    for (const root of ["a", "b"]) {
      assert.deepEqual(allRelations(scanRepository(dir, { analysisMode: "full", root })), [
        `calls ${root}/packages/app/main.ts -> ${root}/packages/core/index.ts`,
        `dependsOn ${root}/packages/app -> ${root}/packages/core`,
        `dependsOn ${root}/packages/app/main.ts -> ${root}/packages/core/index.ts`,
      ], `--root ${root}`);
    }
  });
});

test("A5: a name defined only in another root resolves unless the importer's package.json rules that package out", () => {
  const cases: Array<[spec: string, version: string, linked: boolean]> = [
    ["^1.2.0", "1.4.0", true], ["^2", "1.4.0", false], ["^0.2.0", "0.3.0", false], ["1.2", "1.9.0", false],
    ["workspace:*", "1.0.0", false], ["npm:other@^1", "1.0.0", false], ["github:o/r", "1.0.0", false],
    ["file:../../../b/packages/core", "1.0.0", true], ["file:../elsewhere", "1.0.0", false], ["^1", "not-a-version", false],
  ];
  withCommittedRepo(Object.assign({
    "b/package.json": pkg("b", { private: true, workspaces: ["packages/*"] }),
  }, ...cases.map(([spec, version], index) => ({
    [`b${index}/package.json`]: pkg(`b${index}`, { private: true, workspaces: ["packages/*"] }),
    [`b${index}/packages/core/package.json`]: pkg(`@v${index}/core`, { version, main: "./index.ts" }),
    [`b${index}/packages/core/index.ts`]: scopeCore(String(index)),
    [`a${index}/package.json`]: pkg(`a${index}`, { private: true, workspaces: ["packages/*"] }),
    [`a${index}/packages/app/package.json`]: pkg(`@a${index}/app`, { dependencies: { [`@v${index}/core`]: spec.replace("b/packages", `b${index}/packages`) } }),
    [`a${index}/packages/app/main.ts`]: SCOPE_APP.replace("@scope/core", `@v${index}/core`),
  }))), dir => {
    const artifacts = scanRepository(dir, { analysisMode: "full" });
    const relations = allRelations(artifacts);
    const limitations = artifacts.analysis.limitations ?? [];
    cases.forEach(([spec, version, linked], index) => {
      const edges = relations.filter(line => line.startsWith(`dependsOn a${index}/`) && line.includes(`-> b${index}/`));
      assert.equal(edges.length > 0, linked, `${spec} vs ${version}: ${edges.join(", ")}`);
      assert.equal(limitations.some(line => line.startsWith(`Cross-root package import not linked a${index}/`)), !linked, `${spec} vs ${version} limitation`);
      assert.ok(!limitations.some(line => line.includes(`@v${index}/core`) && line.startsWith("Ambiguous")));
    });
  });
});

test("own-root duplicate type references resolve in the importer's root (full)", () => {
  withCommittedRepo({
    "a/package.json": pkg("a", { private: true, workspaces: ["packages/*"] }),
    "a/packages/types/package.json": pkg("@scope/types", { types: "./index.ts" }),
    "a/packages/types/index.ts": "export interface Shape { a: number }\nexport function shapeA(): Shape {\n  return { a: 1 };\n}\n",
    "a/packages/app/package.json": pkg("@scope/app-a"),
    "a/packages/app/main.ts": "/// <reference types=\"@scope/types\" />\nimport { shapeA } from \"@scope/types\";\nexport const x = shapeA();\n",
    "b/package.json": pkg("b", { private: true, workspaces: ["packages/*"] }),
    "b/packages/types/package.json": pkg("@scope/types", { types: "./index.ts" }),
    "b/packages/types/index.ts": "export interface Shape { b: string }\nexport function shapeB(): Shape {\n  return { b: \"\" };\n}\n",
  }, dir => {
    const artifacts = scanRepository(dir, { analysisMode: "full" });
    const relations = allRelations(artifacts);
    assert.ok(relations.includes("calls a/packages/app/main.ts -> a/packages/types/index.ts"), relations.join("\n"));
    assert.deepEqual(relations.filter(line => line.includes(" a/") && line.includes("-> b/")), []);
    assert.ok(!(artifacts.analysis.limitations ?? []).some(line => /a\/packages\/app\/main\.ts.*TS2688/.test(line)), "the type reference resolves");
  });
});

test("the scan's package decision is authoritative over tsconfig paths: a mapping into another root's same-named package is not linked; an own-root mapping still is", () => {
  const files = (target: string): Record<string, string> => ({
    "a/package.json": pkg("a", { private: true, workspaces: ["packages/*"] }),
    "a/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, paths: { "@scope/core": [target] } }, include: ["packages/**/*.ts"] }),
    "a/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "a/packages/core/index.ts": scopeCore("a"),
    "a/packages/app/package.json": pkg("@scope/app-a"),
    "a/packages/app/main.ts": SCOPE_APP,
    "b/package.json": pkg("b", { private: true, workspaces: ["packages/*"] }),
    "b/packages/core/package.json": pkg("@scope/core", { main: "./index.ts" }),
    "b/packages/core/index.ts": scopeCore("b"),
  });
  for (const target of ["../b/packages/core/index.ts", "./packages/core/index.ts"]) {
    withCommittedRepo(files(target), dir => {
      const relations = allRelations(scanRepository(dir, { analysisMode: "full" }));
      assert.deepEqual(relations.filter(line => line.includes(" a/") && line.includes("-> b/")), [], `${target}: ${relations.join("\n")}`);
      assert.ok(relations.includes("calls a/packages/app/main.ts -> a/packages/core/index.ts"), `${target}: ${relations.join("\n")}`);
      assert.ok(relations.includes("dependsOn a/packages/app/main.ts -> a/packages/core/index.ts"), target);
    });
  }
});
