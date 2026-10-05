import { describe, expect, it, vi } from 'vitest';
import { Canvas2DRenderer, arrowHeadForPolyline, pointAlongPolyline } from './Canvas2DRenderer';
import { createGoldenC4Scene } from './goldenC4Scene';
import { roundedOrthogonalRoute, routeArrowHeads, routeShaft } from './routeGeometry';
import type { Camera, RenderState, SceneRelation, SemanticDetail } from './types';
import {
  idleSemanticLens,
  semanticBaseProjectionOverride,
  semanticLensProjectionOverride,
  semanticLensSessionProjectionOverride,
  semanticLensSessionSilhouetteEntities,
  semanticLensSessionVisibleRelationIds,
} from '../semantic/semanticLens';
import { selectedRelationFocusPresentation } from '../relations/relationFocus';

function fakeCanvas() {
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const values: Record<PropertyKey, unknown> = {};
  const fillAlphas: number[] = [];
  const strokeAlphas: number[] = [];
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? (property === 'fill'
        ? vi.fn(() => fillAlphas.push(Number(target.globalAlpha ?? 1)))
        : property === 'stroke'
          ? vi.fn(() => strokeAlphas.push(Number(target.globalAlpha ?? 1)))
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
    canvas: { width: 0, height: 0, style: {}, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
    call: (name: PropertyKey) => calls.get(name) ?? vi.fn(),
    fillAlphas,
    strokeAlphas,
  };
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    focusedIds: new Set(),
    activeRelationIds: new Set(),
    flowRelationIds: new Set(),
    reduceMotion: false,
    animate: false,
    visibilityMode: 'all',
    ...overrides,
  };
}

function routeMidpoint(relation: SceneRelation) {
  const points = relation.routePoints!;
  const segments = points.slice(1).map((end, index) => ({
    start: points[index]!,
    end,
    length: Math.hypot(end.x - points[index]!.x, end.y - points[index]!.y),
  }));
  const segment = segments.sort((left, right) => right.length - left.length)[0]!;
  return { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 };
}

function screenPoint(point: { x: number; y: number }, camera: Camera, width: number, height: number) {
  return {
    x: width / 2 + (point.x - camera.x) * camera.zoom,
    y: height / 2 + (point.y - camera.y) * camera.zoom,
  };
}

