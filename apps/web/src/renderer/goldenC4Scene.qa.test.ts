import { describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer, canvasEntityPresentationMetrics } from './Canvas2DRenderer';
import { createGoldenC4Scene, goldenAppStory } from './goldenC4Scene';
import { semanticLevelSession, semanticSourceSession } from '../semantic/semanticLensEngine';
import type { Camera, RenderState, SemanticDetail } from './types';
import {
  idleSemanticLens,
  compensateSemanticMorphCamera,
  reduceSemanticLens,
  semanticBaseProjectionOverride,
  semanticLensProjectionOverride,
  semanticLensSessionGhostEntities,
  semanticLensSessionProjectionOverride,
  semanticLensSessionSilhouetteEntities,
  type SemanticLensTarget,
} from '../semantic/semanticLens';

const bands = [
  { detail: 'context' as const, zoom: 0.62, entities: 4, relations: 3 },
  { detail: 'container' as const, zoom: 2.05, entities: 9, relations: 5 },
  { detail: 'component' as const, zoom: 5.15, entities: 29, relations: 23 },
  { detail: 'code' as const, zoom: 14, entities: 70, relations: 12 },
];

type CanvasTextCall = { content: string; alpha: number; font: string };

function fakeCanvas(textCalls?: CanvasTextCall[]) {
  const values: Record<PropertyKey, unknown> = {};
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? (property === 'fillText'
        ? vi.fn((content: string) => textCalls?.push({
            content,
            alpha: Number(target.globalAlpha ?? 1),
            font: String(target.font ?? ''),
          }))
        : vi.fn());
      calls.set(property, call);
      return call;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    focusedIds: new Set(),
    activeRelationIds: new Set(),
    flowRelationIds: new Set(),
    reduceMotion: true,
    animate: false,
    visibilityMode: 'all',
    ...overrides,
  };
}

