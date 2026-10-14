import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptArchitectureExtraction,
  buildC4ProjectionBundle,
  validateArchitectureExtraction,
  validateSnapshot,
  type ArchitectureExtraction,
  type ArchitectureExtractionEntity,
  type ArchitectureExtractionSnapshotMetadata,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { buildSystemPacket } from "./packet.js";

const files: Record<string, string> = {
  "README.md": "# Acme\n\nAcme is a demo system that people and agents interact with.\n",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};
function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile: new Map([["pkg/a/src/index.ts", "pkg/a"], ["pkg/b/src/main.ts", "pkg/b"]]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}
const base = (): ArchitectureExtraction => extractArchitecture({ discovery: discovery(), readFile: read, systemName: "Acme", systemSlug: "acme" });
const SYSTEM_ID = "system:acme";
const metadata: ArchitectureExtractionSnapshotMetadata = {
  snapshotId: "snapshot:acme:abc123def456",
  repositoryId: "repo:acme",
  commitSha: "abc123def456",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

type Doc = Record<string, unknown>;

/** A compliant system-scope proposal: two top-level actors + their relations. */
function validSystemDoc(): Doc {
  return {
    schemaVersion: 1,
    entities: [
      { id: SYSTEM_ID, kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "container:pkg-a", kind: "container", parentId: SYSTEM_ID, name: "A", sourceRefs: [] },
      { id: "person:user", kind: "person", name: "User", responsibility: "Explores the system.", sourceRefs: [{ path: "README.md", startLine: 1, endLine: 3 }] },
      { id: "person:ai-agent", kind: "person", name: "AI Agent (MCP)", sourceRefs: [{ path: "README.md" }] },
    ],
    relations: [
      { id: "relation:user-uses-a", from: "person:user", to: "container:pkg-a", kind: "uses", evidence: [{ source: { path: "README.md" } }] },
      { id: "relation:agent-uses-system", from: "person:ai-agent", to: SYSTEM_ID, kind: "uses", evidence: [{ source: { path: "README.md" } }] },
    ],
  };
}

// ---------------------------------------------------------------------------
// Packet emission.
// ---------------------------------------------------------------------------

test("buildSystemPacket exposes the top-level shape and a bounded citation scope", () => {
  const packet = buildSystemPacket(base(), read)!;
  assert.equal(packet.scope, "system");
  assert.equal(packet.systemId, SYSTEM_ID);
  assert.equal(packet.systemName, "Acme");
  assert.deepEqual(packet.containers.map(c => c.id).sort(), ["container:pkg-a", "container:pkg-b"]);
  // scopePaths = system + container evidence anchors (README.md + the container dirs).
  assert.deepEqual(packet.scopePaths, ["README.md", "pkg/a", "pkg/b"]);
  // README teaser is included (context only), never full file bytes.
  assert.ok(packet.readme.some(excerpt => excerpt.path === "README.md" && excerpt.lines.length > 0));
});

test("buildSystemPacket returns undefined without a system root", () => {
  const noSystem: ArchitectureExtraction = { schemaVersion: 1, entities: [], relations: [] };
  assert.equal(buildSystemPacket(noSystem, read), undefined);
});

// ---------------------------------------------------------------------------
// Accept path.
// ---------------------------------------------------------------------------

test("accepts a system-scope proposal: adds persons + person relations, stays gate-clean", () => {
  const { extraction: merged, report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, validSystemDoc()]]));
  assert.equal(report.systemScope?.accepted, true, report.systemScope?.reasons.join("; "));
  assert.equal(report.systemScope?.persons, 2);
  assert.equal(report.systemScope?.relations, 2);

  assert.deepEqual(validateArchitectureExtraction(merged), []);
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);

  const persons = merged.entities.filter(entity => entity.kind === "person");
  assert.deepEqual(persons.map(p => p.id).sort(), ["person:ai-agent", "person:user"]);
  for (const person of persons) assert.equal(person.parentId, undefined, "persons are top-level context");

  // person -> container / system relations survive (ids regenerated deterministically).
  assert.ok(merged.relations.some(r => r.from === "person:user" && r.to === "container:pkg-a"));
  assert.ok(merged.relations.some(r => r.from === "person:ai-agent" && r.to === SYSTEM_ID));
});