describe('Canvas2D compiled route parity', () => {
  it('deep-copies every exact protocol polyline onto its active semantic-band relation', () => {
    const scene = createGoldenC4Scene();
    const protocol = scene.protocolSnapshot as { paths: Array<{ id: string; points: Array<{ x: number; y: number }> }> };
    const protocolById = new Map(protocol.paths.map(path => [path.id, path]));

    for (const detail of ['context', 'container', 'component', 'code'] as const) {
      for (const relation of scene.projection!.projectedRelationsByDetail[detail]) {
        const protocolPath = protocolById.get(relation.id)!;
        expect(relation.routePoints).toEqual(protocolPath.points);
        expect(relation.routePoints).not.toBe(protocolPath.points);
        expect(relation.routePoints?.every((point, index) => point !== protocolPath.points[index])).toBe(true);
      }
    }
  });

  it('rounds compiled orthogonal corners in screen space and stops the shaft at the target arrow base', () => {
    const scene = createGoldenC4Scene();
    const detail: SemanticDetail = 'component';
    const relation = scene.projection!.projectedRelationsByDetail[detail]
      .find(candidate => candidate.routePoints && candidate.routePoints.length >= 3)!;
    const midpoint = routeMidpoint(relation);
    const camera = { ...midpoint, zoom: 5.15 };
    const width = 1_200;
    const height = 800;
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(width, height, 1);
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({ projectionOverride: semanticBaseProjectionOverride(scene, detail) }));
    renderer.render(0);

    const canonical = relation.routePoints!.map(point => screenPoint(point, camera, width, height));
    const rounded = roundedOrthogonalRoute(canonical);
    const arrows = routeArrowHeads(rounded);
    const shaft = routeShaft(rounded, arrows.source, arrows.target);
    expect(target.call('moveTo').mock.calls).toContainEqual([shaft[0]!.x, shaft[0]!.y]);
    for (const point of shaft.slice(1)) expect(target.call('lineTo').mock.calls).toContainEqual([point.x, point.y]);
    expect(arrows.target?.tip).toEqual(canonical.at(-1));
    expect(shaft.at(-1)).toEqual(arrows.target?.base);
    expect(rounded.length).toBeGreaterThan(canonical.length);
    expect(target.call('bezierCurveTo')).not.toHaveBeenCalled();
    expect(target.fillAlphas).toContain(.14);
    expect(target.fillAlphas).toContain(1);

    const arrow = arrowHeadForPolyline([{ x: 2, y: 2 }, { x: 2, y: 12 }], 8)!;
    expect(arrow.tip).toEqual({ x: 2, y: 12 });
    expect(arrow.left.y).toBeLessThan(arrow.tip.y);
    expect(arrow.right.y).toBeLessThan(arrow.tip.y);
    expect(arrow.left.x).toBeLessThan(arrow.tip.x);
    expect(arrow.right.x).toBeGreaterThan(arrow.tip.x);

    const short = arrowHeadForPolyline([{ x: 0, y: 0 }, { x: 16, y: 0 }], 40)!;
    expect((short.left.x + short.right.x) / 2).toBeGreaterThanOrEqual(8);
    expect(short.tip).toEqual({ x: 16, y: 0 });
  });

  it('keeps canonical route geometry clipped to the interpolated owner during a projection morph', () => {
    const scene = createGoldenC4Scene();
    const override = semanticLensProjectionOverride(scene, {
      phase: 'revealing',
      targetId: 'container:architecture-model',
      currentDetail: 'container',
      nextDetail: 'component',
      progress: .5,
      assistBlend: 0,
    })!;
    const relation = Object.values(scene.projection!.projectedRelationsByDetail).flat()
      .find(candidate => override.morph!.pathIds.includes(candidate.id))!;
    const owner = scene.projection!.boundsByEntityIdAndDetail['container:architecture-model']!;
    const source = owner.container!;
    const targetBounds = owner.component!;
    const current = {
      x: (source.x + targetBounds.x) / 2,
      y: (source.y + targetBounds.y) / 2,
      width: (source.width + targetBounds.width) / 2,
      height: (source.height + targetBounds.height) / 2,
    };
    const camera = { x: current.x + current.width / 2, y: current.y + current.height / 2, zoom: 5.15 };
    const canvas = fakeCanvas();
    const renderer = new Canvas2DRenderer(canvas.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({ projectionOverride: override }));
    renderer.render(0);

    const clipOrigin = screenPoint(current, camera, 1_200, 800);
    expect(canvas.call('rect').mock.calls).toContainEqual([
      clipOrigin.x,
      clipOrigin.y,
      current.width * camera.zoom,
      current.height * camera.zoom,
    ]);
    expect(relation.routePoints?.length).toBeGreaterThanOrEqual(2);
  });

  it('uses the compiled polyline for relation picking and length-weighted flow', () => {
    const scene = createGoldenC4Scene();
    const detail: SemanticDetail = 'context';
    const relation = scene.projection!.projectedRelationsByDetail[detail][0]!;
    const midpoint = routeMidpoint(relation);
    const renderer = new Canvas2DRenderer(fakeCanvas().canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera({ ...midpoint, zoom: .62 });
    renderer.setRenderState(renderState({ projectionOverride: semanticBaseProjectionOverride(scene, detail) }));

    expect(renderer.pick(600, 400)).toEqual({ kind: 'relation', id: relation.semanticIds![0] });
    expect(pointAlongPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }], .5))
      .toEqual({ x: 10, y: 10 });
  });

  it('lets a visible deep-band route win over its enclosing owner shell', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:web-app', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const override = semanticLensSessionProjectionOverride(scene, session)!;
    const relation = scene.projection!.projectedRelationsByDetail.component
      .find(candidate => candidate.semanticIds?.includes('relation:web-shell-renderer-host'))!;
    const midpoint = routeMidpoint(relation);
    const owner = scene.projection!.boundsByEntityIdAndDetail['container:web-app']!.component!;
    expect(midpoint.x).toBeGreaterThan(owner.x);
    expect(midpoint.x).toBeLessThan(owner.x + owner.width);
    expect(midpoint.y).toBeGreaterThan(owner.y);
    expect(midpoint.y).toBeLessThan(owner.y + owner.height);

    const renderer = new Canvas2DRenderer(fakeCanvas().canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    const camera = { ...midpoint, zoom: 5.15 };
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({ projectionOverride: override }));

    expect(renderer.pick(600, 400)).toEqual({
      kind: 'relation',
      id: 'relation:web-shell-renderer-host',
    });
    const source = scene.projection!.boundsByEntityIdAndDetail['component:web-shell']!.component!;
    const sourceCenter = screenPoint({
      x: source.x + source.width / 2,
      y: source.y + source.height / 2,
    }, camera, 1_200, 800);
    expect(renderer.pick(sourceCenter.x, sourceCenter.y)).toEqual({
      kind: 'entity',
      id: 'component:web-shell',
    });
  });

  it('leaves a readable shaft on the short L4 guided-story relation', () => {
    const scene = createGoldenC4Scene();
    const semanticRelationId = 'relation:code-select-scoped-snapshot';
    const relation = scene.projection!.projectedRelationsByDetail.code
      .find(candidate => candidate.semanticIds?.includes(semanticRelationId))!;
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
        { targetId: 'component:model-scoping', currentDetail: 'component' as const, nextDetail: 'code' as const },
      ],
      active: idleSemanticLens(),
    };
    const override = semanticLensSessionProjectionOverride(scene, session)!;
    expect(override.paths.find(path => path.pathId === relation.id)?.targetOpacity).toBe(1);

    const endpoint = relation.routePoints!.at(-1)!;
    const camera = { ...endpoint, zoom: 14 };
    const screenRoute = relation.routePoints!.map(point => screenPoint(point, camera, 1_200, 800));
    const terminalLength = Math.hypot(
      screenRoute.at(-1)!.x - screenRoute.at(-2)!.x,
      screenRoute.at(-1)!.y - screenRoute.at(-2)!.y,
    );
    const arrow = arrowHeadForPolyline(screenRoute)!;
    const baseMidpoint = {
      x: (arrow.left.x + arrow.right.x) / 2,
      y: (arrow.left.y + arrow.right.y) / 2,
    };
    const consumedShaft = Math.hypot(arrow.tip.x - baseMidpoint.x, arrow.tip.y - baseMidpoint.y);
    expect(consumedShaft).toBeLessThanOrEqual(terminalLength * 0.5);
    expect(terminalLength - consumedShaft).toBeGreaterThan(0);

    const renderer = new Canvas2DRenderer(fakeCanvas().canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({
      activeRelationIds: new Set([semanticRelationId]),
      projectionOverride: override,
    }));
    expect(renderer.visibleScene().relationIds).toContain(relation.id);
  });

  it('keeps faint ghost routes visible but non-pickable and without flow particles', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const override = semanticLensSessionProjectionOverride(scene, session)!;
    const ghostPath = override.paths.find(path => path.targetOpacity === .10)!;
    const relation = Object.values(scene.projection!.projectedRelationsByDetail).flat()
      .find(candidate => candidate.id === ghostPath.pathId)!;
    const midpoint = routeMidpoint(relation);
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera({ ...midpoint, zoom: 5.15 });
    renderer.setRenderState(renderState({
      activeRelationIds: new Set(relation.semanticIds),
      flowRelationIds: new Set(relation.semanticIds),
      animate: true,
      projectionOverride: override,
    }));
    renderer.render(900);

    const first = screenPoint(relation.routePoints![0]!, { ...midpoint, zoom: 5.15 }, 1_200, 800);
    expect(target.call('moveTo').mock.calls).toContainEqual([first.x, first.y]);
    expect(target.strokeAlphas).toContain(.10);
    expect(renderer.pick(600, 400)).toBeUndefined();
    expect(target.call('arc')).not.toHaveBeenCalled();

    const silhouetteIds = new Set(semanticLensSessionSilhouetteEntities(scene, session).map(entity => entity.id));
    const visiblePathIds = new Set(semanticLensSessionVisibleRelationIds(scene, session));
    const visibleRelations = Object.values(scene.projection!.projectedRelationsByDetail).flat()
      .filter(candidate => visiblePathIds.has(candidate.id));
    expect(visibleRelations.every(candidate => !silhouetteIds.has(candidate.from) && !silhouetteIds.has(candidate.to))).toBe(true);
  });

  it('promotes a selected ghost path and both endpoints as one isolated presentation focus', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const lensOverride = semanticLensSessionProjectionOverride(scene, session)!;
    const ghostPath = lensOverride.paths.find(path => path.targetOpacity === .10)!;
    const projectedRelation = Object.values(scene.projection!.projectedRelationsByDetail).flat()
      .find(candidate => candidate.id === ghostPath.pathId)!;
    const semanticRelationId = projectedRelation.semanticIds?.[0] ?? projectedRelation.id;
    const focus = selectedRelationFocusPresentation(scene, semanticRelationId, lensOverride);
    const relation = scene.relations.find(candidate => candidate.id === semanticRelationId)!;
    const midpoint = routeMidpoint(projectedRelation);
    const renderer = new Canvas2DRenderer(fakeCanvas().canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1_200, 800, 1);
    renderer.setCamera({ ...midpoint, zoom: 5.15 });
    renderer.setRenderState(renderState({
      activeRelationIds: focus.relationIds,
      relationFocusIds: focus.endpointIds,
      visibilityMode: 'isolate',
      projectionOverride: focus.projectionOverride,
    }));
    renderer.render(0);

    expect(renderer.visibleScene().objectIds.sort()).toEqual([relation.from, relation.to].sort());
    expect(renderer.visibleScene().relationIds).toContain(ghostPath.pathId);
    expect(renderer.pick(600, 400)).toEqual({ kind: 'relation', id: semanticRelationId });
  });

  it('draws a fixed-size screen-space particle only for the selected flow relationship', () => {
    const scene = createGoldenC4Scene();
    const detail: SemanticDetail = 'component';
    const relation = scene.projection!.projectedRelationsByDetail[detail]
      .find(candidate => candidate.routePoints && candidate.semanticIds?.length)!;
    const semanticRelationId = relation.semanticIds![0]!;
    const midpoint = routeMidpoint(relation);
    const override = semanticBaseProjectionOverride(scene, detail);

    const emphasisOnly = fakeCanvas();
    const emphasisOnlyRenderer = new Canvas2DRenderer(emphasisOnly.canvas, 'canvas2d');
    emphasisOnlyRenderer.setScene(scene);
    emphasisOnlyRenderer.resize(1_200, 800, 1);
    emphasisOnlyRenderer.setCamera({ ...midpoint, zoom: 2 });
    emphasisOnlyRenderer.setRenderState(renderState({
      activeRelationIds: new Set([semanticRelationId]),
      animate: true,
      projectionOverride: override,
    }));
    emphasisOnlyRenderer.render(900);
    expect(emphasisOnly.call('arc')).not.toHaveBeenCalled();

    for (const zoom of [2, 8]) {
      const flowing = fakeCanvas();
      const renderer = new Canvas2DRenderer(flowing.canvas, 'canvas2d');
      renderer.setScene(scene);
      renderer.resize(1_200, 800, 1);
      renderer.setCamera({ ...midpoint, zoom });
      renderer.setRenderState(renderState({
        activeRelationIds: new Set([semanticRelationId]),
        flowRelationIds: new Set([semanticRelationId]),
        animate: true,
        projectionOverride: override,
      }));
      renderer.render(900);
      expect(flowing.call('arc')).toHaveBeenCalled();
      expect(flowing.call('arc').mock.calls.at(-1)?.[2]).toBe(3.5);
    }
  });
});
