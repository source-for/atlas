import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRepository } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { boundStableId, MAX_STABLE_ID_CHARACTERS } from "./ids.js";
import { acquireCommittedTree, pinRepository } from "./pin.js";
import { portableAtlasFromScan } from "./portable.js";
import { buildScanArtifacts, scanAcquiredRepository, stableJson, type ScanArtifacts } from "./scan.js";
import { ASPECT_PRESET_TARGET, serializePortableAtlas } from "@okie/architecture";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readFile = (path: string): string => readFileSync(`${repoRoot}${path}`, "utf8");

/** Deterministic LCG shuffle so the test itself uses no wall-clock randomness. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = (seed * 2654435761) >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x100000000;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = result[i]!;
    result[i] = result[j]!;
    result[j] = a;
  }
  return result;
}

test("extraction is byte-identical across many shuffled discovery orders", () => {
  const discovery = discoverRepository(repoRoot);
  assert.ok(discovery.sourceFiles.length > 40, "expected a non-trivial source set");
  const canonical = stableJson(extractArchitecture({ discovery, readFile, systemName: "Okie", systemSlug: "okie" }));
  for (let seed = 1; seed <= 24; seed += 1) {
    const shuffled = {
      ...discovery,
      sourceFiles: shuffle(discovery.sourceFiles, seed),
      units: shuffle(discovery.units, seed + 500),
    };
    const output = stableJson(extractArchitecture({ discovery: shuffled, readFile, systemName: "Okie", systemSlug: "okie" }));
    assert.equal(output, canonical, `extraction differs under shuffle seed ${seed}`);
  }
});

test("full scan artifacts are byte-identical across reversed discovery order", () => {
  // snapshot/view/story/scene/timeline are pure functions of the (order-independent)
  // extraction, so one reversed pass proves the whole artifact set is deterministic.
  const pin = pinRepository(repoRoot);
  const discovery = discoverRepository(repoRoot);
  const canonical = buildScanArtifacts({ discovery, pin, readFile, repositorySlug: "okie", systemName: "Okie" });
  const reversed = buildScanArtifacts({
    discovery: { ...discovery, sourceFiles: [...discovery.sourceFiles].reverse(), units: [...discovery.units].reverse() },
    pin,
    readFile,
    repositorySlug: "okie",
    systemName: "Okie",
  });
  for (const key of ["extraction", "snapshot", "view", "story", "stories", "catalog", "scene", "timeline"] as const) {
    assert.equal(stableJson(canonical[key]), stableJson(reversed[key]), `${key} differs under reversed discovery order`);
  }
  const world = canonical.scene.worldBounds;
  const aspect = world.width / world.height;
  assert.ok(aspect >= 1.4, `scan CLI scene.json aspect ${aspect.toFixed(3)} must be landscape ≥ 1.4 (CLA-96)`);
  assert.equal(ASPECT_PRESET_TARGET.landscape, 1.6);
});

// Guard, not a before/after proof: every id Okie's own scan emits is within the
// 192-character limit, where bounding is the identity by construction. (Byte-identical
// before/after scans of this repo were compared by hand for CLA-299.)
test("CLA-299: every id in Okie's own scan is within the 192-character limit (bounding leaves it unchanged)", () => {
  const pin = pinRepository(repoRoot);
  const discovery = discoverRepository(repoRoot);
  const artifacts = buildScanArtifacts({ discovery, pin, readFile, repositorySlug: "okie", systemName: "Okie" });
  const ids = [
    artifacts.snapshot.id,
    artifacts.snapshot.repositoryId,
    artifacts.view.id,
    ...artifacts.stories.flatMap(story => [story.id, ...story.steps.map(step => step.id)]),
    ...artifacts.snapshot.entities.flatMap(entity => [entity.id, ...(entity.parentId ? [entity.parentId] : [])]),
    ...artifacts.snapshot.relations.flatMap(relation => [relation.id, relation.from, relation.to, ...(relation.lineageId ? [relation.lineageId] : [])]),
  ];
  assert.ok(ids.length > 500, "a non-trivial id set");
  for (const id of ids) {
    assert.ok(id.length <= MAX_STABLE_ID_CHARACTERS, `${id} exceeds the limit`);
    assert.equal(boundStableId(id), id);
  }
  // No acquisition limitation applies to this repository (no symlinks, submodules or testdata/).
  // Scan-level limitations it does have (CLA-578): one test-fixture .js left out, and two
  // relative imports of untracked build output (the generated stress fixture JSON and a
  // script reading `dist/`) that no scanned source file backs. Lines are not pinned.
  const [jsLine, unresolvedHeader, ...unresolved] = artifacts.analysis.limitations ?? [];
  assert.equal(jsLine, "1 .js file(s) in this TypeScript repository were not scanned: 1 under a test/fixture/vendor directory.");
  assert.equal(unresolvedHeader, "2 relative import(s) name no file in the repository; no relation was recorded for them.");
  assert.equal(unresolved.length, 2);
  assert.match(unresolved[0]!, /^Unresolved relative import apps\/web\/src\/renderer\/stressFixture\.ts:\d+: '\.\.\/\.\.\/\.\.\/\.\.\/fixtures\/renderer\/stress-5000\.json'$/);
  assert.match(unresolved[1]!, /^Unresolved relative import packages\/scene-compiler\/scripts\/generate-golden-source-excerpts\.mjs:\d+: '\.\.\/dist\/golden-source-excerpts\.js'$/);
  assert.equal(artifacts.discoverySummary.skippedEntries, undefined);
  assert.equal(artifacts.discoverySummary.excludedTestDataFiles, undefined);
});

/** Every file the CLI writes for a scan, keyed by its output name. */
function writtenArtifacts(artifacts: ScanArtifacts): Record<string, string> {
  return {
    "atlas.okie.json": serializePortableAtlas(portableAtlasFromScan(artifacts)),
    "extraction.json": stableJson(artifacts.extraction),
    "snapshot.json": stableJson(artifacts.snapshot),
    "view.json": stableJson(artifacts.view),
    "story.json": stableJson(artifacts.story),
    "stories.json": stableJson(artifacts.catalog),
    "scene.json": stableJson(artifacts.scene),
    "timeline.json": stableJson(artifacts.timeline),
    "dependencies.json": stableJson(artifacts.dependencies),
    "membership-report.json": stableJson(artifacts.membership),
  };
}

