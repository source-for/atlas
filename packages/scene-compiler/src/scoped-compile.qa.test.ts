import assert from "node:assert/strict";
import test from "node:test";
import {
  buildC4ProjectionBundle,
  computeContainmentLayout,
  selectC4BandProjection,
  type ArchitectureSnapshot,
  type C4Band,
  compareText,
} from "@okie/architecture";
import { compileC4Scene } from "./compile-c4.js";
import { denseNeighborhoodSnapshot, denseSnapshot } from "./band-cost-curve.js";

// Opt-in scoped compile (task #26): band-depth + per-band edge budget bound the routing
// cost of large-repo scenes. Defaults are OFF and must stay byte-identical.
// CLA-67 extends this harness in band-cost-curve.ts / band-cost-curve.qa.test.ts.

const rootFocus = { rootEntityId: "system:d", focusEntityId: "system:d", familyId: "f" } as const;
function bandEdges(bundle: ReturnType<typeof buildC4ProjectionBundle>, band: C4Band): { routed: string[]; omitted: string[] } {
  const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
  return { routed: projection.visualEdgeIds, omitted: projection.omittedEdgeIds ?? [] };
}

test("maxBand leaves deeper bands empty (container-only top scene)", () => {
  const snapshot = denseSnapshot(40);
  const bundle = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxBand: "container" });
  assert.ok(selectC4BandProjection(bundle, "container").nodes.length > 0, "container band populated");
  assert.equal(selectC4BandProjection(bundle, "component").nodes.length, 0, "component band empty");
  assert.equal(selectC4BandProjection(bundle, "code").nodes.length, 0, "code band empty");
  // the compiled scene renders no component/code objects — only container-level.
  const scene = compileC4Scene(snapshot, bundle).scene;
  assert.ok(scene.objects.length > 0 && scene.objects.length < 12, "bounded top scene");
});

test("maxEdgesPerBand routes only the top-N edges by (count desc, id asc); the rest are omitted but retained", () => {
  const snapshot = denseSnapshot(40);
  const budget = 10;
  const bundle = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: budget });
  const { routed, omitted } = bandEdges(bundle, "component");
  assert.equal(routed.length, budget, "routes exactly the budget");
  assert.equal(routed.length + omitted.length, 41, "kept + omitted = all visual edges (40 chain + 1 hub)");
  // the hub (aggregate count 5) is the highest weight -> always kept.
  assert.ok(routed.some(id => bundle.visualEdgeById[id]!.aggregate.count === 5), "hub edge kept");
  assert.ok(omitted.every(id => bundle.visualEdgeById[id]!.aggregate.count === 1), "only count-1 edges omitted");
  // omitted edges stay enumerable via the index (their relation ids survive).
  for (const id of omitted) assert.ok((bundle.index.relationIdsByVisualEdgeId[id]?.length ?? 0) >= 1);
  // routing is bounded: the compiled scene has exactly `budget` paths.
  assert.equal(compileC4Scene(snapshot, bundle).scene.paths.length, budget);
});

test("edge budget selection is deterministic under shuffled relation order", () => {
  const snapshot = denseSnapshot(40);
  const shuffled: ArchitectureSnapshot = { ...snapshot, relations: [...snapshot.relations].reverse() };
  const a = bandEdges(buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 12 }), "component");
  const b = bandEdges(buildC4ProjectionBundle(shuffled, { ...rootFocus, maxEdgesPerBand: 12 }), "component");
  assert.deepEqual(a.routed, b.routed);
  assert.deepEqual(a.omitted, b.omitted);
});

