import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  C4_BANDS,
  C4_CONTEXT_CARD_FACE,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type NodeLayout,
  compareText,
} from '@okie/architecture';
import { compileC4Scene, layoutContextPeersAroundSystem, type ContextPeerItem } from './compile-c4.js';

// Context-peer placement (task #35). Persons/externalSystems (parentId undefined) are laid out in
// stage 1 relative to the STAGE-1 system width. Under aspect packing (scan mode) the system settles
// much WIDER in stage 2, so the fix re-derives the peer columns from the system's ACTUAL settled
// bounds. The golden collision test never caught this: it has 4 peers around a narrow (unpacked)
// system, so the overlap only appears with more peers around an aspect-packed wide box.

type Bounds = { x: number; y: number; width: number; height: number };

function intersects(left: Bounds, right: Bounds, padding = 0): boolean {
  return left.x - padding < right.x + right.width
    && left.x + left.width + padding > right.x
    && left.y - padding < right.y + right.height
    && left.y + left.height + padding > right.y;
}

const PEER = { width: 480, height: 190 } as const; // leafSize(person|externalSystem)
const peerItems = (count: number): ContextPeerItem[] =>
  Array.from({ length: count }, (_, index) => ({ id: `peer:${String(index).padStart(2, '0')}`, ...PEER }));

// The exact geometry the scan produces: landscape settles a short/wide system, portrait a tall/narrow
// one. These are the two orientations #30's presets pack against, taken from the real okie scan.
const WIDE_SYSTEM: NodeLayout = { x: 372, y: -156, width: 1374, height: 803 };
const TALL_SYSTEM: NodeLayout = { x: 642, y: -354, width: 837, height: 1198 };

test('context peers flank the system with zero overlaps and real clearance (8, 12, 20 peers)', () => {
  for (const system of [WIDE_SYSTEM, TALL_SYSTEM]) {
    for (const count of [8, 12, 20]) {
      const placed = layoutContextPeersAroundSystem(system, peerItems(count));
      assert.equal(placed.size, count, `every peer must be placed (${count})`);
      const boxes = [...placed.entries()].map(([id, box]) => ({ id, box }));
      const label = `${system.width}w×${count}p`;

      for (const { id, box } of boxes) {
        // A real clearance margin, not merely non-touching — the system can never grow into a peer.
        assert.ok(!intersects(box, system, 100), `${label}: ${id} must clear the system by >100u`);
        const flanks = (box.x + box.width) <= system.x || box.x >= (system.x + system.width);
        assert.ok(flanks, `${label}: ${id} must sit fully left or right of the system, not over it`);
      }
      for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
          assert.ok(!intersects(boxes[leftIndex]!.box, boxes[rightIndex]!.box),
            `${label}: ${boxes[leftIndex]!.id} × ${boxes[rightIndex]!.id} peers must not overlap`);
        }
      }
      const onLeft = boxes.filter(({ box }) => (box.x + box.width) <= system.x).length;
      assert.ok(onLeft > 0 && onLeft < boxes.length, `${label}: peers must flank BOTH sides, split ${onLeft}/${count}`);
    }
  }
});

test('heterogeneous peer sizes stay collision-free (column sized to the widest peer)', () => {
  const mixed: ContextPeerItem[] = [
    { id: 'peer:a', width: 480, height: 190 },
    { id: 'peer:b', width: 300, height: 150 },
    { id: 'peer:c', width: 520, height: 220 },
    { id: 'peer:d', width: 300, height: 150 },
    { id: 'peer:e', width: 480, height: 190 },
  ];
  const placed = layoutContextPeersAroundSystem(WIDE_SYSTEM, mixed);
  const boxes = [...placed.values()];
  for (const box of boxes) assert.ok(!intersects(box, WIDE_SYSTEM, 100), 'each peer clears the system');
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!intersects(boxes[i]!, boxes[j]!), 'mixed-size peers must not overlap');
    }
  }
});

