import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  ArchitectureView,
  EntityKind,
  SourceExcerpt,
} from "./model.js";
import {
  excerptPacketForEntity,
  mergeArchitectureNeighborhoods,
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  snapshotPreplacesL3InL2,
  validateNeighborhoodPacket,
} from "./neighborhood.js";

const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fixture(path), "utf8")) as T;
}

function excerpt(path: string): SourceExcerpt {
  const lines = Array.from({ length: 8 }, (_, index) => `export function f${index}() { return ${index}; }`);
  return {
    path,
    language: "typescript",
    startLine: 1,
    endLine: 8,
    highlightLine: 1,
    frozenRevision: "sha",
    lines,
    text: lines.join("\n"),
  };
}

function entity(id: string, kind: EntityKind, parentId?: string, withExcerpt = false): ArchitectureEntity {
  const path = `src/${id.replaceAll(":", "/")}.ts`;
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path, commitSha: "sha", symbol: id }],
    ...(parentId ? { parentId } : {}),
    ...(withExcerpt ? { sourceExcerpts: [excerpt(path)] } : {}),
  };
}

function relation(id: string, from: string, to: string, kind: ArchitectureRelation["kind"] = "uses"): ArchitectureRelation {
  return {
    id,
    from,
    to,
    kind,
    evidence: [{ source: { path: `src/${from.replaceAll(":", "/")}.ts`, commitSha: "sha" } }],
  };
}

function viewFor(snapshot: ArchitectureSnapshot, rootEntityId: string): ArchitectureView {
  return {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "test",
    rootEntityId,
    entityIds: snapshot.entities.map(item => item.id),
    relationIds: snapshot.relations.map(item => item.id),
    layout: {
      nodes: Object.fromEntries(snapshot.entities.map((item, index) => [item.id, {
        x: index * 10,
        y: 0,
        width: 8,
        height: 8,
      }])),
    },
  };
}

/** ~200 L4 rows + excerpts + import graph — the shape CLA-73 must not ship at L1. */
function fatSnapshot(): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
    entity("actor:dev", "person"),
    entity("external:gh", "externalSystem"),
  ];
  const relations: ArchitectureRelation[] = [
    relation("rel:dev-root", "actor:dev", "system:root"),
  ];
  for (let container = 0; container < 8; container += 1) {
    const containerId = `container:c${container}`;
    entities.push(entity(containerId, "container", "system:root"));
    relations.push(relation(`rel:root-${containerId}`, "system:root", containerId, "contains"));
    for (let component = 0; component < 4; component += 1) {
      const componentId = `component:c${container}-f${component}`;
      entities.push(entity(componentId, "component", containerId));
      const codeIds: string[] = [];
      for (let code = 0; code < 8; code += 1) {
        const codeId = `code:c${container}-f${component}-n${code}`;
        codeIds.push(codeId);
        entities.push(entity(codeId, "code", componentId, true));
      }
      for (let index = 0; index < codeIds.length - 1; index += 1) {
        relations.push(relation(`rel:uses-${codeIds[index]}`, codeIds[index]!, codeIds[index + 1]!));
      }
    }
  }
  return {
    schemaVersion: 1,
    id: "snapshot:fat",
    repositoryId: "repo:fat",
    commitSha: "sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations,
  };
}

test("CLA-73: L1 neighborhood omits L4 excerpts and the import graph", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "system:root" });
  const kinds = new Set(packet.snapshot.entities.map(item => item.kind));
  const fullBytes = JSON.stringify(snapshot).length;
  const slimBytes = JSON.stringify(packet.snapshot).length;

  assert.equal(packet.kind, "neighborhood");
  assert.equal(packet.focusEntityId, "system:root");
  assert.equal(packet.truncated, true);
  assert.ok(kinds.has("softwareSystem"));
  assert.ok(kinds.has("person"));
  assert.ok(kinds.has("container"));
  assert.equal(kinds.has("component"), false);
  assert.equal(kinds.has("code"), false);
  assert.equal(packet.snapshot.entities.some(item => item.sourceExcerpts?.length), false);
  assert.equal(packet.snapshot.relations.some(item => item.kind === "uses" && item.from.startsWith("code:")), false);
  assert.ok(packet.childCounts["container:c0"] === 4);
  assert.ok(packet.childCounts["system:root"] === 8);
  assert.ok((packet.unpublishedChildren?.length ?? 0) > 0);
  assert.ok(packet.view.layout.nodes["container:c0"]!.width > 1);
  assert.ok(slimBytes * 8 < fullBytes, `L1 snapshot ${slimBytes}B should be far under full ${fullBytes}B`);
  assert.ok(slimBytes < 80_000, `L1 snapshot ${slimBytes}B must not approach the 4MB full trio`);
  assert.deepEqual(validateNeighborhoodPacket(packet), []);
});