test("default path is byte-identical and carries no omittedEdgeIds", () => {
  const snapshot = denseSnapshot(20);
  const first = buildC4ProjectionBundle(snapshot, rootFocus);
  const second = buildC4ProjectionBundle(snapshot, rootFocus);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "default build is deterministic");
  for (const band of ["context", "container", "component", "code"] as const) {
    assert.equal(first.projectionById[first.family.projectionIds[band]]!.omittedEdgeIds, undefined, `${band} has no omittedEdgeIds by default`);
    assert.equal(first.projectionById[first.family.projectionIds[band]]!.omittedNodeIds, undefined, `${band} has no omittedNodeIds by default`);
  }
  // a budget large enough to keep everything must equal the default bytes exactly.
  const unbounded = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 100000 });
  assert.equal(JSON.stringify(unbounded), JSON.stringify(first), "over-budget == default (opt-in never changes small graphs)");
});

test("maxGridNodes cap degrades gracefully (never throws) and stays deterministic; default byte-identical", () => {
  const snapshot = denseSnapshot(40);
  // A tiny grid budget must NOT throw — edges that can't route obstacle-safe fall back to a direct L.
  const compileTight = () => compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 30, maxGridNodes: 64 }), { maxGridNodes: 64 }).scene;
  const first = compileTight();
  assert.ok(first.paths.length > 0, "compiles under a tight grid budget");
  assert.equal(JSON.stringify(first), JSON.stringify(compileTight()), "deterministic under a grid cap");
  // default (no maxGridNodes) equals the explicit 20000 default — opt-in never changes the default path.
  const dflt = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, rootFocus)).scene;
  const explicit = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, { ...rootFocus, maxGridNodes: 20_000 }), { maxGridNodes: 20_000 }).scene;
  assert.equal(JSON.stringify(dflt), JSON.stringify(explicit), "default == maxGridNodes 20000 (byte-identical)");
});

test("CLA-74: maxNodesPerBand pages off-screen L3/L4 and keeps +N more; default stays byte-identical", () => {
  const snapshot = denseSnapshot(80);
  const dflt = buildC4ProjectionBundle(snapshot, { rootEntityId: "container:c", focusEntityId: "container:c", familyId: "f" });
  const paged = buildC4ProjectionBundle(snapshot, {
    rootEntityId: "container:c",
    focusEntityId: "container:c",
    familyId: "f",
    maxBand: "component",
    maxNodesPerBand: 20,
  });
  const component = paged.projectionById[paged.family.projectionIds.component]!;
  const defaultComponent = dflt.projectionById[dflt.family.projectionIds.component]!;
  assert.ok(component.visualNodeIds.length < defaultComponent.visualNodeIds.length, "paged compile keeps fewer L3 nodes");
  assert.ok((component.omittedNodeIds?.length ?? 0) > 0, "omitted nodes stay enumerable");
  assert.equal(
    component.visualNodeIds.length + (component.omittedNodeIds?.length ?? 0),
    defaultComponent.visualNodeIds.length,
    "resident + omitted = neighborhood",
  );
  const compiledFull = compileC4Scene(snapshot, paged);
  const compiled = compiledFull.scene;
  const full = compileC4Scene(snapshot, dflt).scene;
  assert.ok(compiled.objects.length < full.objects.length, "protocol omits off-screen L3 cards");
  const omitted = new Set(component.omittedNodeIds ?? []);
  assert.equal(compiled.objects.some(object => omitted.has(object.id)), false, "omitted cards are not extra protocol objects");
  const reserved = compiledFull.projections.bandLayoutById[component.layoutId]?.reservedShells ?? {};
  assert.ok(Object.keys(reserved).some(id => omitted.has(id)), "omitted children keep reserved shells on the owner");
  const unbounded = buildC4ProjectionBundle(snapshot, rootFocus);
  const explicit = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxNodesPerBand: 100000 });
  assert.equal(JSON.stringify(unbounded), JSON.stringify(explicit), "over-cap == default (opt-in never changes small graphs)");
});