test('peer placement is deterministic and insertion-order invariant', () => {
  const forward = peerItems(12);
  const reversed = [...forward].reverse();
  assert.deepEqual(
    [...layoutContextPeersAroundSystem(WIDE_SYSTEM, reversed).entries()].sort(),
    [...layoutContextPeersAroundSystem(WIDE_SYSTEM, forward).entries()].sort(),
    'shuffled peer input must produce identical placement',
  );
  // Same peers, same system → byte-identical bounds (no hidden nondeterminism).
  assert.deepEqual(
    layoutContextPeersAroundSystem(WIDE_SYSTEM, forward),
    layoutContextPeersAroundSystem(WIDE_SYSTEM, peerItems(12)),
  );
});

// ---- End-to-end compile integration (the gated code path actually runs and stays consistent) ----

function scanLike(peerCount: number, containerCount = 6): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:s', kind: 'softwareSystem', name: 'S', sourceRefs: [] },
  ];
  for (let index = 0; index < containerCount; index += 1) {
    entities.push({ id: `container:c${String(index).padStart(2, '0')}`, kind: 'container', parentId: 'system:s', name: `C${index}`, sourceRefs: [] });
  }
  for (let index = 0; index < peerCount; index += 1) {
    const kind = index % 2 === 0 ? 'externalSystem' : 'person';
    const prefix = kind === 'person' ? 'person' : 'external';
    entities.push({ id: `${prefix}:p${String(index).padStart(2, '0')}`, kind, name: `P${index}`, sourceRefs: [] });
  }
  return { schemaVersion: 1, id: 'snapshot:s', repositoryId: 'repo:s', commitSha: 'c', generatedAt: '2026-01-01T00:00:00.000Z', entities, relations: [] };
}

const build = (snapshot: ArchitectureSnapshot, targetAspect?: number) =>
  buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:s', focusEntityId: 'system:s', familyId: 'f',
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  });

const peersOf = (snapshot: ArchitectureSnapshot) => snapshot.entities
  .filter(entity => entity.kind === 'person' || entity.kind === 'externalSystem')
  .map(entity => entity.id).sort(compareText);

test('a real aspect-packed compile places context peers clear of the system on both flanks', () => {
  const snapshot = scanLike(8);
  const target = ASPECT_PRESET_TARGET.landscape;
  const bounds = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target })
    .projections.index.boundsByEntityIdAndBand;
  const system = bounds['system:s']!.context!;
  const boxes = peersOf(snapshot).map(id => ({ id, box: bounds[id]!.context! }));
  for (const { id, box } of boxes) {
    assert.ok(!intersects(box, system), `${id} must not overlap the compiled system box`);
    assert.ok((box.x + box.width) <= system.x || box.x >= (system.x + system.width), `${id} must flank the system`);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!intersects(boxes[i]!.box, boxes[j]!.box), `${boxes[i]!.id} × ${boxes[j]!.id} must not overlap`);
    }
  }
  const onLeft = boxes.filter(({ box }) => (box.x + box.width) <= system.x).length;
  assert.ok(onLeft > 0 && onLeft < boxes.length, 'compiled peers must flank both sides');
});

test('CLA-82: peers hug the L1 card face of a tall reserved shell, not its vertical center', () => {
  const tall: NodeLayout = { x: 400, y: -1_544, width: 1_500, height: 3_579 };
  const placed = layoutContextPeersAroundSystem(tall, peerItems(8));
  assert.equal(placed.size, 8);
  const faceBottom = tall.y + C4_CONTEXT_CARD_FACE.height;
  const hollowCenterY = tall.y + tall.height / 2;
  for (const [id, box] of placed) {
    const mid = box.y + box.height / 2;
    assert.ok(mid < faceBottom + 900, `${id} must sit near the L1 card face, not down the reserved shell`);
    assert.ok(Math.abs(mid - hollowCenterY) > 1_000, `${id} must not cluster on the hollow interior center`);
    assert.ok((box.x + box.width) <= tall.x || box.x >= (tall.x + tall.width), `${id} must still flank the system`);
  }
});

test('context peers hold one identical position across every band (persistent shells)', () => {
  const snapshot = scanLike(8);
  const target = ASPECT_PRESET_TARGET.landscape;
  const bounds = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target })
    .projections.index.boundsByEntityIdAndBand;
  for (const id of peersOf(snapshot)) {
    const perBand = bounds[id]!;
    for (const band of C4_BANDS) {
      assert.deepEqual(perBand[band], perBand.context, `${id} ${band} peer bounds must match its context shell`);
    }
  }
});

