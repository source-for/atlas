import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adaptArchitectureExtraction,
  validateArchitectureExtraction,
  validateSnapshot,
  type ArchitectureExtraction,
  type ArchitectureExtractionEntity,
  type ArchitectureExtractionSnapshotMetadata,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { buildScanArtifacts, scanRepository, stableJson } from "./scan.js";

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  "pkg/c/src/config.ts": "export default 1;\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};
function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
      { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c", packageManifest: "pkg/c/package.json" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}
function base(): ArchitectureExtraction {
  return extractArchitecture({ discovery: discovery(), readFile: read, systemName: "Acme", systemSlug: "acme" });
}
const metadata: ArchitectureExtractionSnapshotMetadata = {
  snapshotId: "snapshot:acme:abc123def456",
  repositoryId: "repo:acme",
  commitSha: "abc123def456",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

function containerCode(extraction: ArchitectureExtraction, containerId: string): ArchitectureExtractionEntity[] {
  const byId = new Map(extraction.entities.map(entity => [entity.id, entity]));
  return extraction.entities.filter(entity => {
    if (entity.kind !== "code" || entity.parentId === undefined) return false;
    return byId.get(entity.parentId)?.parentId === containerId;
  });
}

type Doc = Record<string, unknown>;

function fileComponents(extraction: ArchitectureExtraction, containerId: string): ArchitectureExtractionEntity[] {
  return extraction.entities.filter(entity => entity.kind === "component" && entity.parentId === containerId);
}

/** A compliant section-summary document: restates scanner-scoped ids, no regrouping. */
function summaryDoc(extraction: ArchitectureExtraction, containerId: string, withCode = false): Doc {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const components = fileComponents(extraction, containerId);
  const code = withCode
    ? containerCode(extraction, containerId).find(entity => entity.id.endsWith(":alpha"))
      ?? containerCode(extraction, containerId)[0]
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

/** A compliant single-logical-component proposal for a container. */
function validDoc(extraction: ArchitectureExtraction, containerId: string): Doc {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const local = containerId.slice("container:".length);
  const logicalId = `component:${local}-core`;
  const code = containerCode(extraction, containerId);
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [] },
      { id: logicalId, kind: "component", parentId: containerId, name: "Core", responsibility: "Groups the module.", sourceRefs: [] },
      ...code.map(entity => ({ id: entity.id, kind: "code", parentId: logicalId, name: entity.name, sourceRefs: entity.sourceRefs.map(ref => ({ ...ref })) })),
    ],
    relations: [],
  };
}

/** A compliant proposal that puts each file in its own component (whole-file cohesion). */
function validDocPerFile(extraction: ArchitectureExtraction, containerId: string): Doc {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const local = containerId.slice("container:".length);
  const code = containerCode(extraction, containerId);
  const paths = [...new Set(code.map(entity => entity.sourceRefs[0]!.path))].sort();
  const componentByPath = new Map(paths.map((path, index) => [path, `component:${local}-group${index}`]));
  const components = paths.map(path => ({
    id: componentByPath.get(path)!, kind: "component", parentId: containerId,
    name: `Group ${path}`, responsibility: "One file.", sourceRefs: [],
  }));
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [] },
      ...components,
      ...code.map(entity => ({
        id: entity.id, kind: "code", parentId: componentByPath.get(entity.sourceRefs[0]!.path)!,
        name: entity.name, sourceRefs: entity.sourceRefs.map(ref => ({ ...ref })),
      })),
    ],
    relations: [],
  };
}