test("CLA-586: two full scans of one commit, checked out under different temp roots, are byte-identical", () => {
  const work = mkdtempSync(join(tmpdir(), "okie-cla586-"));
  const source = join(work, "source");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: source, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } });
  };
  try {
    // Compiler messages that name absolute files: a config matching no inputs (TS18003)
    // and an import from outside rootDir (TS6059, which also names package.json).
    const files: Record<string, string> = {
      "package.json": '{"name":"stable-full-scan","type":"module"}\n',
      "tsconfig.json": '{"compilerOptions":{"rootDir":"src","outDir":"dist","strict":true,"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src","lib"]}\n',
      "empty/tsconfig.json": '{"include":["nothing/**/*.ts"]}\n',
      "src/a.ts": 'import { b } from "../lib/b.js";\nexport const a: number = b + 1;\n',
      "lib/b.ts": "export const b = 1;\n",
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(source, path)), { recursive: true });
      writeFileSync(join(source, path), text);
    }
    git(["init", "-q", "-b", "main"]);
    git(["add", "."]);
    git(["-c", "user.name=Okie", "-c", "user.email=okie@example.test", "commit", "-qm", "fixture"]);

    // Different temp roots (and different lengths) so the checkout path really differs per run.
    const runs = ["first", "second-run"].map(name => {
      const tempRoot = join(work, name);
      mkdirSync(tempRoot);
      const acquired = acquireCommittedTree(source, "HEAD", { tempRoot });
      try {
        return { tempRoot, root: acquired.root, written: writtenArtifacts(scanAcquiredRepository(acquired, { analysisMode: "full" })) };
      } finally {
        acquired.cleanup();
      }
    });
    const [first, second] = runs as [typeof runs[number], typeof runs[number]];
    assert.notEqual(first.root, second.root);
    for (const name of Object.keys(first.written)) {
      assert.equal(second.written[name], first.written[name], `${name} differs between two full scans of the same commit`);
      for (const run of runs) assert.ok(!second.written[name]!.includes(run.tempRoot), `${name} names the temp checkout ${run.tempRoot}`);
      assert.ok(!first.written[name]!.includes(work), `${name} names the fixture location ${work}`);
    }
    // The diagnostics are still reported, with root-relative paths.
    const atlas = first.written["atlas.okie.json"]!;
    assert.match(atlas, /No inputs were found in config file 'empty\/tsconfig\.json'/);
    assert.match(atlas, /TS6059: File 'lib\/b\.ts' is not under 'rootDir' 'src'/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
