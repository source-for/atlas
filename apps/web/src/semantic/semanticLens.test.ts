import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_LENS_POLICY,
  compensateSemanticMorphCamera,
  composeSemanticZoomCamera,
  containSemanticOwnerCamera,
  advanceSemanticLensFocusTransfer,
  findSemanticGhostFocusTarget,
  findSemanticLensTarget,
  idleSemanticLens,
  idleSemanticLensSession,
  interpolateSemanticOwnerBounds,
  measureSemanticLensTarget,
  rebaseSemanticMorphCamera,
  reduceSemanticLens,
  reduceSemanticLensSession,
  semanticBaseProjectionOverride,
  semanticBackgroundVisibility,
  semanticLensBranchEntityIds,
  semanticLensCoverageProgress,
  semanticLensCanonicalPathIds,
  semanticLensProjectionOverride,
  semanticLensSessionProjectionOverride,
  semanticLensSessionGhostEntities,
  semanticLensSessionSilhouetteEntities,
  semanticLensSessionVisibleEntityIds,
  semanticLensSessionVisibleRelationIds,
  semanticLensStrictDescendantIds,
  semanticLensUrl,
  semanticLensZoomProgress,
  semanticLensTargetZoomDiagnostics,
  settleSemanticLensPanFocus,
  stabilizeSemanticLensSessionForPan,
  settledSemanticLensId,
  transferSemanticLensFocus,
  validateRestoredSemanticLensPath,
  type SemanticLensTarget,
} from './semanticLens';
import { createGoldenC4Scene, semanticBounds } from '../renderer/goldenC4Scene';
import type { AtlasScene } from '../renderer/types';

const target = (major: number, minor: number, id = 'system:okie'): SemanticLensTarget => ({
  id,
  currentDetail: 'context',
  nextDetail: 'container',
  enterZoom: 0.60,
  coverage: { major, minor },
  containmentPx: 40,
});