test("accepts a valid proposal: re-parents code, validates, keeps observed facts byte-identical", () => {
  const extraction = base();
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-a", validDoc(extraction, "container:pkg-a")]]));

  assert.equal(report.results.find(result => result.containerId === "container:pkg-a")?.accepted, true);
  assert.deepEqual(validateArchitectureExtraction(merged), []);
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);

  assert.ok(merged.entities.some(entity => entity.id === "component:pkg-a-core"));
  assert.ok(!merged.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"), "file-component replaced");

  const alpha = merged.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const baseAlpha = extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  assert.equal(alpha.parentId, "component:pkg-a-core", "re-parented");
  assert.deepEqual(alpha.sourceRefs, baseAlpha.sourceRefs, "observed refs unchanged");
  assert.equal(alpha.name, baseAlpha.name, "observed name unchanged");

  // index.ts -> util.ts (both grouped into core) collapses to a self-loop and is dropped.
  assert.ok(!merged.relations.some(relation => relation.from === relation.to));
  // container->container survives untouched.
  assert.ok(merged.relations.some(relation => relation.from === "container:pkg-b" && relation.to === "container:pkg-a"));
});

test("remaps intra-container file->file edges to logical->logical", () => {
  const extraction = base();
  const { extraction: merged } = mergeEnrichment(extraction, new Map([["container:pkg-a", validDocPerFile(extraction, "container:pkg-a")]]));
  // index.ts=group0, util.ts=group1; the index->util import becomes group0->group1.
  assert.ok(
    merged.relations.some(relation => relation.from === "component:pkg-a-group0" && relation.to === "component:pkg-a-group1"),
    `expected remapped logical edge, got ${JSON.stringify(merged.relations.map(r => [r.from, r.to]))}`,
  );
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);
});

function expectReject(mutate: (doc: Doc, extraction: ArchitectureExtraction) => void, containerId = "container:pkg-a"): string[] {
  const extraction = base();
  const doc = validDoc(extraction, containerId);
  mutate(doc, extraction);
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([[containerId, doc]]));
  const result = report.results.find(entry => entry.containerId === containerId)!;
  assert.equal(result.accepted, false, `expected rejection; reasons=${result.reasons.join("; ")}`);
  assert.ok(result.reasons.length > 0);
  // atomic: the scope falls back to its deterministic file-component base, still valid.
  assert.ok(merged.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"), "scope kept file-components");
  assert.ok(!merged.entities.some(entity => entity.id === "component:pkg-a-core"), "no partial merge");
  assert.deepEqual(validateArchitectureExtraction(merged), [], "deterministic base still publishes");
  return result.reasons;
}

test("rejects (atomic, scope stays on base): out-of-scope, mutated ref, coverage, cohesion, relations, malformed", () => {
  expectReject(doc => { (doc.entities as ArchitectureExtractionEntity[])[2]!.sourceRefs = [{ path: "pkg/b/src/main.ts" }]; }); // component cites out-of-scope
  expectReject(doc => {
    const code = (doc.entities as ArchitectureExtractionEntity[]).find(e => e.kind === "code")!;
    const start = (code.sourceRefs[0]!.startLine ?? 1) + 100;
    code.sourceRefs = [{ ...code.sourceRefs[0]!, startLine: start, endLine: start }]; // gate-valid but mutates the observed range
  });
  expectReject(doc => { (doc.entities as ArchitectureExtractionEntity[]).splice(3, 1); }); // drop a code entity -> incomplete coverage
  expectReject(doc => {
    // gate-valid relation (endpoints/evidence in-doc + in-scope) so the "no relations" rule is what fires
    doc.relations = [{ id: "relation:pkg-a-dep", from: "container:pkg-a", to: "component:pkg-a-core", kind: "dependsOn", evidence: [{ source: { path: "pkg/a/src/index.ts" } }] }];
  });
  // file-cohesion: split index.ts's two symbols across two components.
  expectReject((doc, extraction) => {
    const local = "pkg-a";
    const second = { id: `component:${local}-split`, kind: "component", parentId: "container:pkg-a", name: "Split", sourceRefs: [] };
    (doc.entities as ArchitectureExtractionEntity[]).splice(3, 0, second as ArchitectureExtractionEntity);
    const a = (doc.entities as ArchitectureExtractionEntity[]).find(e => e.id === "code:pkg-a-src-index-ts:a");
    if (a) a.parentId = `component:${local}-split`;
    void extraction;
  });
  // malformed JSON handled at the map layer (a non-object doc).
  const extraction = base();
  const { report } = mergeEnrichment(extraction, new Map([["container:pkg-a", "not-an-object"]]));
  assert.equal(report.results[0]!.accepted, false);
});

