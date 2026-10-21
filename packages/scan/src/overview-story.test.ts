import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  STORY_AUTHORING_LIMITS,
  validateStory,
  type ArchitectureExtraction,
  type ArchitectureStory,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { buildOverviewStory } from "./overview-story.js";
import { buildScanArtifacts, scanRepository, stableJson } from "./scan.js";
import { testResolution } from "./test-resolution.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"],
    ]),
    resolution: testResolution(new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]])),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

test("synthetic scan overview is a multi-step C4 tour, not a commit restatement", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const { story, snapshot, view, timeline } = artifacts;

  assert.equal(story.id, "story:acme:overview");
  assert.ok(story.steps.length > 1, `expected a tour, got ${story.steps.length} step(s)`);
  assert.deepEqual(validateStory(snapshot, view, story), []);

  const reveals = story.steps.map(step => step.reveal);
  assert.ok(reveals.includes("context"), "tour includes system context");
  assert.ok(reveals.includes("container"), "tour includes containers");
  assert.ok(reveals.includes("component"), "tour includes a component");
  assert.ok(reveals.includes("code"), "tour includes a code declaration");

  for (const step of story.steps) {
    assert.match(step.narration, /\S/u);
    assert.equal(/scanned at commit/i.test(step.narration), false, `${step.id} restates the scan commit`);
    assert.ok(step.focusEntityIds.length >= 1);
    assert.notEqual(step.id, "step:overview");
  }

  const focusKeys = new Set(story.steps.map(step => step.focusEntityIds.slice().sort().join(",")));
  assert.ok(focusKeys.size > 1, "steps must focus different entities, not repeat one commit beat");

  assert.ok(timeline.keyframes.length >= 4, "compiled timeline has arrival+hold per visible step");
  assert.equal(timeline.keyframes.length % 2, 0);
});

test("Okie self-scan overview is a real atlas tour", () => {
  const { story, snapshot, view, timeline } = scanRepository(repoRoot, {
    systemName: "Okie",
    repositorySlug: "thiss-okie",
  });

  assert.equal(story.id, "story:thiss-okie:overview");
  assert.ok(story.steps.length > 1, `expected a tour, got ${story.steps.length} step(s)`);
  assert.deepEqual(validateStory(snapshot, view, story), [], "overview story must stay valid");

  const reveals = new Set(story.steps.map(step => step.reveal));
  for (const band of ["context", "container", "component", "code"] as const) {
    assert.ok(reveals.has(band), `Okie overview is missing a ${band} step`);
  }

  assert.equal(story.steps.some(step => /scanned at commit/i.test(step.narration)), false);
  assert.ok(story.steps[0]!.title.startsWith("Start with "));
  assert.ok(story.steps.some(step => step.focusEntityIds.some(id => snapshot.entities.find(entity => entity.id === id)?.kind === "container")));

  const cited = story.steps.flatMap(step => step.sourceRefs ?? []);
  assert.ok(cited.length > 0, "tour cites snapshot evidence");
  assert.ok(cited.every(ref => ref.commitSha === snapshot.commitSha));

  assert.ok(timeline.keyframes.length >= 2 * Math.min(2, story.steps.length));
});

test("overview story is byte-identical across reversed discovery order", () => {
  const forward = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const reversedDiscovery: Discovery = {
    ...discovery(),
    sourceFiles: [...discovery().sourceFiles].reverse(),
    units: [...discovery().units].reverse(),
  };
  const reversed = buildScanArtifacts({
    discovery: reversedDiscovery,
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.equal(stableJson(forward.story), stableJson(reversed.story));
  assert.equal(
    stableJson(buildOverviewStory(forward.snapshot, forward.view, "system:acme", "acme", "Acme")),
    stableJson(forward.story),
  );
});

function tourSpine(story: ArchitectureStory) {
  return story.steps.map(step => ({
    id: step.id,
    title: step.title,
    reveal: step.reveal,
    focusEntityIds: [...step.focusEntityIds],
    traceRelationIds: step.traceRelationIds ? [...step.traceRelationIds] : undefined,
    durationMs: step.durationMs,
  }));
}

function containerSummaryDoc(extraction: ArchitectureExtraction, containerId: string, withCode = false) {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const components = extraction.entities.filter(entity => entity.kind === "component" && entity.parentId === containerId);
  const code = withCode
    ? extraction.entities.find(entity => entity.kind === "code" && entity.id.endsWith(":alpha"))
    : undefined;
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      {
        id: container.id, kind: "container", parentId: system.id, name: container.name,
        responsibility: "Scanner-scoped container summary.", sourceRefs: [],
      },
      ...components.map(component => ({
        id: component.id, kind: "component", parentId: containerId, name: component.name,
        responsibility: `Summary of ${component.name}.`, sourceRefs: [],
      })),
      ...(code ? [{
        id: code.id, kind: "code", parentId: code.parentId, name: code.name,
        responsibility: "Optional in-scope code summary.",
        sourceRefs: code.sourceRefs.map(ref => ({ ...ref })),
      }] : []),
    ],
    relations: [],
  };
}