describe('semantic projection ownership', () => {
  it('fades background context continuously before the focus touches it', () => {
    const background = { x: 100, y: 0, width: 100, height: 100 };
    const focus = { x: 0, y: 0, width: 80, height: 100 };
    expect(semanticBackgroundVisibility(background, focus)).toBe(1);
    expect(semanticBackgroundVisibility(background, { ...focus, width: 96 })).toBeCloseTo(.5);
    expect(semanticBackgroundVisibility(background, { ...focus, width: 100 })).toBe(0);
    expect(semanticBackgroundVisibility(background, { ...focus, width: 200 })).toBe(0);
    const widths = [80, 92, 94, 96, 98, 100, 104];
    const inward = widths.map(width => semanticBackgroundVisibility(background, { ...focus, width }));
    expect(inward).toEqual([...inward].sort((a, b) => b - a));
    expect([...widths].reverse().map(width => semanticBackgroundVisibility(background, { ...focus, width })))
      .toEqual([...inward].reverse());
  });

  it('restores only URL lens entries coherent with the authored camera runway', () => {
    const scene = createGoldenC4Scene();
    const l1Path = ['system:okie'];
    const l1Transition = scene.projection!.semanticTransitionsByEntityId!['system:okie']!.container!;

    // The captured cold URL was a context path at z=.8037 with a stale L2
    // settled lens. Structural validity alone accepts it; restore must not.
    expect(validateRestoredSemanticLensPath(scene, 'context', l1Path, .8037)).toEqual({
      entries: [],
      truncated: true,
    });
    // Retain the hysteresis runway so a saved outward endpoint just below the
    // authored entry does not flicker to the wrong base representation.
    expect(validateRestoredSemanticLensPath(
      scene,
      'context',
      l1Path,
      l1Transition.minZoom - l1Transition.hysteresis + 1e-10,
    ).entries).toHaveLength(1);

    const coldL4Path = ['system:okie', 'container:architecture-model', 'component:model-normalized'];
    const l4Transition = scene.projection!.semanticTransitionsByEntityId!['component:model-normalized']!.code!;
    const coldL4Scene: AtlasScene = {
      ...scene,
      projection: {
        ...scene.projection!,
        semanticTransitionsByEntityId: {
          ...scene.projection!.semanticTransitionsByEntityId!,
          'component:model-normalized': {
            ...scene.projection!.semanticTransitionsByEntityId!['component:model-normalized'],
            // A cold scan bridge may have a longer complete runway than the
            // native representation's ordinary LOD transition.
            code: { ...l4Transition, fullZoom: 12.54 },
          },
        },
      },
    };
    expect(10).toBeGreaterThan(l4Transition.minZoom);
    expect(10).toBeLessThan(coldL4Scene.projection!.semanticTransitionsByEntityId!['component:model-normalized']!.code!.fullZoom);
    // A saved L4 endpoint need only meet its entry/leave runway, never fullZoom.
    expect(validateRestoredSemanticLensPath(coldL4Scene, 'context', coldL4Path, 10).entries)
      .toEqual([
        { targetId: 'system:okie', currentDetail: 'context', nextDetail: 'container' },
        { targetId: 'container:architecture-model', currentDetail: 'container', nextDetail: 'component' },
        { targetId: 'component:model-normalized', currentDetail: 'component', nextDetail: 'code' },
      ]);

    const rootVisualId = scene.projection!.semanticToVisualEntityId['system:okie'];
    const protocol = scene.protocolSnapshot as { objects: Array<{ id: string; representations: Array<{ id: string; lod?: { minZoom: number; hysteresis: number } }> }> };
    const lodFallbackScene: AtlasScene = {
      ...scene,
      projection: {
        ...scene.projection!,
        semanticTransitionsByEntityId: {
          ...scene.projection!.semanticTransitionsByEntityId!,
          'system:okie': { ...scene.projection!.semanticTransitionsByEntityId!['system:okie'], container: undefined },
        },
      },
      protocolSnapshot: {
        ...protocol,
        objects: protocol.objects.map(object => object.id !== rootVisualId ? object : {
          ...object,
          representations: object.representations.map(representation => representation.id !== `${rootVisualId}:container`
            ? representation
            : { ...representation, lod: { minZoom: .84, hysteresis: .05 } }),
        }),
      },
    };
    // Imported/sparse scenes retain their protocol LOD policy ahead of the
    // generic C4 fallback. This is the actual target-measurement precedence.
    expect(validateRestoredSemanticLensPath(lodFallbackScene, 'context', l1Path, .80).entries).toHaveLength(1);
    expect(validateRestoredSemanticLensPath(lodFallbackScene, 'context', l1Path, .789).entries).toHaveLength(0);
  });

  it('contains an owner with the exact minimal translation on every safe edge', () => {
    const viewport = { width: 1_000, height: 800 };
    const safeArea = { left: 100, right: 150, top: 50, bottom: 100 };
    const owner = { x: 0, y: 0, width: 10, height: 10 };
    const cameraForRect = (left: number, top: number) => ({
      x: (viewport.width / 2 - left) / 10,
      y: (viewport.height / 2 - top) / 10,
      zoom: 10,
    });

    const contained = cameraForRect(200, 200);
    expect(containSemanticOwnerCamera(contained, owner, viewport, safeArea, 20)).toBe(contained);
    expect(containSemanticOwnerCamera(cameraForRect(110, 200), owner, viewport, safeArea, 20))
      .toEqual({ x: 38, y: 20, zoom: 10 });
    expect(containSemanticOwnerCamera(cameraForRect(745, 200), owner, viewport, safeArea, 20))
      .toEqual({ x: -23, y: 20, zoom: 10 });
    expect(containSemanticOwnerCamera(cameraForRect(200, 60), owner, viewport, safeArea, 20))
      .toEqual({ x: 30, y: 33, zoom: 10 });
    expect(containSemanticOwnerCamera(cameraForRect(200, 590), owner, viewport, safeArea, 20))
      .toEqual({ x: 30, y: -18, zoom: 10 });
  });

  it('keeps the grown L4 host and its Wasm card above bottom controls at z14', () => {
    const scene = createGoldenC4Scene();
    const viewport = { width: 1_280, height: 720 };
    const safeArea = { left: 0, right: 0, top: 0, bottom: 113 };
    const owner = semanticBounds(scene, 'component:web-renderer-host', 'code')!;
    const wasmCard = semanticBounds(scene, 'code:web-renderer-host:wasm-adapter', 'code')!;
    const collisionBottom = 647.424;
    const collisionTop = collisionBottom - owner.height * 14;
    const camera = {
      x: owner.x + owner.width / 2,
      y: owner.y - (collisionTop - viewport.height / 2) / 14,
      zoom: 14,
    };
    const corrected = containSemanticOwnerCamera(camera, owner, viewport, safeArea);
    const screenBottom = (bounds: typeof owner) => viewport.height / 2
      + (bounds.y + bounds.height - corrected.y) * corrected.zoom;

    expect(corrected.zoom).toBe(14);
    expect(corrected.x).toBe(camera.x);
    expect(screenBottom(owner)).toBeCloseTo(583);
    expect(screenBottom(owner)).toBeLessThan(607);
    expect(screenBottom(wasmCard)).toBeLessThan(607);
  });

  it('interpolates morph owner bounds symmetrically without mutating endpoints', () => {
    const source = { x: 10, y: 20, width: 30, height: 40 };
    const targetBounds = { x: 50, y: 80, width: 90, height: 100 };
    const sourceBefore = { ...source };
    const targetBefore = { ...targetBounds };
    expect(interpolateSemanticOwnerBounds(source, targetBounds, .25))
      .toEqual(interpolateSemanticOwnerBounds(targetBounds, source, .75));
    expect(source).toEqual(sourceBefore);
    expect(targetBounds).toEqual(targetBefore);
  });

  it('compensates morph-center movement without changing raw zoom or screen position', () => {
    const source = { x: 820, y: 120, width: 480, height: 250 };
    const targetBounds = { x: 820, y: 120, width: 1444, height: 538 };
    const raw = { x: 1080, y: 375, zoom: .66 };
    expect(compensateSemanticMorphCamera(raw, source, targetBounds, .5)).toEqual({ x: 1321, y: 447, zoom: .66 });
    expect(compensateSemanticMorphCamera(raw, source, targetBounds, 1)).toEqual({ x: 1562, y: 519, zoom: .66 });

    const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
    const targetCenter = { x: targetBounds.x + targetBounds.width / 2, y: targetBounds.y + targetBounds.height / 2 };
    const screenCenter = (progress: number) => {
      const camera = compensateSemanticMorphCamera(raw, source, targetBounds, progress);
      return {
        x: (sourceCenter.x + progress * (targetCenter.x - sourceCenter.x) - camera.x) * camera.zoom,
        y: (sourceCenter.y + progress * (targetCenter.y - sourceCenter.y) - camera.y) * camera.zoom,
      };
    };
    expect(screenCenter(.5).x).toBeCloseTo(screenCenter(0).x);
    expect(screenCenter(.5).y).toBeCloseTo(screenCenter(0).y);
    expect(screenCenter(1).x).toBeCloseTo(screenCenter(0).x);
    expect(screenCenter(1).y).toBeCloseTo(screenCenter(0).y);
  });

  it('rebases a settled deep morph exactly once before reversing to its prior layer', () => {
    const previousSource = { x: 0, y: 0, width: 2, height: 2 };
    const previousTarget = { x: 652, y: 447, width: 2, height: 2 };
    const deepSource = { x: 0, y: 0, width: 2, height: 2 };
    const deepTarget = { x: 950, y: 791, width: 2, height: 2 };
    const previousCamera = { x: 2117.659124, y: 888.54384, zoom: 1.127691 };
    const deepCamera = compensateSemanticMorphCamera(previousCamera, deepSource, deepTarget, 1);

    expect(deepCamera).toEqual({ x: 3067.659124, y: 1679.54384, zoom: 1.127691 });
    const rebased = rebaseSemanticMorphCamera(deepCamera, deepSource, deepTarget, 1);
    expect(rebased).toEqual(previousCamera);
    expect(compensateSemanticMorphCamera(deepCamera, deepSource, deepTarget, 0, 1)).toEqual(previousCamera);
    expect(compensateSemanticMorphCamera(rebased, previousSource, previousTarget, 1)).toEqual({
      x: 2769.659124,
      y: 1335.54384,
      zoom: 1.127691,
    });
    expect(rebaseSemanticMorphCamera(
      compensateSemanticMorphCamera(previousCamera, deepSource, deepTarget, .5),
      deepSource,
      deepTarget,
      .5,
    )).toEqual(previousCamera);
  });

  it('owns every retained slot in the base band so high zoom cannot leak another detail', () => {
    const scene = createGoldenC4Scene();
    const protocol = scene.protocolSnapshot as { objects: Array<{ id: string }>; paths: Array<{ id: string }> };
    const override = semanticBaseProjectionOverride(scene, 'context');
    expect(override).toBeDefined();
    expect(override!.objects).toHaveLength(protocol.objects.length);
    expect(override!.paths).toHaveLength(protocol.paths.length);
    expect(override!.objects.every(object => object.sourceRepresentationId === undefined
      || object.sourceRepresentationId.endsWith(':context'))).toBe(true);
    expect(override!.objects.every(object => object.sourceRepresentationId === object.targetRepresentationId)).toBe(true);
    expect(override!.objects.every(object => object.sourceContentOpacity === undefined
      && object.targetContentOpacity === undefined)).toBe(true);
    expect(override!.paths.every(path => path.sourceOpacity === path.targetOpacity)).toBe(true);
  });

  it('morphs only internal branch geometry while portal routes crossfade outside the affine group', () => {
    const scene = createGoldenC4Scene();
    const candidate = scene.entities
      .filter(entity => entity.detail === 'container')
      .map(entity => {
        const branch = new Set(semanticLensBranchEntityIds(scene, entity.id, 'component'));
        const relations = scene.projection!.projectedRelationsByDetail.component;
        return {
          entity,
          internal: relations.filter(relation => branch.has(relation.from) && branch.has(relation.to)),
        };
      })
      .find(entry => entry.internal.length > 0)!;
    expect(candidate).toBeDefined();
    const branchIds = new Set(semanticLensBranchEntityIds(scene, candidate.entity.id, 'component'));
    const external = scene.entities.find(entity => !branchIds.has(entity.id))!;
    const internalSeed = candidate.internal[0]!;
    const portal = { ...internalSeed, id: 'qa:portal', from: internalSeed.from, to: external.id };
    const rawProtocol = scene.protocolSnapshot as { objects: Array<{ id: string; representations: Array<{ id: string }> }>; paths: Array<Record<string, unknown> & { id: string }> };
    const pathSeed = rawProtocol.paths[0]!;
    const sceneWithPortal = {
      ...scene,
      projection: {
        ...scene.projection!,
        projectedRelationsByDetail: {
          ...scene.projection!.projectedRelationsByDetail,
          component: [...scene.projection!.projectedRelationsByDetail.component, portal],
        },
      },
      protocolSnapshot: { ...rawProtocol, paths: [...rawProtocol.paths, { ...pathSeed, id: portal.id }] },
    };
    const state = {
      phase: 'revealing' as const,
      targetId: candidate.entity.id,
      currentDetail: 'container' as const,
      nextDetail: 'component' as const,
      progress: .5,
      assistBlend: .34,
    };
    const protocol = sceneWithPortal.protocolSnapshot as { objects: Array<{ id: string }>; paths: Array<{ id: string }> };
    const override = semanticLensProjectionOverride(sceneWithPortal, state)!;
    expect(override.objects).toHaveLength(protocol.objects.length);
    expect(override.paths).toHaveLength(protocol.paths.length);
    const branch = new Set(semanticLensBranchEntityIds(sceneWithPortal, state.targetId, state.nextDetail));
    const targetRelations = sceneWithPortal.projection!.projectedRelationsByDetail.component;
    const internal = targetRelations.filter(relation => branch.has(relation.from) && branch.has(relation.to));
    const portals = targetRelations.filter(relation => branch.has(relation.from) !== branch.has(relation.to));
    expect(internal.length).toBeGreaterThan(0);
    expect(portals.length).toBeGreaterThan(0);
    for (const relation of internal) {
      expect(override.morph!.pathIds).toContain(relation.id);
      const labelId = `relation-label:${relation.id}`;
      if (protocol.objects.some(object => object.id === labelId)) expect(override.morph!.objectIds).toContain(labelId);
    }
    for (const relation of portals) {
      expect(override.morph!.pathIds).not.toContain(relation.id);
      expect(override.morph!.objectIds).not.toContain(`relation-label:${relation.id}`);
      expect(override.paths.find(path => path.pathId === relation.id)).toMatchObject({ targetOpacity: 0 });
    }
    const reversed = semanticLensProjectionOverride(sceneWithPortal, { ...state, phase: 'reversing', progress: .25 })!;
    expect(reversed.id).toBe(override.id);
    expect(reversed.morph).toEqual(override.morph);
    expect(reversed.objects).toEqual(override.objects);
    expect(reversed.paths).toEqual(override.paths);
  });

  it('stacks context-to-code branches and pops exactly one deepest entry outward', () => {
    const settle = (session: ReturnType<typeof idleSemanticLensSession>, nextTarget: SemanticLensTarget, now: number) => {
      const armed = reduceSemanticLensSession(session, { nowMs: now, zoom: nextTarget.enterZoom, direction: 'inward', target: nextTarget });
      return reduceSemanticLensSession(armed, {
        nowMs: now + 100,
        zoom: nextTarget.enterZoom * 1.14,
        direction: 'inward',
        target: { ...nextTarget, coverage: { major: .82, minor: .42 } },
        reducedMotion: true,
        gestureSettled: true,
      });
    };
    let session = idleSemanticLensSession('context');
    session = settle(session, target(.62, .28, 'system:okie'), 0);
    session = settle(session, { ...target(.62, .28, 'container:web'), currentDetail: 'container', nextDetail: 'component', enterZoom: .92 }, 200);
    session = settle(session, { ...target(.62, .28, 'component:web:map'), currentDetail: 'component', nextDetail: 'code', enterZoom: 1.24 }, 400);
    expect(session.settled.map(entry => entry.nextDetail)).toEqual(['container', 'component', 'code']);
    expect(session.active.phase).toBe('idle');
    session = reduceSemanticLensSession(session, {
      nowMs: 600,
      zoom: 1.1,
      direction: 'outward',
      target: { ...target(.57, .25, 'component:web:map'), currentDetail: 'component', nextDetail: 'code', enterZoom: 1.24 },
    });
    expect(session.settled.map(entry => entry.nextDetail)).toEqual(['container', 'component']);
    expect(session.active.phase).toBe('idle');
  });

  it('stabilizes a pan by preserving settled entries and promoting only a unique active handoff', () => {
    const settled = [{ targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const }];
    const active = {
      ...idleSemanticLens(),
      phase: 'revealing' as const,
      targetId: 'container:web',
      currentDetail: 'container' as const,
      nextDetail: 'component' as const,
      progress: .5,
    };
    expect(stabilizeSemanticLensSessionForPan({ baseDetail: 'context', settled, active })).toEqual({
      baseDetail: 'context',
      settled: [...settled, { targetId: 'container:web', currentDetail: 'container', nextDetail: 'component' }],
      active: idleSemanticLens(),
    });
    expect(stabilizeSemanticLensSessionForPan({ baseDetail: 'context', settled, active: { ...active, progress: .499 } }).settled)
      .toEqual(settled);
    expect(stabilizeSemanticLensSessionForPan({
      baseDetail: 'context',
      settled,
      active: { ...active, targetId: 'system:okie', currentDetail: 'context', nextDetail: 'container' },
    })).toEqual({ baseDetail: 'context', settled, active: idleSemanticLens() });
    expect(stabilizeSemanticLensSessionForPan({
      baseDetail: 'context',
      settled,
      active: { ...active, phase: 'idle', progress: 1 },
    })).toEqual({ baseDetail: 'context', settled, active: idleSemanticLens() });
  });

  it('defends canonical and reduced paths from a duplicate active candidate', () => {
    const entry = { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const };
    const duplicate = {
      ...idleSemanticLens(),
      phase: 'settled' as const,
      ...entry,
      progress: 1,
    };
    const session = { baseDetail: 'context' as const, settled: [entry], active: duplicate };
    expect(semanticLensCanonicalPathIds(session)).toEqual(['system:okie']);
    expect(reduceSemanticLensSession(session, {
      nowMs: 1,
      zoom: .7,
      direction: 'none',
      target: target(.82, .42),
    })).toEqual({ baseDetail: 'context', settled: [entry], active: idleSemanticLens() });
    expect(semanticLensCanonicalPathIds({ ...session, settled: [entry, entry] })).toEqual(['system:okie']);
  });

  it('supports live target eligibility that is strict-descendant and explicitly excludes settled targets', () => {
    const scene = createGoldenC4Scene();
    const rootId = 'system:okie';
    const rootBounds = scene.projection!.boundsByEntityIdAndDetail[rootId]!.context!;
    const camera = {
      x: rootBounds.x + rootBounds.width / 2,
      y: rootBounds.y + rootBounds.height / 2,
      zoom: 1,
    };
    const viewport = { width: 1200, height: 800 };
    const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    const eligible = new Set([rootId]);
    expect(findSemanticLensTarget(scene, 'context', camera, viewport, safeArea, pointer, [], eligible)?.id).toBe(rootId);
    expect(findSemanticLensTarget(scene, 'context', camera, viewport, safeArea, pointer, [], eligible, new Set([rootId])))
      .toBeUndefined();
    const descendants = semanticLensStrictDescendantIds(scene, rootId, 'container');
    expect(descendants).not.toContain(rootId);
    expect(descendants.length).toBeGreaterThan(0);
  });

  it('keeps the same authored node-owned threshold on tall and wide viewports', () => {
    const scene = createGoldenC4Scene();
    const rootId = 'system:okie';
    const bounds = scene.projection!.boundsByEntityIdAndDetail[rootId]!.context!;
    const viewports = [
      { viewport: { width: 1_792, height: 2_048 }, safeArea: { top: 194, right: 46, bottom: 49, left: 425 } },
      { viewport: { width: 1_920, height: 900 }, safeArea: { top: 80, right: 320, bottom: 64, left: 96 } },
    ];
    for (const { viewport, safeArea } of viewports) {
      const measured = measureSemanticLensTarget(scene, rootId, 'context', {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
        zoom: 1.16,
      }, viewport, safeArea)!;
      expect(measured.enterZoom).toBe(1.16);
      expect(measured.policy?.fullZoom).toBeCloseTo(1.30, 12);
    }
    const viewport = viewports[0]!.viewport;
    const safeArea = viewports[0]!.safeArea;
    const camera = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: 1.16 };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    const preInputTarget = findSemanticLensTarget(scene, 'context', { ...camera, zoom: 1.159 }, viewport, safeArea, pointer)!;
    const found = findSemanticLensTarget(scene, 'context', camera, viewport, safeArea, pointer)!;
    expect(found.id).toBe(rootId);
    expect(found.enterZoom).toBe(1.16);
    expect(found.policy).toMatchObject({
      sourceRepresentationId: expect.stringContaining(':context'),
      targetRepresentationId: expect.stringContaining(':container'),
      transitionMs: 180,
    });
    expect(found.policy?.fullZoom).toBeCloseTo(1.30, 12);

    // Viewport coverage no longer postpones L1 until it collides with L3.
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 1.159,
      direction: 'inward',
      target: preInputTarget,
    }).phase).toBe('idle');

    const armed = reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 1.16,
      direction: 'inward',
      target: found,
    });
    const held = reduceSemanticLens(armed, {
      nowMs: 40,
      zoom: 1.16,
      direction: 'none',
      target: found,
    });
    expect(held.phase).toBe('armed');
    const midpointZoom = Math.sqrt(1.16 * 1.30);
    const midpointTarget = measureSemanticLensTarget(scene, rootId, 'context', { ...camera, zoom: midpointZoom }, viewport, safeArea)!;
    const revealing = reduceSemanticLens(held, {
      nowMs: 100,
      zoom: midpointZoom,
      direction: 'inward',
      target: midpointTarget,
    });
    expect(revealing).toMatchObject({ phase: 'revealing', transitionMs: 180, dwellMs: 80 });
    expect(revealing.progress).toBeCloseTo(.5, 12);
    const fullTarget = measureSemanticLensTarget(scene, rootId, 'context', { ...camera, zoom: 1.30 }, viewport, safeArea)!;
    expect(reduceSemanticLens(revealing, {
      nowMs: 110,
      zoom: 1.30,
      direction: 'inward',
      target: fullTarget,
    })).toMatchObject({ phase: 'settled', progress: 1 });
  });

  it('leaves wheel runway between layers and maps logarithmic transition progress reversibly', () => {
    expect(semanticLensZoomProgress(Math.sqrt(1.16 * 1.30), 1.16, 1.30)).toBeCloseTo(.5, 12);
    expect(semanticLensZoomProgress(Math.sqrt(3.35 * 3.75), 3.35, 3.75)).toBeCloseTo(.5, 12);
    expect(semanticLensZoomProgress(Math.sqrt(7.10 * 7.95), 7.10, 7.95)).toBeCloseTo(.5, 12);

    const authored = (
      id: string,
      currentDetail: SemanticLensTarget['currentDetail'],
      nextDetail: SemanticLensTarget['nextDetail'],
      enterZoom: number,
      fullZoom: number,
    ): SemanticLensTarget => ({
      id,
      currentDetail,
      nextDetail,
      enterZoom,
      hysteresis: enterZoom * .075,
      coverage: { major: 0, minor: 0 },
      containmentPx: 80,
      policy: {
        enterCoverage: { major: .72, minor: .42 },
        commitCoverage: { major: .78, minor: .46 },
        fullCoverage: { major: .84, minor: .50 },
        leaveCoverage: { major: .58, minor: .30 },
        minimumCssSize: { width: 320, height: 180 },
        fullZoom,
        transitionMs: 180,
        dwellMs: 80,
        pointerInsetPx: 24,
      },
    });
    const l1 = authored('system:okie', 'context', 'container', 1.16, 1.30);
    let session = idleSemanticLensSession('context');
    session = reduceSemanticLensSession(session, { nowMs: 0, zoom: 1.16, direction: 'inward', target: l1 });
    session = reduceSemanticLensSession(session, { nowMs: 90, zoom: 1.30, direction: 'inward', target: l1 });
    expect(session.settled).toHaveLength(1);

    const l2 = authored('container:web-app', 'container', 'component', 3.35, 3.75);
    for (const [index, zoom] of [1.45, 1.8, 2.2, 2.7, 3.34].entries()) {
      session = reduceSemanticLensSession(session, { nowMs: 100 + index * 20, zoom, direction: 'inward', target: l2 });
      expect(session.settled).toHaveLength(1);
      expect(session.active.phase).toBe('idle');
    }
    session = reduceSemanticLensSession(session, { nowMs: 220, zoom: 3.35, direction: 'inward', target: l2 });
    expect(session.active.phase).toBe('armed');
    session = reduceSemanticLensSession(session, { nowMs: 310, zoom: 3.75, direction: 'inward', target: l2 });
    expect(session.settled).toHaveLength(2);

    const l3 = authored('component:web-shell', 'component', 'code', 7.10, 7.95);
    for (const candidate of [l1, l2, l3]) {
      for (const expectedProgress of [.25, .5, .75]) {
        const zoom = candidate.enterZoom
          * (candidate.policy!.fullZoom! / candidate.enterZoom) ** expectedProgress;
        const revealingState = {
          ...idleSemanticLens(),
          phase: 'revealing' as const,
          targetId: candidate.id,
          currentDetail: candidate.currentDetail,
          nextDetail: candidate.nextDetail,
        };
        const inward = reduceSemanticLens(revealingState, {
          nowMs: 1_000,
          zoom,
          direction: 'inward',
          target: candidate,
        });
        const outward = reduceSemanticLens({
          ...revealingState,
          phase: 'settled',
          progress: 1,
        }, {
          nowMs: 80_000,
          zoom,
          direction: 'outward',
          target: candidate,
        });
        expect(inward.progress).toBeCloseTo(expectedProgress, 12);
        expect(outward.progress).toBeCloseTo(expectedProgress, 12);
        expect(outward.progress).toBeCloseTo(inward.progress, 12);
      }
    }
    for (const [index, zoom] of [4.0, 4.8, 5.6, 6.4, 7.09].entries()) {
      session = reduceSemanticLensSession(session, { nowMs: 330 + index * 20, zoom, direction: 'inward', target: l3 });
      expect(session.settled).toHaveLength(2);
      expect(session.active.phase).toBe('idle');
    }

    // A settled layer remains structurally settled above its authored full
    // zoom. Once the camera re-enters the same window, reverse uses the exact
    // same log-space progress as reveal and never decays with wall-clock time.
    const aboveFull = reduceSemanticLensSession(session, {
      nowMs: 500,
      zoom: 4,
      direction: 'outward',
      target: l2,
    });
    expect(aboveFull).toBe(session);

    const midpoint = Math.sqrt(l2.enterZoom * l2.policy!.fullZoom!);
    const reversing = reduceSemanticLensSession(session, {
      nowMs: 520,
      zoom: midpoint,
      direction: 'outward',
      target: l2,
    });
    expect(reversing.settled.map(entry => entry.targetId)).toEqual([l1.id]);
    expect(reversing.active).toMatchObject({ phase: 'reversing', targetId: l2.id });
    expect(reversing.active.progress).toBeCloseTo(.5, 12);
    expect(semanticLensCanonicalPathIds(reversing)).toEqual([l1.id, l2.id]);

    const quiet = reduceSemanticLensSession(reversing, {
      nowMs: 50_000,
      zoom: midpoint,
      direction: 'none',
      target: l2,
    });
    expect(quiet.active.progress).toBeCloseTo(reversing.active.progress, 12);
    expect(quiet.active.reversingAtMs).toBeUndefined();

    const inwardAtSameZoom = reduceSemanticLensSession(quiet, {
      nowMs: 50_020,
      zoom: midpoint,
      direction: 'inward',
      target: l2,
    });
    expect(inwardAtSameZoom.active.phase).toBe('revealing');
    expect(inwardAtSameZoom.active.progress).toBeCloseTo(reversing.active.progress, 12);

    const outwardAtSameZoom = reduceSemanticLensSession(inwardAtSameZoom, {
      nowMs: 50_040,
      zoom: midpoint,
      direction: 'outward',
      target: l2,
    });
    expect(outwardAtSameZoom.active.phase).toBe('reversing');
    expect(outwardAtSameZoom.active.progress).toBeCloseTo(inwardAtSameZoom.active.progress, 12);

    const popped = reduceSemanticLensSession(outwardAtSameZoom, {
      nowMs: 50_060,
      zoom: l2.enterZoom,
      direction: 'outward',
      target: l2,
    });
    expect(popped.settled.map(entry => entry.targetId)).toEqual([l1.id]);
    expect(popped.active).toEqual(idleSemanticLens());
    expect(semanticLensCanonicalPathIds(popped)).toEqual([l1.id]);
  });

  it('keeps background siblings in their prior layout throughout deeper owner zoom', () => {
    const scene = createGoldenC4Scene();
    const entries = [
      { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
      { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      { targetId: 'component:model-normalized', currentDetail: 'component' as const, nextDetail: 'code' as const },
    ];
    let checkedBackground = 0;
    for (let depth = 1; depth < entries.length; depth += 1) {
      const entry = entries[depth]!;
      const sourceSession = { baseDetail: 'context' as const, settled: entries.slice(0, depth), active: idleSemanticLens() };
      const targetSession = { ...sourceSession, settled: entries.slice(0, depth + 1) };
      const source = semanticLensSessionProjectionOverride(scene, sourceSession)!;
      for (const ghost of semanticLensSessionGhostEntities(scene, targetSession)) {
        const visualId = scene.projection!.semanticToVisualEntityId[ghost.id]!;
        const before = source.objects.find(object => object.objectId === visualId)!;
        if (!before.targetRepresentationId || !before.targetOpacity) continue;
        checkedBackground += 1;
        for (const progress of [0, .25, .5, .75, 1, .75, .5, .25, 0]) {
          const frame = semanticLensSessionProjectionOverride(scene, {
            ...sourceSession,
            active: { ...entry, phase: 'revealing', progress, assistBlend: 0 },
          })!;
          const object = frame.objects.find(object => object.objectId === visualId)!;
          expect(object.sourceRepresentationId, ghost.id).toBe(before.targetRepresentationId);
          expect(object.targetRepresentationId, ghost.id).toBe(before.targetRepresentationId);
          expect(frame.morph?.objectIds).not.toContain(visualId);
          if (progress === 0) expect(object.sourceOpacity, `entry opacity: ${ghost.id}`).toBe(before.targetOpacity);
        }
        const after = semanticLensSessionProjectionOverride(scene, targetSession)!.objects.find(object => object.objectId === visualId)!;
        expect(after.targetRepresentationId, ghost.id).toBe(before.targetRepresentationId);
      }
    }
    expect(checkedBackground).toBeGreaterThan(0);
  });

  it('retains deterministic prior-depth sibling context around the full-opacity primary branch', () => {
    const scene = createGoldenC4Scene();
    const containers = scene.entities.filter(entity => entity.detail === 'container');
    const targetContainer = containers.find(container => scene.entities.some(component => component.parentId === container.id
      && component.detail === 'component'
      && scene.entities.some(code => code.parentId === component.id && code.detail === 'code')))!;
    const targetComponent = scene.entities.find(component => component.parentId === targetContainer.id
      && component.detail === 'component'
      && scene.entities.some(code => code.parentId === component.id && code.detail === 'code'))!;
    const entries = [
      { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
      { targetId: targetContainer.id, currentDetail: 'container' as const, nextDetail: 'component' as const },
      { targetId: targetComponent.id, currentDetail: 'component' as const, nextDetail: 'code' as const },
    ];

    for (const [index, entry] of entries.entries()) {
      const session = {
        baseDetail: 'context' as const,
        settled: entries.slice(0, index + 1),
        active: idleSemanticLens(),
      };
      const expectedEntities = semanticLensBranchEntityIds(scene, entry.targetId, entry.nextDetail);
      const expectedEntitySet = new Set(expectedEntities);
      const primaryRelations = scene.projection!.projectedRelationsByDetail[entry.nextDetail]
        .filter(relation => expectedEntitySet.has(relation.from) && expectedEntitySet.has(relation.to))
        .map(relation => relation.id)
        .sort();
      const override = semanticLensSessionProjectionOverride(scene, session)!;
      const ghosts = semanticLensSessionGhostEntities(scene, session);
      const ghostById = new Map(ghosts.map(ghost => [ghost.id, ghost]));
      const silhouettes = semanticLensSessionSilhouetteEntities(scene, session);
      const silhouetteById = new Map(silhouettes.map(silhouette => [silhouette.id, silhouette]));
      const ancestors = new Map(entries.slice(0, index).map(ancestor => [ancestor.targetId, ancestor]));
      const retained = [...new Set([...expectedEntities, ...ghostById.keys(), ...silhouetteById.keys(), ...ancestors.keys()])].sort();

      expect(semanticLensSessionVisibleEntityIds(scene, session)).toEqual(retained);
      expect(semanticLensSessionVisibleRelationIds(scene, session))
        .toEqual(override.paths.filter(path => path.targetOpacity > 0).map(path => path.pathId).sort());
      for (const entity of scene.entities) {
        const visualId = scene.projection!.semanticToVisualEntityId[entity.id];
        if (!visualId) continue;
        const owner = override.objects.find(object => object.objectId === visualId);
        const ancestor = ancestors.get(entity.id);
        const ghost = ghostById.get(entity.id);
        const silhouette = silhouetteById.get(entity.id);
        const expectedDetail = expectedEntitySet.has(entity.id)
          ? entry.nextDetail
          : ancestor?.currentDetail ?? (ghost ? ghost.detail : silhouette?.detail);
        expect(owner?.targetRepresentationId, `${entry.nextDetail} ownership for ${entity.id}`)
          .toBe(expectedDetail ? `${visualId}:${expectedDetail}` : undefined);
        expect(owner?.targetOpacity).toBe(expectedEntitySet.has(entity.id)
          ? 1
          : ancestor ? .32 : ghost?.opacity ?? silhouette?.opacity ?? 0);
        expect(owner?.targetContentOpacity).toBe(expectedEntitySet.has(entity.id)
          ? 1
          : ancestor ? 0 : ghost?.opacity === .24 ? .24 : 0);
        expect(owner?.targetPickable).toBe(expectedEntitySet.has(entity.id) || ghost?.opacity === .24);
      }
      for (const path of override.paths) {
        expect([0, .10, 1], `${entry.nextDetail} ownership for ${path.pathId}`).toContain(path.targetOpacity);
        if (primaryRelations.includes(path.pathId)) expect(path.targetOpacity).toBe(1);
      }
    }

    const componentSession = {
      baseDetail: 'context' as const,
      settled: entries.slice(0, 2),
      active: idleSemanticLens(),
    };
    expect(semanticLensSessionVisibleEntityIds(scene, componentSession)).toContain('system:okie');
    const codeSession = { ...componentSession, settled: entries };
    expect(semanticLensSessionVisibleEntityIds(scene, codeSession)).toContain(targetContainer.id);
    expect([...new Set(semanticLensSessionGhostEntities(scene, codeSession).map(ghost => ghost.opacity))].sort())
      .toEqual([.07, .13, .24]);
    const silhouettes = semanticLensSessionSilhouetteEntities(scene, codeSession);
    expect(silhouettes.length).toBeLessThanOrEqual(48);
    expect(silhouettes.every(silhouette => semanticLensSessionGhostEntities(scene, codeSession)
      .some(ghost => ghost.id === silhouette.parentGhostId && ghost.opacity === .24))).toBe(true);
    expect([...new Set(silhouettes.map(silhouette => silhouette.parentGhostId))]
      .every(parentId => silhouettes.filter(silhouette => silhouette.parentGhostId === parentId).length <= 8)).toBe(true);
  });

  it('transfers pan focus once after dwell without changing camera or mutating the path during drag', () => {
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
    const viewport = { width: 1_280, height: 720 };
    const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
    const ghost = semanticLensSessionGhostEntities(scene, session)
      .find(candidate => candidate.opacity === .24
        && scene.entities.some(entity => entity.parentId === candidate.id && entity.detail === 'code'))!;
    expect(ghost).toBeDefined();
    const bounds = scene.projection!.boundsByEntityIdAndDetail[ghost.id]![ghost.detail]!;
    const camera = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: 5.15 };
    const cameraBefore = { ...camera };

    expect(findSemanticGhostFocusTarget(scene, session, camera, viewport, safeArea)).toMatchObject({
      id: ghost.id,
      depth: ghost.depth,
    });
    expect(settleSemanticLensPanFocus(scene, session, camera, viewport, safeArea, 159)).toBe(session);
    expect(session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model', 'component:model-normalized']);

    const transferred = settleSemanticLensPanFocus(scene, session, camera, viewport, safeArea, 160);
    expect(transferred).not.toBe(session);
    expect(transferred.settled.map(entry => entry.targetId)).toEqual(['system:okie', 'container:architecture-model', ghost.id]);
    expect(transferred.focusTransfer).toMatchObject({ targetId: ghost.id, depth: 2, progress: 0 });
    expect(camera).toEqual(cameraBefore);
    expect(scene.rootEntityId).toBe('system:okie');

    const reordered = { ...scene, entities: [...scene.entities].reverse() };
    expect(findSemanticGhostFocusTarget(reordered, session, camera, viewport, safeArea)?.id).toBe(ghost.id);
  });

  it('preserves hidden background visibility at both focus-transfer endpoints', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const ghost = semanticLensSessionGhostEntities(scene, session).find(candidate => candidate.depth === 1
      && scene.entities.some(entity => entity.parentId === candidate.id && entity.detail === 'component'))!;
    const focusBounds = scene.projection!.boundsByEntityIdAndDetail['container:architecture-model']!.component!;
    const old = scene.projection!.boundsByEntityIdAndDetail[ghost.id]!.container!;
    scene.projection!.boundsByEntityIdAndDetail[ghost.id]!.container = { ...old, x: focusBounds.x + 1, y: focusBounds.y + 1 };
    const before = semanticLensSessionProjectionOverride(scene, session)!;
    const transferred = transferSemanticLensFocus(scene, session, ghost);
    const start = semanticLensSessionProjectionOverride(scene, transferred)!;
    const end = semanticLensSessionProjectionOverride(scene, { ...transferred, focusTransfer: { ...transferred.focusTransfer!, progress: 1 } })!;
    const settled = semanticLensSessionProjectionOverride(scene, advanceSemanticLensFocusTransfer(transferred, 1))!;
    const ghostVisual = scene.projection!.semanticToVisualEntityId[ghost.id];
    expect(before.objects.find(object => object.objectId === ghostVisual)!.targetOpacity).toBe(0);
    for (const object of start.objects) {
      expect(object.sourceOpacity, object.objectId).toBe(before.objects.find(candidate => candidate.objectId === object.objectId)!.targetOpacity);
    }
    for (const object of end.objects) {
      expect(object.targetOpacity, object.objectId).toBe(settled.objects.find(candidate => candidate.objectId === object.objectId)!.targetOpacity);
    }
  });

  it('crossfades the old primary into ghost context over the focus-transfer override', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const ghost = semanticLensSessionGhostEntities(scene, session)
      .find(candidate => candidate.depth === 1
        && scene.entities.some(entity => entity.parentId === candidate.id && entity.detail === 'component'))!;
    const transferred = transferSemanticLensFocus(scene, session, ghost);
    const halfway = advanceSemanticLensFocusTransfer(transferred, .5);
    const override = semanticLensSessionProjectionOverride(scene, halfway)!;
    const oldVisualId = scene.projection!.semanticToVisualEntityId['container:architecture-model'];
    const nextVisualId = scene.projection!.semanticToVisualEntityId[ghost.id];
    expect(override.objects.find(object => object.objectId === oldVisualId)).toMatchObject({
      sourceOpacity: 1,
      targetOpacity: .24,
      sourceContentOpacity: 1,
      targetContentOpacity: .24,
      sourcePickable: true,
      targetPickable: true,
    });
    expect(override.objects.find(object => object.objectId === nextVisualId)).toMatchObject({
      sourceOpacity: .24,
      targetOpacity: 1,
      sourceContentOpacity: .24,
      targetContentOpacity: 1,
      sourcePickable: true,
      targetPickable: true,
    });
    expect(override.progress).toBe(.5);
    const contentAtHalf = (objectId: string) => {
      const object = override.objects.find(candidate => candidate.objectId === objectId)!;
      return object.sourceContentOpacity! + (object.targetContentOpacity! - object.sourceContentOpacity!) * override.progress;
    };
    expect(contentAtHalf(oldVisualId)).toBe(.62);
    expect(contentAtHalf(nextVisualId)).toBe(.62);
    const newSilhouette = semanticLensSessionSilhouetteEntities(scene, session)
      .find(silhouette => silhouette.parentGhostId === ghost.id)!;
    const newSilhouetteVisualId = scene.projection!.semanticToVisualEntityId[newSilhouette.id];
    expect(override.objects.find(object => object.objectId === newSilhouetteVisualId)).toMatchObject({
      sourceOpacity: .14,
      targetOpacity: 1,
      sourceContentOpacity: 0,
      targetContentOpacity: 1,
      sourcePickable: false,
      targetPickable: true,
    });
    const oldPrimaryChild = scene.entities.find(entity => entity.parentId === 'container:architecture-model'
      && entity.detail === 'component')!;
    const oldPrimaryChildVisualId = scene.projection!.semanticToVisualEntityId[oldPrimaryChild.id];
    expect(override.objects.find(object => object.objectId === oldPrimaryChildVisualId)).toMatchObject({
      sourceOpacity: 1,
      targetOpacity: .14,
      sourceContentOpacity: 1,
      targetContentOpacity: 0,
      sourcePickable: true,
      targetPickable: false,
    });
    expect(semanticLensSessionVisibleEntityIds(scene, halfway)).toEqual(expect.arrayContaining([
      'container:architecture-model',
      ghost.id,
    ]));
    const finished = advanceSemanticLensFocusTransfer(halfway, 1);
    expect(finished.focusTransfer).toBeUndefined();
    expect(semanticLensSessionProjectionOverride(scene, finished)!.progress).toBe(1);
  });

  it('uses identical content endpoints at the same inward and reverse progress', () => {
    const scene = createGoldenC4Scene();
    const settled = [
      { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
      { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
    ];
    const active = {
      targetId: 'component:model-normalized',
      currentDetail: 'component' as const,
      nextDetail: 'code' as const,
      progress: .5,
      assistBlend: 0,
    };
    const inward = semanticLensSessionProjectionOverride(scene, {
      baseDetail: 'context',
      settled,
      active: { ...active, phase: 'revealing' },
    })!;
    const outward = semanticLensSessionProjectionOverride(scene, {
      baseDetail: 'context',
      settled,
      active: { ...active, phase: 'reversing' },
    })!;
    expect(outward).toEqual(inward);

    const priorBoundaryId = scene.projection!.semanticToVisualEntityId['container:architecture-model'];
    const activeBoundaryId = scene.projection!.semanticToVisualEntityId[active.targetId];
    expect(inward.objects.find(object => object.objectId === priorBoundaryId)).toMatchObject({
      sourceOpacity: 1,
      targetOpacity: .32,
      sourceContentOpacity: 1,
      targetContentOpacity: 0,
    });
    expect(inward.objects.find(object => object.objectId === activeBoundaryId)).toMatchObject({
      sourceOpacity: 1,
      targetOpacity: 1,
      sourceContentOpacity: 1,
      targetContentOpacity: 1,
    });
  });
});

describe('composeSemanticZoomCamera — a zoom never moves the camera (anchor invariance)', () => {
  const viewport = { width: 1_000, height: 800 };
  // Places a 10x10 owner's top-left at screen (left, top) at zoom 10.
  const cameraForRect = (left: number, top: number) => ({ x: (viewport.width / 2 - left) / 10, y: (viewport.height / 2 - top) / 10, zoom: 10 });

  it('passes every cursor camera through untouched when no morph is in flight', () => {
    // Includes the cases earlier revisions corrected at settle: a small owner past the
    // safe edges (task #32 pull-in) and an oversized owner with a dead-space gap (the
    // v1 edge-close). A zoom sample is now identity everywhere.
    for (const cursor of [cameraForRect(760, 620), cameraForRect(300, 300), { x: 30, y: 40, zoom: 10 }]) {
      expect(composeSemanticZoomCamera(cursor)).toBe(cursor);
    }
  });

  it('applies exactly the owner-morph reflow pin while a reveal is in flight', () => {
    const overflowing = cameraForRect(760, 620);
    const morph = { sourceBounds: { x: 0, y: 0, width: 10, height: 10 }, targetBounds: { x: 50, y: 30, width: 10, height: 10 }, progress: .5, baselineProgress: 0 };
    const pinned = compensateSemanticMorphCamera(overflowing, morph.sourceBounds, morph.targetBounds, morph.progress, morph.baselineProgress);
    expect(composeSemanticZoomCamera(overflowing, morph)).toEqual(pinned);
    // The pin cancels bounds reflow only — zoom is never touched.
    expect(composeSemanticZoomCamera(overflowing, morph).zoom).toBe(overflowing.zoom);
  });

  it('a wheel stream toward an off-centre target is identity at every frame, settle included', () => {
    const stream = [cameraForRect(700, 560), cameraForRect(740, 590), cameraForRect(780, 620), cameraForRect(820, 650)];
    for (const cursor of stream) {
      expect(composeSemanticZoomCamera(cursor)).toBe(cursor);
    }
  });
});

describe('semantic lens policy', () => {
  it('arms at authored enter/coverage, dwells 90ms, reveals, and settles at full coverage', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), { nowMs: 0, zoom: .60, direction: 'inward', target: target(.42, .18) });
    expect(armed.phase).toBe('armed');
    expect(reduceSemanticLens(armed, { nowMs: 89, zoom: .70, direction: 'inward', target: target(.49, .22) }).phase).toBe('armed');
    const revealing = reduceSemanticLens(armed, { nowMs: 90, zoom: .70, direction: 'inward', target: target(.49, .22) });
    expect(revealing.phase).toBe('revealing');
    expect(revealing.progress).toBeCloseTo(.5);
    const settled = reduceSemanticLens(revealing, { nowMs: 110, zoom: .74, direction: 'inward', target: target(.52, .24) });
    expect(settled.phase).toBe('settled');
    expect(settledSemanticLensId(settled)).toBe('system:okie');
  });

  it('reverses on either outward coverage guard and clears below progress zero', () => {
    const settled = { ...idleSemanticLens(), phase: 'settled' as const, targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const, progress: 1, assistBlend: .68 };
    const reversing = reduceSemanticLens(settled, { nowMs: 200, zoom: .64, direction: 'outward', target: target(.70, .30) });
    expect(reversing.phase).toBe('reversing');
    expect(reduceSemanticLens(reversing, { nowMs: 220, zoom: .55, direction: 'outward', target: target(.57, .25) }).phase).toBe('idle');
  });

  it('retargets below 50% only after 80ms with 24px containment, then locks', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), { nowMs: 0, zoom: .60, direction: 'inward', target: target(.62, .28) });
    const candidate = target(.70, .32, 'container:web');
    const waiting = reduceSemanticLens(armed, { nowMs: 10, zoom: .62, direction: 'inward', target: candidate });
    expect(waiting.targetId).toBe('system:okie');
    const retargeted = reduceSemanticLens(waiting, { nowMs: 90, zoom: .63, direction: 'inward', target: candidate });
    expect(retargeted.targetId).toBe('container:web');
    const locked = reduceSemanticLens({ ...retargeted, phase: 'revealing', progress: .5 }, { nowMs: 200, zoom: .9, direction: 'inward', target: target(.78, .39, 'container:other') });
    expect(locked.targetId).toBe('container:web');
  });

  it('reduced motion swaps after settle and mobile arms only after accumulated 12% intent', () => {
    const idle = idleSemanticLens();
    expect(reduceSemanticLens(idle, { nowMs: 0, zoom: .66, direction: 'inward', target: target(.82, .42), mobile: true, gestureStartZoom: .60 }).phase).toBe('idle');
    const armed = reduceSemanticLens(idle, { nowMs: 10, zoom: .672, direction: 'inward', target: target(.82, .42), mobile: true, gestureStartZoom: .60 });
    expect(armed.phase).toBe('armed');
    expect(reduceSemanticLens(armed, { nowMs: 99, zoom: .672, direction: 'inward', target: target(.82, .42), mobile: true, gestureStartZoom: .60 }).phase).toBe('armed');
    const settled = reduceSemanticLens(armed, { nowMs: 100, zoom: .672, direction: 'none', target: target(.82, .42), mobile: true, reducedMotion: true, gestureSettled: true, gestureStartZoom: .60 });
    expect(settled).toMatchObject({ phase: 'settled', assistBlend: 0 });
  });

  it('cancels without persistence and serializes only a settled lens', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), { nowMs: 0, zoom: .60, direction: 'inward', target: target(.62, .28) });
    expect(reduceSemanticLens(armed, { nowMs: 1, zoom: .60, direction: 'none', cancel: true }).phase).toBe('idle');
    expect(semanticLensUrl('https://okie.test/?nav=1', armed)).toBe('https://okie.test/?nav=1');
    expect(semanticLensUrl('https://okie.test/?nav=1', { ...armed, phase: 'revealing', progress: .5 })).toContain('lens=system%3Aokie');
    expect(semanticLensUrl('https://okie.test/?nav=1', { ...armed, phase: 'settled' })).toContain('lens=system%3Aokie');
  });

  it('maps commit to full coverage monotonically', () => {
    expect(semanticLensCoverageProgress(SEMANTIC_LENS_POLICY.commitCoverage)).toBe(0);
    expect(semanticLensCoverageProgress({ major: .49, minor: .22 })).toBeCloseTo(.5);
    expect(semanticLensCoverageProgress(SEMANTIC_LENS_POLICY.fullCoverage)).toBe(1);
  });
});