test("CLA-73: Open inside a container ships that container's components, not sibling L4", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "container:c3" });
  const ids = new Set(packet.snapshot.entities.map(item => item.id));
  assert.ok(ids.has("system:root"));
  assert.ok(ids.has("container:c3"));
  assert.ok(ids.has("component:c3-f0"));
  assert.equal(ids.has("container:c0"), false);
  assert.equal(ids.has("component:c0-f0"), false);
  assert.equal(packet.snapshot.entities.some(item => item.kind === "code"), false);
  assert.equal(packet.childCounts["component:c3-f0"], 8);
  assert.deepEqual(validateNeighborhoodPacket(packet), []);
});

test("CLA-73: a deep code sel fetches that file neighborhood, not the whole tree first", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "code:c2-f1-n3" });
  const ids = new Set(packet.snapshot.entities.map(item => item.id));
  assert.ok(ids.has("system:root"));
  assert.ok(ids.has("container:c2"));
  assert.ok(ids.has("component:c2-f1"));
  assert.ok(ids.has("code:c2-f1-n3"));
  assert.ok(ids.has("code:c2-f1-n0"));
  assert.equal(ids.has("container:c0"), false);
  assert.equal(ids.has("component:c2-f0"), false);
  assert.equal(packet.snapshot.entities.every(item => !item.sourceExcerpts?.length), true);
  assert.ok(packet.snapshot.relations.some(item => item.from.startsWith("code:c2-f1-")));
  assert.deepEqual(validateNeighborhoodPacket(packet), []);
});

test("unknown focus falls back to the view root without throwing", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "code:missing" });
  assert.equal(packet.focusEntityId, "system:root");
  assert.ok(packet.truncated);
});

test("excerpt packet is per-entity and keeps portable lines", () => {
  const snapshot = fatSnapshot();
  const packet = excerptPacketForEntity(snapshot, "code:c0-f0-n0");
  assert.ok(packet);
  assert.equal(packet.kind, "excerpt");
  assert.equal(packet.entityId, "code:c0-f0-n0");
  assert.ok((packet.sourceExcerpts[0]?.text.length ?? 0) > 0);
  assert.equal(excerptPacketForEntity(snapshot, "missing"), undefined);
});

test("merge keeps already-loaded excerpts when the incoming packet stripped them", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "system:root" });
  const file = sliceArchitectureNeighborhood(snapshot, view, {
    focusEntityId: "code:c0-f0-n0",
    includeExcerpts: true,
  });
  const stripped = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "code:c0-f0-n0" });
  const withExcerpt = mergeArchitectureNeighborhoods(l1.snapshot, file.snapshot);
  const again = mergeArchitectureNeighborhoods(withExcerpt, stripped.snapshot);
  const code = again.entities.find(item => item.id === "code:c0-f0-n0");
  assert.ok(code?.sourceExcerpts?.length);
  assert.ok(again.entities.some(item => item.id === "container:c0"));
});

test("partial deep neighborhoods retain enriched overview fields and accept supplied updates", () => {
  const snapshot = fatSnapshot();
  const web = snapshot.entities.find(item => item.id === "container:c0")!;
  web.responsibility = "Hosts the interactive atlas and its inspector.";
  web.technology = ["React"];
  web.owners = ["@atlas-ui"];
  const partial = { ...snapshot, entities: [entity(web.id, web.kind, web.parentId)] };
  const restored = mergeArchitectureNeighborhoods(snapshot, partial);
  assert.equal(restored.entities.find(item => item.id === web.id)?.responsibility, web.responsibility);
  assert.deepEqual(restored.entities.find(item => item.id === web.id)?.technology, ["React"]);
  assert.deepEqual(restored.entities.find(item => item.id === web.id)?.owners, ["@atlas-ui"]);
  const updated = mergeArchitectureNeighborhoods(restored, {
    ...partial, entities: [{ ...partial.entities[0]!, responsibility: "Updated overview", technology: [] }],
  });
  assert.equal(updated.entities.find(item => item.id === web.id)?.responsibility, "Updated overview");
  assert.deepEqual(updated.entities.find(item => item.id === web.id)?.technology, []);
  assert.equal(web.responsibility, "Hosts the interactive atlas and its inspector.");
});