test("accepted summaries polish overview narration; step count and reveals stay the C4 tour", () => {
  const shared = {
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  };
  const off = buildScanArtifacts(shared);
  const accepted = buildScanArtifacts({
    ...shared,
    enrichmentDocs: new Map([["container:pkg-a", containerSummaryDoc(off.baseExtraction, "container:pkg-a", true)]]),
  });

  assert.equal(accepted.enrichmentReport?.enrichedContainers.includes("container:pkg-a"), true);
  assert.deepEqual(tourSpine(accepted.story), tourSpine(off.story));
  assert.equal(accepted.story.steps.length, off.story.steps.length);
  assert.notEqual(stableJson(accepted.story), stableJson(off.story));

  const byId = (story: ArchitectureStory, id: string) => story.steps.find(step => step.id === id);
  assert.equal(byId(accepted.story, "step:context")?.narration, byId(off.story, "step:context")?.narration);
  assert.match(byId(accepted.story, "step:container")?.narration ?? "", /Scanner-scoped container summary\./);
  assert.match(byId(accepted.story, "step:component")?.narration ?? "", /Summary of /);
  assert.match(byId(accepted.story, "step:code")?.narration ?? "", /Optional in-scope code summary\./);
  assert.equal(byId(accepted.story, "step:container")?.reveal, "container");
  assert.equal(byId(accepted.story, "step:component")?.reveal, "component");
  assert.equal(byId(accepted.story, "step:code")?.reveal, "code");
});

test("gate-rejected enrichment keeps the deterministic overview copy", () => {
  const shared = {
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  };
  const off = buildScanArtifacts(shared);
  const rejected = buildScanArtifacts({
    ...shared,
    enrichmentDocs: new Map([["container:pkg-a", {
      schemaVersion: 1,
      entities: [{ id: "system:other", kind: "softwareSystem", name: "Nope", sourceRefs: [] }],
      relations: [],
    }]]),
  });
  assert.equal(rejected.enrichmentReport?.results[0]?.accepted, false);
  assert.equal(stableJson(rejected.story), stableJson(off.story));
});

test("an oversized accepted summary falls back to deterministic narration", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const featuredId = artifacts.story.steps.find(step => step.id === "step:container")?.focusEntityIds[0];
  assert.ok(featuredId);
  const oversized = {
    ...artifacts.snapshot,
    entities: artifacts.snapshot.entities.map(entity =>
      entity.id === featuredId
        ? { ...entity, responsibility: "X".repeat(STORY_AUTHORING_LIMITS.maxNarrationCharacters) }
        : entity),
  };
  const story = buildOverviewStory(oversized, artifacts.view, "system:acme", "acme", "Acme");
  assert.deepEqual(tourSpine(story), tourSpine(artifacts.story));
  assert.equal(
    story.steps.find(step => step.id === "step:container")?.narration,
    artifacts.story.steps.find(step => step.id === "step:container")?.narration,
  );
});

test("a system-scope summary polishes the context step without adding steps", () => {
  const shared = {
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  };
  const off = buildScanArtifacts(shared);
  const containers = off.baseExtraction.entities.filter(entity => entity.kind === "container");
  const system = off.baseExtraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const accepted = buildScanArtifacts({
    ...shared,
    enrichmentDocs: new Map([[system.id, {
      schemaVersion: 1,
      entities: [
        {
          id: system.id, kind: "softwareSystem", name: system.name,
          responsibility: "Fixture summary of the demo system.", sourceRefs: [],
        },
        ...containers.map(container => ({
          id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [],
        })),
      ],
      relations: [],
    }]]),
  });
  assert.equal(accepted.enrichmentReport?.systemScope?.accepted, true);
  assert.deepEqual(tourSpine(accepted.story), tourSpine(off.story));
  assert.match(accepted.story.steps[0]!.narration, /Fixture summary of the demo system\./);
  assert.equal(accepted.story.steps[0]!.reveal, "context");
});