describe('one-shot semantic lens zoom attribution', () => {
  const viewport = { width: 1200, height: 800 };
  const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
  it('reports the actual authored gate while distinguishing unused CSS and coverage floors', () => {
    const scene = createGoldenC4Scene();
    const diagnostics = semanticLensTargetZoomDiagnostics(scene, 'system:okie', 'context', viewport, safeArea)!;
    const bounds = diagnostics.currentBounds;
    const measured = measureSemanticLensTarget(scene, 'system:okie', 'context', {
      x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: diagnostics.enterZoom,
    }, viewport, safeArea)!;
    expect(diagnostics.enterZoom).toBe(measured.enterZoom);
    expect(diagnostics.fullZoom).toBe(measured.policy!.fullZoom);
    expect(diagnostics.leaveZoom).toBe(measured.enterZoom - measured.hysteresis!);
    expect(diagnostics.dominantTerms).toEqual(['authored-minimum']);
    expect(diagnostics.commitGate).toBe('enter-zoom');
    expect(diagnostics.fullGate).toBe('full-zoom');
    expect(diagnostics.coverageZoom).toBeGreaterThan(diagnostics.enterZoom);
    expect(measured).not.toHaveProperty('diagnostics');
  });
  it('distinguishes CSS-size, LOD and current-card coverage fallback winners', () => {
    const scene = createGoldenC4Scene();
    scene.projection!.semanticTransitionsByEntityId = {};
    const lod = semanticLensTargetZoomDiagnostics(scene, 'system:okie', 'context', { width: 20, height: 20 }, safeArea)!;
    expect(lod.dominantTerms).toEqual(['lod-minimum']);
    expect(lod.enterZoom).toBe(lod.lodMinimum);
    const bounds = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    bounds.width = 20; bounds.height = 10;
    const css = semanticLensTargetZoomDiagnostics(scene, 'system:okie', 'context', { width: 20, height: 20 }, safeArea)!;
    expect(css.dominantTerms).toEqual(['minimum-css-size']);
    expect(css.enterZoom).toBe(8.4);
    const coverage = semanticLensTargetZoomDiagnostics(scene, 'system:okie', 'context', viewport, safeArea)!;
    expect(coverage.dominantTerms).toEqual(['current-card-coverage']);
    expect(coverage.enterZoom).toBe(coverage.coverageZoom);
    expect(coverage.commitGate).toBe('current-card-coverage');
    expect(coverage.fullGate).toBe('current-card-coverage');
    expect(coverage.fullCoverageZoom).toBeGreaterThan(coverage.commitCoverageZoom);
  });
  it('does not invent a threshold when the destination geometry is absent', () => {
    const scene = createGoldenC4Scene();
    delete scene.projection!.boundsByEntityIdAndDetail['system:okie']!.container;
    expect(semanticLensTargetZoomDiagnostics(scene, 'system:okie', 'context', viewport, safeArea)).toBeUndefined();
  });
});
