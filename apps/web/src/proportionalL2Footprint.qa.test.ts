import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  C4_BAND_FOCUS_ZOOM,
  C4_SCAN_L2_PEER_TILE_CHILD_COMFORT,
  c4ScanContainerPeerTile,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type EntityKind,
} from '@okie/architecture';
import {
  BAND_COST_HANG_GUARD_ENTITIES,
} from '@okie/scene-compiler';
import { canvasCardTextLayout, canvasEntityPresentationMetrics } from './renderer/Canvas2DRenderer';
import type { SceneEntity } from './renderer/types';
import { createC4Scene } from './renderer/goldenC4Scene';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';

function entity(id: string, kind: EntityKind, parentId?: string, name = id): ArchitectureEntity {
  return { id, name, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

/** CLA-65 pair: fat `@okie/web` + thinner `@okie/server`. */
function webServerNeighborhood(webCount = 79, serverCount = 8): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity('system:okie', 'softwareSystem', undefined, 'Okie'),
    entity('container:apps-web', 'container', 'system:okie', '@okie/web'),
    entity('container:apps-server', 'container', 'system:okie', '@okie/server'),
  ];
  for (let index = 0; index < webCount; index += 1) {
    const id = `component:web-${String(index).padStart(2, '0')}`;
    entities.push(entity(id, 'component', 'container:apps-web', `File${index}.ts`));
    entities.push(entity(`code:${id}`, 'code', id, 'k'));
  }
  for (let index = 0; index < serverCount; index += 1) {
    const id = `component:server-${index}`;
    entities.push(entity(id, 'component', 'container:apps-server', `srv${index}.ts`));
    entities.push(entity(`code:${id}`, 'code', id, 'k'));
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-119',
    repositoryId: 'repo:cla-119',
    commitSha: 'c'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function l2Scene(snapshot: ArchitectureSnapshot) {
  return createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'f',
    sceneId: 's',
    title: 't',
    subtitle: 's',
    frozenRevision: 'c',
    maxBand: 'code',
    maxNodesPerBand: 50,
    pageCodeLandmarks: true,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
}

describe('CLA-119: proportional L2 container footprints (soft √N, not a treemap)', () => {
  const fixtureSource = (readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8') + readFileSync(new URL('./renderer/scanScene.ts', import.meta.url), 'utf8'));

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
    expect(C4_SCAN_L2_PEER_TILE_CHILD_COMFORT).toBe(9);
    expect(fixtureSource).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });

  it('gives @okie/web a larger L2 shell than @okie/server so resident titles fit', () => {
    const snapshot = webServerNeighborhood();
    const l2 = l2Scene(snapshot);
    const web = l2.projection?.boundsByEntityIdAndDetail['container:apps-web']?.container;
    const server = l2.projection?.boundsByEntityIdAndDetail['container:apps-server']?.container;
    expect(web).toBeDefined();
    expect(server).toBeDefined();
    expect(web!.width).toBeCloseTo(c4ScanContainerPeerTile(79).width, 5);
    expect(server!.width).toBeCloseTo(c4ScanContainerPeerTile(8).width, 5);
    expect(web!.width).toBeGreaterThan(server!.width);
    expect(web!.height).toBeGreaterThan(server!.height);

    const pills = snapshot.entities
      .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
      .map(item => l2.projection?.boundsByEntityIdAndDetail[item.id]?.component)
      .filter((box): box is NonNullable<typeof box> => Boolean(box));
    expect(pills.length).toBeGreaterThan(0);
    const shortest = Math.min(...pills.map(box => box.height));
    const zoom = C4_BAND_FOCUS_ZOOM.component;
    const metrics = canvasEntityPresentationMetrics('component', false, zoom);
    const titleBaselineWorld = metrics.titleBaseline / zoom;
    expect(shortest).toBeGreaterThan(titleBaselineWorld);
    // CLA-381: the metric is the baseline Canvas actually paints, not a fixed offset.
    const painted = canvasCardTextLayout(
      { id: 'component:probe', name: 'probe', kind: 'component', detail: 'component', x: 0, y: 0, width: 200, height: 100 } as SceneEntity,
      'component', false, zoom, 200 * zoom,
    );
    expect(metrics.titleBaseline).toBeCloseTo(painted.lines.find(line => line.role === 'title')!.baseline, 5);
  });

  it('Open inside @okie/web still lands on L3 file cards', () => {
    const snapshot = webServerNeighborhood();
    const l3 = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'container:apps-web',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'component',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    expect(l3.rootEntityId).toBe('container:apps-web');
    const cards = snapshot.entities
      .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
      .map(item => l3.projection?.boundsByEntityIdAndDetail[item.id]?.component)
      .filter((box): box is NonNullable<typeof box> => Boolean(box));
    expect(cards.length).toBeGreaterThan(6);
    const owner = l3.projection?.boundsByEntityIdAndDetail['container:apps-web']?.component;
    expect(owner).toBeDefined();
    expect(cards.every(box =>
      box.x >= owner!.x - 1
      && box.y >= owner!.y - 1
      && box.x + box.width <= owner!.x + owner!.width + 1
      && box.y + box.height <= owner!.y + owner!.height + 1
    )).toBe(true);
  });
});