test("CLA-74: panning the camera window compiles a sibling tile, not the full graph", () => {
  const snapshot = denseSnapshot(60);
  const focus = { rootEntityId: "container:c", focusEntityId: "container:c", familyId: "f", maxBand: "component" } as const;
  const full = buildC4ProjectionBundle(snapshot, focus);
  const layout = full.bandLayoutById[full.projectionById[full.family.projectionIds.component]!.layoutId]!;
  const children = Object.entries(layout.nodes)
    .filter(([id]) => id.includes("component:c-m"))
    .sort(([left], [right]) => compareText(left, right));
  const first = children[0]![1];
  const last = children.at(-1)![1];
  const left = buildC4ProjectionBundle(snapshot, {
    ...focus,
    residentWorldBounds: { x: first.x, y: first.y, width: first.width, height: first.height },
  });
  const right = buildC4ProjectionBundle(snapshot, {
    ...focus,
    residentWorldBounds: { x: last.x, y: last.y, width: last.width, height: last.height },
  });
  const leftIds = left.projectionById[left.family.projectionIds.component]!.visualNodeIds;
  const rightIds = right.projectionById[right.family.projectionIds.component]!.visualNodeIds;
  assert.notDeepEqual(leftIds, rightIds, "adjacent tile is a different resident set");
  assert.ok(leftIds.length < children.length, "left tile is not the sibling dump");
  assert.ok(rightIds.length < children.length, "right tile is not the sibling dump");
});

test("CLA-109: pageCodeLandmarks keeps L3 and caps L4 without reserved-shell dump", () => {
  const snapshot = denseNeighborhoodSnapshot("code", 80);
  const focus = {
    rootEntityId: "system:d",
    focusEntityId: "system:d",
    familyId: "f",
    maxBand: "code" as const,
    maxNodesPerBand: 20,
    pageCodeLandmarks: true,
  };
  const paged = buildC4ProjectionBundle(snapshot, focus);
  const component = paged.projectionById[paged.family.projectionIds.component]!;
  const code = paged.projectionById[paged.family.projectionIds.code]!;
  assert.equal((component.omittedNodeIds ?? []).length, 0, "L3 file shells stay resident");
  assert.ok((code.omittedNodeIds?.length ?? 0) > 0, "L4 omitted stay enumerable");
  const codeKindCount = code.visualNodeIds.filter(id => paged.visualNodeById[id]?.kind === "code").length;
  assert.ok(codeKindCount <= 20, "resident L4 respects the window");
  const compiled = compileC4Scene(snapshot, paged);
  const reserved = compiled.projections.bandLayoutById[code.layoutId]?.reservedShells ?? {};
  assert.equal(Object.keys(reserved).length, 0, "unpacked omitted L4 are not reserved-shell primitives");
  assert.ok(compiled.scene.objects.length < 40, "protocol stays a neighborhood, not 80 symbol meshes");
});