test("merge is independent of document order", () => {
  const extraction = base();
  const docA = validDoc(extraction, "container:pkg-a");
  const docB = validDoc(extraction, "container:pkg-b");
  const forward = mergeEnrichment(extraction, new Map([["container:pkg-a", docA], ["container:pkg-b", docB]])).extraction;
  const reverse = mergeEnrichment(extraction, new Map([["container:pkg-b", docB], ["container:pkg-a", docA]])).extraction;
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
});

test("replay is byte-identical for the same base + docs", () => {
  const first = mergeEnrichment(base(), new Map([["container:pkg-a", validDoc(base(), "container:pkg-a")]])).extraction;
  const second = mergeEnrichment(base(), new Map([["container:pkg-a", validDoc(base(), "container:pkg-a")]])).extraction;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("collapsing edges unions their evidence; dropped self-loops are counted in the report", () => {
  // a.ts and b.ts each import c.ts — two file->file edges into c.
  const localFiles: Record<string, string> = {
    "README.md": "# M",
    "m/src/a.ts": "export function a() {}\nimport './c.js';\n",
    "m/src/b.ts": "export function b() {}\nimport './c.js';\n",
    "m/src/c.ts": "export function c() {}\n",
  };
  const localRead = (path: string): string => {
    const text = localFiles[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const localDiscovery: Discovery = {
    sourceFiles: ["m/src/a.ts", "m/src/b.ts", "m/src/c.ts"],
    units: [{ kind: "member", dir: "m", name: "@m/m", packageName: "@m/m", evidencePath: "m", packageManifest: "m/package.json" }],
    unitByFile: new Map([["m/src/a.ts", "m"], ["m/src/b.ts", "m"], ["m/src/c.ts", "m"]]),
    unitByPackageName: new Map([["@m/m", "m"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const ext = extractArchitecture({ discovery: localDiscovery, readFile: localRead, systemName: "M", systemSlug: "m" });
  const system = ext.entities.find(entity => entity.kind === "softwareSystem")!;
  const importers = "component:m-importers";
  const core = "component:m-core";

  // group {a,b} -> importers, {c} -> core: both a->c and b->c collapse to ONE importers->core edge.
  const splitDoc: Doc = {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: "container:m", kind: "container", parentId: system.id, name: "M", sourceRefs: [] },
      { id: importers, kind: "component", parentId: "container:m", name: "Importers", responsibility: "x", sourceRefs: [] },
      { id: core, kind: "component", parentId: "container:m", name: "Core", responsibility: "x", sourceRefs: [] },
      ...containerCode(ext, "container:m").map(entity => ({
        id: entity.id, kind: "code", name: entity.name,
        parentId: entity.sourceRefs[0]!.path === "m/src/c.ts" ? core : importers,
        sourceRefs: entity.sourceRefs.map(ref => ({ ...ref })),
      })),
    ],
    relations: [],
  };
  const { extraction: merged } = mergeEnrichment(ext, new Map([["container:m", splitDoc]]));
  const edge = merged.relations.find(relation => relation.from === importers && relation.to === core)!;
  assert.ok(edge, "collapsed logical edge exists");
  assert.equal(edge.evidence.length, 2, "evidence unioned from both a->c and b->c imports");
  assert.deepEqual(edge.evidence.map(item => item.source.path).sort(), ["m/src/a.ts", "m/src/b.ts"]);

  // grouping ALL three files into one component turns both edges into self-loops (dropped, but counted).
  const onePer = mergeEnrichment(ext, new Map([["container:m", validDoc(ext, "container:m")]]));
  assert.equal(onePer.report.collapsedSelfEdges, 2);
  assert.equal(onePer.report.results.find(result => result.containerId === "container:m")?.collapsedSelfEdges, 2);
});

test("end-to-end: enriching a real Okie container yields a valid, compiling snapshot", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const baseArtifacts = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const containerId = "container:tooling";
  const doc = validDoc(baseArtifacts.baseExtraction, containerId);

  const enriched = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie", enrichmentDocs: new Map([[containerId, doc]]) });
  assert.equal(enriched.enrichmentReport?.enrichedContainers.includes(containerId), true);
  assert.deepEqual(validateSnapshot(enriched.snapshot), []);
  assert.ok(enriched.snapshot.entities.some(entity => entity.id === "component:tooling-core"));
  assert.ok(enriched.scene.objects.length > 0, "scene compiled");
});

test("carries code-entity judgement fields (responsibility) through the merge; observed facts still win", () => {
  const extraction = base();
  const doc = validDoc(extraction, "container:pkg-a") as { entities: Array<Record<string, unknown>> };
  const alpha = doc.entities.find(entity => typeof entity.id === "string" && (entity.id as string).endsWith(":alpha"))!;
  alpha.responsibility = "Standalone entry point consumed by downstream repos (island: nothing in-repo calls it).";
  alpha.tags = ["island"];

  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-a", doc]]));
  assert.equal(report.results.find(result => result.containerId === "container:pkg-a")?.accepted, true);
  assert.deepEqual(validateArchitectureExtraction(merged), []);

  const mergedAlpha = merged.entities.find(entity => entity.id === (alpha.id as string))!;
  assert.equal(mergedAlpha.responsibility, "Standalone entry point consumed by downstream repos (island: nothing in-repo calls it).");
  assert.deepEqual(mergedAlpha.tags, ["island"]);
  // Observed facts are the base's, byte-identical — judgement is purely additive.
  const baseAlpha = extraction.entities.find(entity => entity.id === (alpha.id as string))!;
  assert.equal(mergedAlpha.name, baseAlpha.name);
  assert.deepEqual(mergedAlpha.sourceRefs, baseAlpha.sourceRefs);
  // A code entity WITHOUT judgement stays untouched apart from its new parent.
  const other = merged.entities.find(entity => entity.kind === "code" && entity.id !== (alpha.id as string) && entity.parentId === "component:pkg-a-core");
  assert.ok(other && other.responsibility === undefined);
});

test("accepts scanner-scoped section summaries without regrouping files", () => {
  const extraction = base();
  const containerId = "container:pkg-a";
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([[containerId, summaryDoc(extraction, containerId, true)]]));

  assert.equal(report.results.find(result => result.containerId === containerId)?.accepted, true, report.results[0]?.reasons.join("; "));
  assert.deepEqual(validateArchitectureExtraction(merged), []);
  assert.ok(merged.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"), "file-components remain");
  assert.ok(!merged.entities.some(entity => entity.id === "component:pkg-a-core"), "must not regroup");
  assert.equal(merged.entities.find(entity => entity.id === containerId)?.responsibility, "Scanner-scoped container summary.");
  assert.match(
    merged.entities.find(entity => entity.id === "component:pkg-a-src-index-ts")?.responsibility ?? "",
    /^Summary of /,
  );
  const alpha = merged.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const summarizedCode = merged.entities.find(entity => entity.kind === "code" && entity.responsibility === "Optional in-scope code summary.");
  assert.ok(summarizedCode, "optional in-scope code summary should land");
  assert.equal(summarizedCode.parentId, extraction.entities.find(entity => entity.id === summarizedCode.id)!.parentId);
  assert.equal(alpha.parentId, extraction.entities.find(entity => entity.id === alpha.id)!.parentId);
  assert.deepEqual(merged.relations, extraction.relations, "summaries must not rewrite deterministic relations");
});

test("observed language tags survive enrichment that replaces or omits technology (CLA-102)", () => {
  const extraction = base();
  const containerId = "container:pkg-a";
  assert.deepEqual(extraction.entities.find(entity => entity.id === containerId)?.technology, ["TypeScript"]);

  const summary = summaryDoc(extraction, containerId) as { entities: ArchitectureExtractionEntity[] };
  const container = summary.entities.find(entity => entity.id === containerId)!;
  container.technology = ["React"];
  const summarized = mergeEnrichment(extraction, new Map([[containerId, summary]]));
  assert.equal(summarized.report.results[0]!.accepted, true, summarized.report.results[0]?.reasons.join("; "));
  assert.deepEqual(
    summarized.extraction.entities.find(entity => entity.id === containerId)?.technology,
    ["TypeScript", "React"],
    "observed TypeScript stays ahead of enrichment libraries",
  );
  assert.deepEqual(
    summarized.extraction.entities.find(entity => entity.id === "component:pkg-a-src-index-ts")?.technology,
    ["TypeScript"],
  );

  const regrouped = mergeEnrichment(extraction, new Map([[containerId, validDoc(extraction, containerId)]]));
  assert.equal(regrouped.report.results[0]!.accepted, true, regrouped.report.results[0]?.reasons.join("; "));
  assert.deepEqual(regrouped.extraction.entities.find(entity => entity.id === containerId)?.technology, ["TypeScript"]);
  assert.deepEqual(
    regrouped.extraction.entities.find(entity => entity.id === "component:pkg-a-core")?.technology,
    ["TypeScript"],
    "logical components inherit language from grouped file paths",
  );
});

test("section summaries reject hallucinated ids and out-of-scope citations; the base is unchanged", () => {
  const extraction = base();
  const ghost = summaryDoc(extraction, "container:pkg-a", true) as { entities: ArchitectureExtractionEntity[] };
  ghost.entities.push({
    id: "code:ghost:nope",
    kind: "code",
    parentId: "component:pkg-a-src-index-ts",
    name: "nope",
    sourceRefs: [{ path: "pkg/a/src/index.ts" }],
  });
  const hallucinated = mergeEnrichment(extraction, new Map([["container:pkg-a", ghost]]));
  assert.equal(hallucinated.report.results[0]!.accepted, false);
  assert.ok(hallucinated.report.results[0]!.reasons.some(reason => /outside this scope|ghost/i.test(reason)));
  assert.equal(JSON.stringify(hallucinated.extraction), JSON.stringify(extraction));
  assert.ok(hallucinated.extraction.entities.some(entity => entity.id === "component:pkg-a-src-index-ts"));
  assert.ok(!hallucinated.extraction.entities.some(entity => entity.id === "code:ghost:nope"));

  const oos = summaryDoc(extraction, "container:pkg-a") as { entities: ArchitectureExtractionEntity[] };
  const component = oos.entities.find(entity => entity.kind === "component")!;
  component.sourceRefs = [{ path: "pkg/b/src/main.ts" }];
  const outOfScope = mergeEnrichment(extraction, new Map([["container:pkg-a", oos]]));
  assert.equal(outOfScope.report.results[0]!.accepted, false);
  assert.ok(outOfScope.report.results[0]!.reasons.some(reason => reason.includes("out-of-scope")));
  assert.equal(JSON.stringify(outOfScope.extraction), JSON.stringify(extraction));
});

test("remainder-packet summary docs union onto the same container; leftover file-components are not dropped", () => {
  const extraction = base();
  const containerId = "container:pkg-a";
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === containerId)!;
  const components = fileComponents(extraction, containerId);
  assert.ok(components.length >= 2, "fixture has multiple file-components");
  const first = {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, responsibility: "First packet.", sourceRefs: [] },
      {
        id: components[0]!.id, kind: "component", parentId: containerId, name: components[0]!.name,
        responsibility: "Summary of first file.", sourceRefs: [],
      },
    ],
    relations: [],
  };
  const remainder = {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: container.id, kind: "container", parentId: system.id, name: container.name, sourceRefs: [] },
      {
        id: components[1]!.id, kind: "component", parentId: containerId, name: components[1]!.name,
        responsibility: "Summary of remainder file.", sourceRefs: [],
      },
    ],
    relations: [],
  };
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([[containerId, [first, remainder]]]));
  assert.equal(report.results.find(result => result.containerId === containerId)?.accepted, true, report.results[0]?.reasons.join("; "));
  assert.equal(report.results.find(result => result.containerId === containerId)?.components, 2);
  assert.equal(merged.entities.find(entity => entity.id === components[0]!.id)?.responsibility, "Summary of first file.");
  assert.equal(merged.entities.find(entity => entity.id === components[1]!.id)?.responsibility, "Summary of remainder file.");
  assert.equal(merged.entities.find(entity => entity.id === containerId)?.responsibility, "First packet.");
});