test('context peers stay fixed while a scoped file expands through L4', () => {
  const snapshot = scanLike(8);
  const target = ASPECT_PRESET_TARGET.landscape;
  const component = snapshot.entities.find(entity => entity.kind === 'component');
  // Add a small file under the existing package so this exercises the deep
  // component/code translation rather than only the system-root compile.
  snapshot.entities.push(
    { id: 'component:file', kind: 'component', parentId: 'container:c00', name: 'file', sourceRefs: [] },
    { id: 'code:file:a', kind: 'code', parentId: 'component:file', name: 'a', sourceRefs: [] },
  );
  assert.equal(component, undefined, 'the base fixture has no component before adding the scoped file');
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:s', focusEntityId: 'component:file', familyId: 'f', targetAspect: target,
  });
  const bounds = compileC4Scene(snapshot, bundle, { targetAspect: target })
    .projections.index.boundsByEntityIdAndBand;
  for (const id of peersOf(snapshot)) {
    assert.deepEqual(bounds[id]!.code, bounds[id]!.context, `${id} must remain at its context shell in L4`);
  }
});

test('scan-like peer compile is deterministic under reversed entity order', () => {
  const snapshot = scanLike(12);
  const target = ASPECT_PRESET_TARGET.landscape;
  const forward = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target }).scene;
  const reversedSnapshot = { ...snapshot, entities: [...snapshot.entities].reverse() };
  const reversed = compileC4Scene(reversedSnapshot, build(reversedSnapshot, target), { targetAspect: target }).scene;
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed), 'peer placement must be insertion-order invariant');
});

test('default path (no targetAspect) keeps the stage-1 peer columns byte-for-byte', () => {
  // The golden/demo fixtures never pass targetAspect, so the new placement must be fully gated:
  // stage-1 puts the first (id-sorted, even-index) context peer in the left column at x=80.
  const snapshot = scanLike(8);
  const bounds = compileC4Scene(snapshot, build(snapshot)).projections.index.boundsByEntityIdAndBand;
  const firstPeerId = peersOf(snapshot)[0]!;
  assert.equal(bounds[firstPeerId]!.context!.x, 80, 'default compile must keep the stage-1 left peer column (x=80)');
});

test('CLA-96: neighborhood L1 compiles a landscape context map, not a tall reserved shell', () => {
  const snapshot = scanLike(8, 16);
  const unpublished = snapshot.entities
    .filter(entity => entity.kind === 'container')
    .flatMap(container => Array.from({ length: 10 }, (_, index) => ({
      id: `component:${container.id.slice('container:'.length)}-${String(index).padStart(2, '0')}`,
      kind: 'component' as const,
      parentId: container.id,
    })));
  const childCounts: Record<string, number> = { 'system:s': 16 };
  for (const entity of snapshot.entities) {
    if (entity.kind === 'container') childCounts[entity.id] = 10;
  }
  const target = ASPECT_PRESET_TARGET.landscape;
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:s',
    focusEntityId: 'system:s',
    familyId: 'f',
    maxBand: 'container',
    targetAspect: target,
  });
  const compiled = compileC4Scene(snapshot, bundle, {
    targetAspect: target,
    childCounts,
    unpublishedChildren: unpublished,
  });
  const system = compiled.projections.index.boundsByEntityIdAndBand['system:s']!.context!;
  assert.equal(system.width, C4_CONTEXT_CARD_FACE.width, 'L1 system is the readable card, not the reserved interior');
  assert.equal(system.height, C4_CONTEXT_CARD_FACE.height);
  const aspect = compiled.scene.worldBounds.width / compiled.scene.worldBounds.height;
  assert.ok(aspect >= 1.4, `neighborhood L1 world aspect ${aspect.toFixed(3)} should be landscape ≥ 1.4`);
  const boxes = peersOf(snapshot).map(id => ({ id, box: compiled.projections.index.boundsByEntityIdAndBand[id]!.context! }));
  for (const { id, box } of boxes) {
    assert.ok(!intersects(box, system), `${id} must not overlap the L1 card`);
    assert.ok((box.x + box.width) <= system.x || box.x >= (system.x + system.width), `${id} must flank the L1 card`);
  }
});