test("accepted actors render as L1 context nodes with edges into the system/containers", () => {
  const { extraction: merged } = mergeEnrichment(base(), new Map([[SYSTEM_ID, validSystemDoc()]]));
  const snapshot = adaptArchitectureExtraction(merged, metadata);
  const bundle = buildC4ProjectionBundle(snapshot, { rootEntityId: SYSTEM_ID, focusEntityId: SYSTEM_ID, familyId: "view-family:acme:ctx" });
  const context = Object.values(bundle.projectionById).find(projection => projection.band === "context")!;
  const personNodes = context.visualNodeIds.map(id => bundle.visualNodeById[id]!).filter(node => node.kind === "person");
  assert.equal(personNodes.length, 2, "both actors appear in the L1 context band");
});

test("a system-scope doc and a container-scope doc merge together", () => {
  const extraction = base();
  const containerDoc: Doc = {
    schemaVersion: 1,
    entities: [
      { id: SYSTEM_ID, kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "container:pkg-a", kind: "container", parentId: SYSTEM_ID, name: "A", sourceRefs: [] },
      { id: "component:pkg-a-core", kind: "component", parentId: "container:pkg-a", name: "Core", responsibility: "Groups the module.", sourceRefs: [] },
      ...extraction.entities.filter(e => e.kind === "code" && e.parentId === "component:pkg-a-src-index-ts")
        .map(e => ({ id: e.id, kind: "code", parentId: "component:pkg-a-core", name: e.name, sourceRefs: e.sourceRefs.map(r => ({ ...r })) })),
    ],
    relations: [],
  };
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([
    [SYSTEM_ID, validSystemDoc()],
    ["container:pkg-a", containerDoc],
  ]));
  assert.equal(report.systemScope?.accepted, true);
  assert.equal(report.enrichedContainers.includes("container:pkg-a"), true);
  assert.ok(merged.entities.some(e => e.id === "component:pkg-a-core"), "container logical component present");
  assert.ok(merged.entities.some(e => e.id === "person:user"), "actor present");
  assert.deepEqual(validateSnapshot(adaptArchitectureExtraction(merged, metadata)), []);
});

// ---------------------------------------------------------------------------
// Reject path (atomic: the deterministic base is untouched — no persons leak in).
// ---------------------------------------------------------------------------

function expectRejectSystem(mutate: (doc: Doc) => void): string[] {
  const doc = validSystemDoc();
  mutate(doc);
  const { extraction: merged, report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, doc]]));
  assert.equal(report.systemScope?.accepted, false, "expected system-scope rejection");
  assert.ok((report.systemScope?.reasons.length ?? 0) > 0);
  // atomic: nothing added; base still valid.
  assert.equal(merged.entities.some(entity => entity.kind === "person"), false, "no persons leaked from a rejected doc");
  assert.deepEqual(validateArchitectureExtraction(merged), []);
  return report.systemScope!.reasons;
}

test("rejects (atomic) attempts to touch structure: component/code, unknown container, structural relation, out-of-scope", () => {
  // may NOT add a component
  expectRejectSystem(doc => {
    (doc.entities as ArchitectureExtractionEntity[]).push({ id: "component:pkg-a-x", kind: "component", parentId: "container:pkg-a", name: "X", sourceRefs: [] });
  });
  // may NOT add a code entity
  expectRejectSystem(doc => {
    (doc.entities as ArchitectureExtractionEntity[]).push({ id: "code:pkg-a-x:y", kind: "code", parentId: "container:pkg-a", name: "y", sourceRefs: [{ path: "pkg/a/src/index.ts", symbol: "y", startLine: 1, endLine: 1 }] });
  });
  // may NOT introduce an unknown container
  expectRejectSystem(doc => {
    (doc.entities as ArchitectureExtractionEntity[]).push({ id: "container:ghost", kind: "container", parentId: SYSTEM_ID, name: "Ghost", sourceRefs: [] });
  });
  // may NOT author a relation that does not touch a proposed person (structural edge)
  expectRejectSystem(doc => {
    (doc.entities as ArchitectureExtractionEntity[]).push({ id: "container:pkg-b", kind: "container", parentId: SYSTEM_ID, name: "B", sourceRefs: [] });
    (doc.relations as Array<Record<string, unknown>>).push({ id: "relation:a-b", from: "container:pkg-a", to: "container:pkg-b", kind: "dependsOn", evidence: [{ source: { path: "README.md" } }] });
  });
  // person may not cite a path outside the system scope (READMEs + container anchors)
  expectRejectSystem(doc => {
    (doc.entities as ArchitectureExtractionEntity[]).find(e => e.id === "person:user")!.sourceRefs = [{ path: "pkg/a/src/index.ts", startLine: 1, endLine: 1 }];
  });
  // relation evidence may not cite out-of-scope paths either
  expectRejectSystem(doc => {
    (doc.relations as Array<Record<string, unknown>>)[0]!.evidence = [{ source: { path: "pkg/a/src/index.ts" } }];
  });
  // must actually propose an actor
  expectRejectSystem(doc => {
    doc.entities = (doc.entities as ArchitectureExtractionEntity[]).filter(e => e.kind !== "person");
    doc.relations = [];
  });
});