test("observed-field equality uses delimited sourceRef keys, not concatenation", () => {
  const extraction = base();
  const containerId = "container:pkg-a";
  const doc = summaryDoc(extraction, containerId, true) as { entities: ArchitectureExtractionEntity[] };
  const code = doc.entities.find(entity => entity.kind === "code")!;
  const original = code.sourceRefs[0]!;
  // Concatenation collision: symbol+startLine+endLine ("alpha"+"1"+"1") vs symbol "alpha11".
  // Path stays in-scope so the gate reaches observed-field comparison.
  code.sourceRefs = [{
    path: original.path,
    symbol: `${original.symbol ?? ""}${original.startLine ?? ""}${original.endLine ?? ""}`,
  }];
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[containerId, doc]]));
  assert.equal(report.results[0]!.accepted, false, "concatenated path+symbol must not match the delimited key");
  assert.ok(report.results[0]!.reasons.some(reason => /mutates an observed field/.test(reason)));
  assert.equal(JSON.stringify(merged), JSON.stringify(extraction));
});

test("a hallucinated remainder packet rejects only that document; the accepted packet still merges", () => {
  const extraction = base();
  const containerId = "container:pkg-a";
  const good = summaryDoc(extraction, containerId);
  const ghost = summaryDoc(extraction, containerId) as { entities: ArchitectureExtractionEntity[] };
  ghost.entities.push({
    id: "code:ghost:nope",
    kind: "code",
    parentId: "component:pkg-a-src-index-ts",
    name: "nope",
    sourceRefs: [{ path: "pkg/a/src/index.ts" }],
  });
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([[containerId, [good, ghost]]]));
  assert.equal(report.results.find(result => result.containerId === containerId)?.accepted, true);
  assert.equal(merged.entities.find(entity => entity.id === containerId)?.responsibility, "Scanner-scoped container summary.");
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
  const fileSummaries = merged.entities.filter(entity => entity.kind === "component" && entity.parentId === containerId && entity.responsibility);
  assert.ok(fileSummaries.length >= 1);
});