test("neighborhood enrichment cannot leak across snapshot identities", () => {
  const base = fatSnapshot();
  for (const identity of ["id", "repositoryId", "commitSha"] as const) {
    assert.throws(() => mergeArchitectureNeighborhoods(base, { ...base, [identity]: "other" }),
      /different snapshots/);
  }
});

test("golden L1 neighborhood stays a handful and validates", async () => {
  const snapshot = await readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json");
  const view = await readJson<ArchitectureView>("architecture/demo-view.json");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "system:okie" });
  const kinds = new Set(packet.snapshot.entities.map(item => item.kind));
  assert.ok(packet.truncated);
  assert.ok(kinds.has("softwareSystem"));
  assert.ok(kinds.has("container"));
  assert.equal(kinds.has("component"), false);
  assert.equal(kinds.has("code"), false);
  assert.ok(packet.snapshot.entities.length < 20);
  assert.deepEqual(validateNeighborhoodPacket(packet), []);
});

test("CLA-107/109: small-repo L1 opt-in includes components and code", async () => {
  const snapshot = await readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json");
  const view = await readJson<ArchitectureView>("architecture/demo-view.json");
  const options = neighborhoodSliceOptionsForFocus(snapshot, "system:okie");
  assert.deepEqual(options, { maxBand: "code" });
  const packet = sliceArchitectureNeighborhood(snapshot, view, {
    focusEntityId: "system:okie",
    ...options,
  });
  const kinds = new Set(packet.snapshot.entities.map(item => item.kind));
  assert.ok(kinds.has("softwareSystem"));
  assert.ok(kinds.has("container"));
  assert.ok(kinds.has("component"));
  assert.ok(kinds.has("code"));
  assert.ok(packet.snapshot.entities.some(item => item.kind === "code" && item.parentId?.startsWith("component:")));
  assert.deepEqual(validateNeighborhoodPacket(packet), []);
});

test("CLA-107: default L1 slice stays CLA-73 (no auto-rewrite of +1 band)", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "system:root" });
  assert.equal(packet.snapshot.entities.some(item => item.kind === "component"), false);
  const opted = sliceArchitectureNeighborhood(snapshot, view, {
    focusEntityId: "system:root",
    ...neighborhoodSliceOptionsForFocus(snapshot, "system:root"),
  });
  assert.ok(opted.snapshot.entities.some(item => item.kind === "component"));
  assert.ok(opted.snapshot.entities.some(item => item.kind === "code"));
});

test("CLA-107: 10 containers still pre-place when L4 code exceeds 2000", () => {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
  ];
  for (let index = 0; index < 10; index += 1) {
    const containerId = `container:c${index}`;
    entities.push(entity(containerId, "container", "system:root"));
    entities.push(entity(`component:c${index}-f0`, "component", containerId));
  }
  for (let index = 0; index < 3000; index += 1) {
    entities.push(entity(`code:n${index}`, "code", "component:c0-f0"));
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:okie-shaped",
    repositoryId: "repo:okie",
    commitSha: "sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations: [],
  };
  assert.ok(snapshot.entities.length > 2000);
  assert.equal(snapshotPreplacesL3InL2(snapshot), true);
  assert.deepEqual(neighborhoodSliceOptionsForFocus(snapshot, "system:root"), { maxBand: "code" });
});

test("CLA-107: 13+ containers do not opt into L3-in-L1", () => {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
  ];
  for (let index = 0; index < 13; index += 1) {
    const containerId = `container:c${index}`;
    entities.push(entity(containerId, "container", "system:root"));
    entities.push(entity(`component:c${index}-f0`, "component", containerId));
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:large",
    repositoryId: "repo:large",
    commitSha: "sha",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations: [],
  };
  assert.deepEqual(neighborhoodSliceOptionsForFocus(snapshot, "system:root"), {});
  const view = viewFor(snapshot, "system:root");
  const packet = sliceArchitectureNeighborhood(snapshot, view, {
    focusEntityId: "system:root",
    ...neighborhoodSliceOptionsForFocus(snapshot, "system:root"),
  });
  assert.equal(packet.snapshot.entities.some(item => item.kind === "component"), false);
});

test("neighborhood payload never carries host paths or key-shaped fields", () => {
  const snapshot = fatSnapshot();
  const view = viewFor(snapshot, "system:root");
  const json = JSON.stringify(sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: "system:root" }));
  assert.doesNotMatch(json, /scanRoot/);
  assert.doesNotMatch(json, /apiKey/);
  assert.doesNotMatch(json, /OPENROUTER/);
  assert.doesNotMatch(json, /gho_|ghp_|github_pat_/);
  assert.doesNotMatch(json, /\/home\/|\\\\Users\\\\/);
});
