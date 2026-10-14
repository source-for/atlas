import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRepository } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { boundStableId, MAX_STABLE_ID_CHARACTERS } from "./ids.js";
import { pinRepository } from "./pin.js";
import { buildScanArtifacts, stableJson } from "./scan.js";
import { ASPECT_PRESET_TARGET } from "@okie/architecture";

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
  assert.equal(unresolvedHeader, "2 relative import(s) did not resolve to a scanned source file; no relation was recorded for them.");
  assert.equal(unresolved.length, 2);
  assert.match(unresolved[0]!, /^Unresolved relative import apps\/web\/src\/renderer\/stressFixture\.ts:\d+: '\.\.\/\.\.\/\.\.\/\.\.\/fixtures\/renderer\/stress-5000\.json'$/);
  assert.match(unresolved[1]!, /^Unresolved relative import packages\/scene-compiler\/scripts\/generate-golden-source-excerpts\.mjs:\d+: '\.\.\/dist\/golden-source-excerpts\.js'$/);
  assert.equal(artifacts.discoverySummary.skippedEntries, undefined);
  assert.equal(artifacts.discoverySummary.excludedTestDataFiles, undefined);
});