test("rejected or off enrichment leaves the deterministic overview story unchanged", () => {
  const pin = {
    commitSha: "abc123def456abc123def456abc123def456abc1",
    treeHash: "def456abc123def456abc123def456abc123def4",
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  const off = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const rejected = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
    enrichmentDocs: new Map([["container:pkg-a", {
      schemaVersion: 1,
      entities: [{ id: "system:other", kind: "softwareSystem", name: "Nope", sourceRefs: [] }],
      relations: [],
    }]]),
  });
  assert.equal(stableJson(rejected.story), stableJson(off.story));
  assert.equal(rejected.enrichmentReport?.results[0]?.accepted, false);
});

test("accepted summaries polish overview narration; the C4 tour spine is unchanged", () => {
  const pin = {
    commitSha: "abc123def456abc123def456abc123def456abc1",
    treeHash: "def456abc123def456abc123def456abc123def4",
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  const off = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const accepted = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
    enrichmentDocs: new Map([["container:pkg-a", summaryDoc(off.baseExtraction, "container:pkg-a")]]),
  });
  assert.equal(accepted.enrichmentReport?.enrichedContainers.includes("container:pkg-a"), true);
  assert.equal(
    accepted.snapshot.entities.find(entity => entity.id === "container:pkg-a")?.responsibility,
    "Scanner-scoped container summary.",
  );
  const spine = (story: typeof off.story) => story.steps.map(step => ({
    id: step.id, title: step.title, reveal: step.reveal, focusEntityIds: [...step.focusEntityIds],
  }));
  assert.deepEqual(spine(accepted.story), spine(off.story));
  assert.ok(accepted.story.steps.some(step => step.narration.includes("Scanner-scoped container summary.")));
  assert.notEqual(stableJson(accepted.story), stableJson(off.story));
});