test("CLA-109: camera window keeps L4 of the on-screen file via parent faces", () => {
  const snapshot = denseNeighborhoodSnapshot("code", 80);
  const hints = computeContainmentLayout(
    snapshot.entities.map(entity => ({
      id: entity.id,
      kind: entity.kind,
      ...(entity.parentId ? { parentId: entity.parentId } : {}),
    })),
    { targetAspect: 1.6 },
  );
  const file = hints["component:c"]!;
  const paged = buildC4ProjectionBundle(snapshot, {
    rootEntityId: "system:d",
    focusEntityId: "system:d",
    familyId: "f",
    maxBand: "code",
    maxNodesPerBand: 20,
    pageCodeLandmarks: true,
    entityLayoutHints: hints,
    residentWorldBounds: { x: file.x, y: file.y, width: Math.max(1, file.width), height: Math.max(1, file.height) },
  });
  const code = paged.projectionById[paged.family.projectionIds.code]!;
  const codeKindCount = code.visualNodeIds.filter(id => paged.visualNodeById[id]?.kind === "code").length;
  assert.ok(codeKindCount > 0, "on-screen file keeps L4 landmarks");
  assert.ok(codeKindCount <= 20, "resident L4 respects the window");
  assert.ok((code.omittedNodeIds?.length ?? 0) > 0, "off-camera L4 stays enumerable");
  const compiled = compileC4Scene(snapshot, paged, { targetAspect: 1.6 });
  const fileVisualId = paged.index.visualNodeIdsByEntityId["component:c"]?.[0];
  const componentLayout = compiled.projections.bandLayoutById[paged.projectionById[paged.family.projectionIds.component]!.layoutId];
  const codeLayout = compiled.projections.bandLayoutById[code.layoutId];
  const compact = fileVisualId ? componentLayout?.nodes[fileVisualId] : undefined;
  const codeFace = fileVisualId ? codeLayout?.nodes[fileVisualId] : undefined;
  assert.ok(compact && codeFace);
  assert.equal(codeFace!.width, compact!.width);
  assert.equal(codeFace!.height, compact!.height);
  const residentCode = code.visualNodeIds.filter(id => {
    const node = paged.visualNodeById[id];
    return node?.kind === "code" && node.parentVisualId === fileVisualId;
  });
  assert.ok(residentCode.length > 0);
  for (const id of residentCode) {
    const bounds = codeLayout?.nodes[id];
    assert.ok(bounds);
    assert.ok(bounds!.x >= codeFace!.x - 1, "L4 stays on the L3 file face");
    assert.ok(bounds!.y >= codeFace!.y - 1, "L4 stays on the L3 file face");
    assert.ok(bounds!.x + bounds!.width <= codeFace!.x + codeFace!.width + 1, "L4 stays on the L3 file face");
    assert.ok(bounds!.y + bounds!.height <= codeFace!.y + codeFace!.height + 1, "L4 stays on the L3 file face");
  }
});

test("CLA-109: scan system L3 files sit on the compact L2 container tile", () => {
  const snapshot = denseNeighborhoodSnapshot("code", 80);
  const paged = buildC4ProjectionBundle(snapshot, {
    rootEntityId: "system:d",
    focusEntityId: "system:d",
    familyId: "f",
    maxBand: "code",
    maxNodesPerBand: 20,
    pageCodeLandmarks: true,
    targetAspect: 1.6,
  });
  const compiled = compileC4Scene(snapshot, paged, { targetAspect: 1.6 });
  const containerVisualId = paged.index.visualNodeIdsByEntityId["container:c"]?.[0];
  const fileVisualId = paged.index.visualNodeIdsByEntityId["component:c"]?.[0];
  const containerLayout = compiled.projections.bandLayoutById[
    paged.projectionById[paged.family.projectionIds.container]!.layoutId
  ];
  const componentLayout = compiled.projections.bandLayoutById[
    paged.projectionById[paged.family.projectionIds.component]!.layoutId
  ];
  const l2 = containerVisualId ? containerLayout?.nodes[containerVisualId] : undefined;
  const l3 = containerVisualId ? componentLayout?.nodes[containerVisualId] : undefined;
  const fileFace = fileVisualId ? componentLayout?.nodes[fileVisualId] : undefined;
  assert.ok(l2 && l3 && fileFace);
  assert.equal(l3!.width, l2!.width);
  assert.equal(l3!.height, l2!.height);
  assert.ok(Math.abs(l3!.x - l2!.x) < 1e-6);
  assert.ok(Math.abs(l3!.y - l2!.y) < 1e-6);
  assert.ok(fileFace!.x >= l2!.x - 1, "L3 file stays on the L2 tile");
  assert.ok(fileFace!.y >= l2!.y - 1, "L3 file stays on the L2 tile");
  assert.ok(fileFace!.x + fileFace!.width <= l2!.x + l2!.width + 1, "L3 file stays on the L2 tile");
  assert.ok(fileFace!.y + fileFace!.height <= l2!.y + l2!.height + 1, "L3 file stays on the L2 tile");
});