test("a malformed / non-system-restating doc is rejected", () => {
  const wrongSystem = validSystemDoc();
  (wrongSystem.entities as ArchitectureExtractionEntity[]).find(e => e.kind === "softwareSystem")!.id = "system:other";
  const { report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, wrongSystem]]));
  assert.equal(report.systemScope?.accepted, false);
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test("system-scope merge replays byte-identically", () => {
  const first = mergeEnrichment(base(), new Map([[SYSTEM_ID, validSystemDoc()]])).extraction;
  const second = mergeEnrichment(base(), new Map([[SYSTEM_ID, validSystemDoc()]])).extraction;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("carries judgement prose on restated container anchors (how opaque crates get described)", () => {
  const doc = validSystemDoc() as { entities: Array<Record<string, unknown>> };
  doc.entities.push({
    id: "container:pkg-b",
    kind: "container",
    parentId: SYSTEM_ID,
    name: "container:pkg-b",
    responsibility: "Downstream consumer package exercising the public API.",
    sourceRefs: [],
  });

  const { extraction: merged, report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, doc]]));
  assert.equal(report.systemScope?.accepted, true, `reasons=${report.systemScope?.reasons.join("; ")}`);
  assert.deepEqual(validateArchitectureExtraction(merged), []);

  const container = merged.entities.find(entity => entity.id === "container:pkg-b")!;
  assert.equal(container.responsibility, "Downstream consumer package exercising the public API.");
  // Structure stays base-owned: the doc's name field never wins over the observed one.
  const baseContainer = base().entities.find(entity => entity.id === "container:pkg-b")!;
  assert.equal(container.name, baseContainer.name);
  assert.deepEqual(container.sourceRefs, baseContainer.sourceRefs);
});

function summarySystemDoc(): Doc {
  return {
    schemaVersion: 1,
    entities: [
      {
        id: SYSTEM_ID, kind: "softwareSystem", name: "Acme",
        responsibility: "Demo system people interact with.", sourceRefs: [],
      },
      {
        id: "container:pkg-a", kind: "container", parentId: SYSTEM_ID, name: "A",
        responsibility: "Public library package.", sourceRefs: [],
      },
      {
        id: "container:pkg-b", kind: "container", parentId: SYSTEM_ID, name: "B",
        responsibility: "Downstream consumer package.", sourceRefs: [],
      },
    ],
    relations: [],
  };
}

test("accepts system-scope section summaries without requiring persons", () => {
  const { extraction: merged, report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, summarySystemDoc()]]));
  assert.equal(report.systemScope?.accepted, true, report.systemScope?.reasons.join("; "));
  assert.equal(report.systemScope?.persons, 0);
  assert.equal(merged.entities.find(entity => entity.id === SYSTEM_ID)?.responsibility, "Demo system people interact with.");
  assert.equal(merged.entities.find(entity => entity.id === "container:pkg-a")?.responsibility, "Public library package.");
  assert.equal(merged.entities.some(entity => entity.kind === "person"), false);
  assert.deepEqual(merged.relations, base().relations);
  assert.deepEqual(validateArchitectureExtraction(merged), []);
});

test("system-scope summaries reject hallucinated containers; the base is unchanged", () => {
  const doc = summarySystemDoc() as { entities: ArchitectureExtractionEntity[] };
  doc.entities.push({
    id: "container:ghost",
    kind: "container",
    parentId: SYSTEM_ID,
    name: "Ghost",
    responsibility: "Not in the scan.",
    sourceRefs: [],
  });
  const { extraction: merged, report } = mergeEnrichment(base(), new Map([[SYSTEM_ID, doc]]));
  assert.equal(report.systemScope?.accepted, false);
  assert.ok((report.systemScope?.reasons ?? []).some(reason => /ghost|must restate/i.test(reason)));
  assert.equal(JSON.stringify(merged), JSON.stringify(base()));
  assert.equal(merged.entities.find(entity => entity.id === "container:pkg-a")?.responsibility, undefined);
});