describe('golden C4 web projection contract', () => {
  it('exposes exact active node/edge memberships with coherent semantic and visual IDs', () => {
    const scene = createGoldenC4Scene();
    const projection = scene.projection!;
    const protocol = scene.protocolSnapshot as {
      objects: Array<{ id: string; pickable: boolean; representations: Array<{ id: string }> }>;
      paths: Array<{ id: string; fromObjectId: string; toObjectId: string; arrow: 'none' | 'end' | 'both' }>;
    };

    expect(scene.rootEntityId).toBe('system:okie');
    expect(scene.entities).toHaveLength(70);
    expect(scene.entities.every(entity => entity.confidence === undefined)).toBe(true);

    for (const band of bands) {
      const semanticEntityIds = projection.entityIdsByDetail[band.detail];
      const projectedRelationIds = projection.relationIdsByDetail[band.detail];
      expect(semanticEntityIds).toHaveLength(band.entities);
      expect(projectedRelationIds).toHaveLength(band.relations);
      expect(projection.projectedRelationsByDetail[band.detail]).toHaveLength(band.relations);

      const activeVisualIds = protocol.objects
        .filter(object => object.pickable && object.representations.some(representation => representation.id.endsWith(`:${band.detail}`)))
        .map(object => object.id)
        .sort();
      expect(activeVisualIds.map(id => projection.visualToSemanticEntityId[id]).sort())
        .toEqual([...semanticEntityIds].sort());
      for (const semanticId of semanticEntityIds) {
        const visualId = projection.semanticToVisualEntityId[semanticId];
        expect(projection.visualToSemanticEntityId[visualId]).toBe(semanticId);
      }

      const endpointIds = new Set(semanticEntityIds);
      for (const relation of projection.projectedRelationsByDetail[band.detail]) {
        expect(relation.arrow).toBe(protocol.paths.find(path => path.id === relation.id)?.arrow);
        expect(endpointIds.has(relation.from)).toBe(true);
        expect(endpointIds.has(relation.to)).toBe(true);
        expect(relation.from).not.toBe(relation.to);
      }
    }

    expect(protocol.paths).toHaveLength(43);
  });

  it('keeps each expandable owner geometrically identical and contains its incoming children', () => {
    const scene = createGoldenC4Scene();
    const transitions = [
      { current: 'context' as const, next: 'container' as const },
      { current: 'container' as const, next: 'component' as const },
      { current: 'component' as const, next: 'code' as const },
    ];
    for (const { current, next } of transitions) {
      const owners = scene.entities.filter(entity => entity.detail === current
        && scene.entities.some(child => child.parentId === entity.id && child.detail === next));
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) {
        const source = scene.projection!.boundsByEntityIdAndDetail[owner.id]![current]!;
        const target = scene.projection!.boundsByEntityIdAndDetail[owner.id]![next]!;
        expect(target).toEqual(source);
        const raw = { x: source.x + source.width / 2, y: source.y + source.height / 2, zoom: 3.5 };
        expect(compensateSemanticMorphCamera(raw, source, target, .5)).toEqual(raw);
        for (const child of scene.entities.filter(entity => entity.parentId === owner.id && entity.detail === next)) {
          const bounds = scene.projection!.boundsByEntityIdAndDetail[child.id]![next]!;
          expect(bounds.x).toBeGreaterThanOrEqual(target.x);
          expect(bounds.y).toBeGreaterThanOrEqual(target.y);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(target.x + target.width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(target.y + target.height);
        }
      }
    }
  });

  it('keeps the Canvas2D draw, pick and visible projection on the same exact band', () => {
    const scene = createGoldenC4Scene();
    const renderer = new Canvas2DRenderer(fakeCanvas(), 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setRenderState(renderState());

    for (const band of bands) {
      const firstId = scene.projection!.entityIdsByDetail[band.detail][0]!;
      const bounds = scene.projection!.boundsByEntityIdAndDetail[firstId]![band.detail]!;
      const camera: Camera = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        zoom: band.zoom,
      };
      renderer.setCamera(camera);
      const visible = renderer.visibleScene();
      expect(visible.objectIds).toHaveLength(band.entities);
      expect(visible.relationIds).toHaveLength(band.relations);
      expect(renderer.diagnostics()).toMatchObject({ entityCount: band.entities, relationCount: band.relations });
      expect(renderer.pick(600, 400)).toEqual({ kind: 'entity', id: firstId });
    }
  });

  it('keeps explicit base detail ownership independent of camera zoom and lens eligibility', () => {
    const scene = createGoldenC4Scene();
    const renderer = new Canvas2DRenderer(fakeCanvas(), 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera({ x: 1_080, y: 375, zoom: 14 });

    const failedCoverage: SemanticLensTarget = {
      id: 'system:okie',
      currentDetail: 'context',
      nextDetail: 'container',
      enterZoom: 1.16,
      coverage: { major: 0.9, minor: 0.17 },
      containmentPx: 40,
    };
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 14,
      direction: 'inward',
      target: failedCoverage,
    })).toEqual(idleSemanticLens());

    const contextBase = semanticBaseProjectionOverride(scene, 'context')!;
    renderer.setRenderState(renderState({ projectionOverride: contextBase }));
    const context = renderer.visibleScene();
    expect(context.objectIds).toHaveLength(4);
    expect(context.relationIds).toHaveLength(3);

    const reversingAtSource = semanticLensProjectionOverride(scene, {
      phase: 'reversing',
      targetId: 'system:okie',
      currentDetail: 'context',
      nextDetail: 'container',
      progress: 0,
      assistBlend: 0,
    })!;
    renderer.setRenderState(renderState({ projectionOverride: reversingAtSource }));
    expect(renderer.visibleScene()).toEqual(context);
    renderer.setRenderState(renderState({ projectionOverride: contextBase }));
    expect(renderer.visibleScene()).toEqual(context);

    renderer.setCamera({ x: 1_080, y: 375, zoom: 0.42 });
    renderer.setRenderState(renderState({
      projectionOverride: semanticBaseProjectionOverride(scene, 'component')!,
    }));
    expect(renderer.visibleScene()).toMatchObject({
      objectIds: expect.arrayContaining(scene.projection!.entityIdsByDetail.component),
      relationIds: expect.arrayContaining(scene.projection!.relationIdsByDetail.component),
    });
    expect(renderer.visibleScene().objectIds).toHaveLength(29);
    expect(renderer.visibleScene().relationIds).toHaveLength(23);
  });

  it('draws and picks ghost siblings while ancestor shells and ghost relations cannot steal hits', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const ghost = semanticLensSessionGhostEntities(scene, session).find(candidate => candidate.depth === 1)!;
    const override = semanticLensSessionProjectionOverride(scene, session)!;
    const ghostVisualId = scene.projection!.semanticToVisualEntityId[ghost.id];
    const ancestorVisualId = scene.projection!.semanticToVisualEntityId['system:okie'];
    expect(override.objects.find(object => object.objectId === ghostVisualId)).toMatchObject({
      targetRepresentationId: `${ghostVisualId}:${ghost.detail}`,
      targetOpacity: .24,
      targetContentOpacity: .24,
      targetPickable: true,
    });
    expect(override.objects.find(object => object.objectId === ancestorVisualId)).toMatchObject({
      targetOpacity: .32,
      targetContentOpacity: 0,
      targetPickable: false,
    });
    const ghostPaths = override.paths.filter(path => path.targetOpacity === .10);
    expect(ghostPaths.length).toBeGreaterThan(0);
    expect(ghostPaths.every(path => path.targetOpacity < .5)).toBe(true);

    const bounds = scene.projection!.boundsByEntityIdAndDetail[ghost.id]![ghost.detail]!;
    const renderer = new Canvas2DRenderer(fakeCanvas(), 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: 5.15 });
    renderer.setRenderState(renderState({ projectionOverride: override }));
    expect(renderer.visibleScene().objectIds).toContain(ghost.id);
    expect(renderer.pick(600, 400)).toEqual({ kind: 'entity', id: ghost.id });
  });

  it('keeps L4 primary and sibling titles while Canvas suppresses prior lineage content', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
        { targetId: 'component:model-normalized', currentDetail: 'component' as const, nextDetail: 'code' as const },
      ],
      active: idleSemanticLens(),
    };
    const override = semanticLensSessionProjectionOverride(scene, session)!;
    const ancestor = scene.entities.find(entity => entity.id === 'system:okie')!;
    const boundary = scene.entities.find(entity => entity.id === 'component:model-normalized')!;
    const primary = scene.entities.find(entity => entity.parentId === boundary.id && entity.detail === 'code')!;
    const sibling = semanticLensSessionGhostEntities(scene, session).find(ghost => ghost.opacity === .24)!;
    const lowerGhost = semanticLensSessionGhostEntities(scene, session).find(ghost => ghost.opacity < .24)!;
    const silhouette = semanticLensSessionSilhouetteEntities(scene, session)
      .find(candidate => candidate.parentGhostId === sibling.id)!;
    const siblingEntity = scene.entities.find(entity => entity.id === sibling.id)!;
    const textCalls: CanvasTextCall[] = [];
    const renderer = new Canvas2DRenderer(fakeCanvas(textCalls), 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setRenderState(renderState({ projectionOverride: override }));

    const titleCall = (entity: typeof ancestor, detail: SemanticDetail, zoom = 5.15) => {
      const bounds = scene.projection!.boundsByEntityIdAndDetail[entity.id]![detail]!;
      textCalls.length = 0;
      renderer.setCamera({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom });
      renderer.render(0);
      return [...textCalls].reverse().find(call => call.content === entity.name
        || (call.content.endsWith('…') && entity.name.startsWith(call.content.slice(0, -1))));
    };

    expect(titleCall(ancestor, 'context')?.alpha).toBe(0);
    const siblingTitle = titleCall(siblingEntity, sibling.detail, 14);
    const activeSiblingMetrics = canvasEntityPresentationMetrics('code', true, 14);
    const priorSiblingMetrics = canvasEntityPresentationMetrics(sibling.detail, true, 14);
    expect(siblingTitle?.alpha).toBe(.24);
    expect(siblingTitle?.font).not.toContain(`${activeSiblingMetrics.titleFontSize}px`);
    expect(siblingTitle?.font).toContain(`${priorSiblingMetrics.titleFontSize}px`);
    expect(titleCall(boundary, 'code')?.alpha).toBe(1);
    expect(titleCall(primary, 'code')?.alpha).toBe(1);
    expect(override.objects.find(object => object.objectId === scene.projection!.semanticToVisualEntityId[lowerGhost.id])).toMatchObject({
      targetContentOpacity: 0,
      targetPickable: false,
    });
    expect(override.objects.find(object => object.objectId === scene.projection!.semanticToVisualEntityId[silhouette.id])).toMatchObject({
      targetOpacity: .14,
      targetContentOpacity: 0,
      targetPickable: false,
    });
    expect(renderer.visibleScene().objectIds).toContain(silhouette.id);
  });

  it('promotes an explicitly selected L4 silhouette before framing so its center picks the code entity', () => {
    const scene = createGoldenC4Scene();
    const selectedId = 'code:model-schema:snapshot';
    const original = semanticLevelSession(scene, 'code', ['component:model-normalized']);
    const promoted = semanticSourceSession(scene, original, selectedId);
    const originalOverride = semanticLensSessionProjectionOverride(scene, original)!;
    const promotedOverride = semanticLensSessionProjectionOverride(scene, promoted)!;
    const selectedVisualId = scene.projection!.semanticToVisualEntityId[selectedId];

    expect(originalOverride.objects.find(object => object.objectId === selectedVisualId)).toMatchObject({
      targetOpacity: .14,
      targetPickable: false,
    });
    expect(promotedOverride.objects.find(object => object.objectId === selectedVisualId)).toMatchObject({
      targetOpacity: 1,
      targetContentOpacity: 1,
      targetPickable: true,
    });

    const bounds = scene.projection!.boundsByEntityIdAndDetail[selectedId]!.code!;
    const renderer = new Canvas2DRenderer(fakeCanvas(), 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(691, 652, 1);
    renderer.setCamera({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: 14 });
    renderer.setRenderState(renderState({ selectedId, projectionOverride: promotedOverride }));
    expect(renderer.pick(691 / 2, 652 / 2)).toEqual({ kind: 'entity', id: selectedId });
  });

  it('builds a bounded stable-ID drill patch and contains only golden Okie story copy', () => {
    const outer = createGoldenC4Scene();
    const inner = createGoldenC4Scene('container:architecture-model', outer);
    const patch = inner.protocolPatch as {
      baseRevision: number;
      revision: number;
      upsertObjects: Array<{ id: string }>;
      removeObjectIds: string[];
      transition?: { durationMs: number };
    };

    expect(inner.rootEntityId).toBe('container:architecture-model');
    expect(patch.baseRevision).toBe(1);
    expect(patch.revision).toBe(2);
    expect(patch.transition).toBeUndefined();
    expect(patch.upsertObjects.length + patch.removeObjectIds.length).toBeLessThan(outer.entities.length * 2);
    expect(inner.projection!.semanticToVisualEntityId['container:architecture-model'])
      .toBe(outer.projection!.semanticToVisualEntityId['container:architecture-model']);

    const storyCopy = JSON.stringify(goldenAppStory);
    expect(storyCopy).toContain('Okie');
    expect(storyCopy).toContain('selectScopedView');
    expect(storyCopy).not.toMatch(/Acme|commerce|checkout|order|payment|fulfilment/iu);
  });

  it.each(bands)('$detail has one stable semantic bounds entry per active entity', ({ detail }) => {
    const scene = createGoldenC4Scene();
    const ids = scene.projection!.entityIdsByDetail[detail as SemanticDetail];
    for (const id of ids) expect(scene.projection!.boundsByEntityIdAndDetail[id]?.[detail]).toBeDefined();
  });
});
