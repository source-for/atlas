import { describe, expect, it } from 'vitest';
import type { SceneSnapshot } from '@okie/scene-compiler';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, SCAN_RESIDENT_NODES_PER_BAND } from '../renderer/scanFixture';
import { applySemanticBackgroundVisibility, composeSemanticZoomCamera, semanticLensSessionProjectionOverride, validateRestoredSemanticLensPath } from './semanticLens';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';
import { semanticBounds } from '../renderer/goldenC4Scene';
import { semanticPanFocusPlan } from './semanticLensEngine';
import { SCAN_CONTAINER_MORPH_MIN_SPAN, createScanContainerMorph, createScanDetailMorph, createScanReverseMorph, retainScanDetailMorphSource, sampleScanContainerMorph, scanContainerMorphCamera, scanContainerMorphOwnsSession, shouldStartScanContainerReverseMorph } from './scanContainerMorph';

function fixture() {
  const fixture = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
  const source = fixture.createScene(fixture.navigation.rootEntityId);
  const target = fixture.createScene('container:web-app', source);
  const morph = createScanContainerMorph(source, target, 'container:web-app', 2)!;
  return { source, target, morph };
}

describe('scan container expansion', () => {
  it('keeps nonfocused container geometry fixed while only the selected container expands', () => {
    const { source, morph } = fixture();
    let differentLayouts = 0;
    for (const sibling of source.entities.filter(entity => entity.detail === 'container' && entity.id !== morph.focusId)) {
      const visualId = morph.scene.projection!.semanticToVisualEntityId[sibling.id];
      const bounds = morph.scene.projection!.boundsByEntityIdAndDetail[sibling.id];
      if (!bounds?.container || !bounds.component) continue;
      if (JSON.stringify(bounds.container) !== JSON.stringify(bounds.component)) differentLayouts += 1;
      for (const zoom of [morph.startZoom, (morph.startZoom + morph.fullZoom) / 2, morph.fullZoom]) {
        const frame = sampleScanContainerMorph(morph, zoom);
        const projection = semanticLensSessionProjectionOverride(morph.scene, frame.session)!;
        const object = projection.objects.find(object => object.objectId === visualId)!;
        expect(object.sourceRepresentationId, sibling.id).toBe(`${visualId}:container`);
        expect(object.targetRepresentationId, sibling.id).toBe(`${visualId}:container`);
        expect(projection.morph?.objectIds ?? []).not.toContain(visualId);
      }
    }
    expect(differentLayouts).toBeGreaterThan(0);
  });

  it('removes covered sibling boundaries and their routes from the expanded focus', () => {
    const { source, morph } = fixture();
    // Deliberately put a source sibling beneath the expanded owner, as happens
    // when the full scan file layout outgrows its compact container card.
    const sibling = source.entities.find(entity => entity.detail === 'container' && entity.id !== morph.focusId)!;
    const visualId = morph.scene.projection!.semanticToVisualEntityId[sibling.id]!;
    const original = morph.scene.projection!.boundsByEntityIdAndDetail[sibling.id]!.container!;
    morph.scene.projection!.boundsByEntityIdAndDetail[sibling.id] = {
      ...morph.scene.projection!.boundsByEntityIdAndDetail[sibling.id],
      container: { ...original, x: morph.targetBounds.x + 1, y: morph.targetBounds.y + 1 },
    };
    const projection = semanticLensSessionProjectionOverride(morph.scene, morph.targetSession)!;
    const halfway = sampleScanContainerMorph(morph, (morph.startZoom + morph.fullZoom) / 2);
    const topology = semanticLensSessionProjectionOverride(morph.scene, {
      ...halfway.session, active: { ...halfway.session.active, progress: 0 },
    }, true)!;
    const direct = semanticLensSessionProjectionOverride(morph.scene, halfway.session)!;
    expect(applySemanticBackgroundVisibility(morph.scene, halfway.session, { ...topology, progress: halfway.progress })).toEqual(direct);
    expect(projection.objects.find(object => object.objectId === visualId)).toMatchObject({
      sourceOpacity: 0, targetOpacity: 0, sourcePickable: false, targetPickable: false,
      sourceRepresentationId: `${visualId}:container`, targetRepresentationId: `${visualId}:container`,
    });
    const routes = morph.scene.projection!.projectedRelationsByDetail.container.filter(relation => relation.from === sibling.id || relation.to === sibling.id);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(projection.paths.find(path => path.pathId === route.id)).toMatchObject({ sourceOpacity: 0, targetOpacity: 0 });
    }
  });

  it('installs a reverse bridge when L3 was reached without the wheel handoff', () => {
    expect(shouldStartScanContainerReverseMorph({
      direction: 'outward', currentDetail: 'component', currentRootId: 'container:web-app',
      viewRootId: 'system:okie', activeTargetId: 'container:web-app',
    })).toBe(true);
    expect(shouldStartScanContainerReverseMorph({
      direction: 'inward', currentDetail: 'component', currentRootId: 'container:web-app',
      viewRootId: 'system:okie', activeTargetId: 'container:web-app',
    })).toBe(false);
    expect(shouldStartScanContainerReverseMorph({
      direction: 'outward', currentDetail: 'component', currentRootId: 'container:web-app',
      viewRootId: 'system:okie', activeTargetId: 'component:selected-file',
    })).toBe(false);
  });

  it('starts on the exact existing L2 cards and expands the scoped file graph, not the preview pills', () => {
    const { source, target, morph } = fixture();
    expect(morph).toBeDefined();
    const sourceProtocol = source.protocolSnapshot as SceneSnapshot;
    const bridgeProtocol = morph.scene.protocolSnapshot as SceneSnapshot;
    const targetProtocol = target.protocolSnapshot as SceneSnapshot;
    for (const id of source.projection!.entityIdsByDetail.container) {
      const visual = source.projection!.semanticToVisualEntityId[id];
      const representation = sourceProtocol.objects.find(object => object.id === visual)!
        .representations.find(representation => representation.id === `${visual}:container`);
      expect(bridgeProtocol.objects.find(object => object.id === visual)!
        .representations.find(representation => representation.id === `${visual}:container`)).toEqual(representation);
    }
    const files = morph.scene.entities.filter(entity => entity.parentId === morph.focusId && entity.detail === 'component');
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(SCAN_RESIDENT_NODES_PER_BAND);
    for (const file of files) {
      const visual = morph.scene.projection!.semanticToVisualEntityId[file.id];
      expect(bridgeProtocol.objects.find(object => object.id === visual)!.representations
        .find(representation => representation.id === `${visual}:component`))
        .toEqual(targetProtocol.objects.find(object => object.id === visual)!.representations
          .find(representation => representation.id === `${visual}:component`));
    }
    const start = sampleScanContainerMorph(morph, morph.startZoom);
    expect(start.session).toBe(morph.sourceSession);
    const middle = sampleScanContainerMorph(morph, (morph.startZoom + morph.fullZoom) / 2);
    expect(start.progress).toBe(0);
    expect(middle.progress).toBeGreaterThan(0);
    expect(middle.progress).toBeLessThan(1);
    const projection = semanticLensSessionProjectionOverride(morph.scene, middle.session)!;
    expect(projection.morph?.boundaryObjectId).toBe(morph.scene.projection!.semanticToVisualEntityId[morph.focusId]);
    expect(projection.morph!.objectIds.length).toBeGreaterThan(1);
    expect(sampleScanContainerMorph(morph, morph.fullZoom).session.settled.at(-1)?.targetId).toBe(morph.focusId);
    expect(source.protocolSnapshot).toBe(sourceProtocol);
  });

  it('reverses at the same zoom, holds still on settle, and preserves the owner screen center', () => {
    const { morph } = fixture();
    const zoom = (morph.startZoom + morph.fullZoom) / 2;
    const inward = sampleScanContainerMorph(morph, zoom);
    morph.progress = 1;
    const outward = sampleScanContainerMorph(morph, zoom);
    expect(outward.progress).toBe(inward.progress);
    expect(outward.session.active.phase).toBe('reversing');
    expect(sampleScanContainerMorph(morph, zoom).progress).toBe(outward.progress);
    const raw = { x: 17, y: 23, zoom };
    const center = (bounds: typeof morph.sourceBounds) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const from = center(morph.sourceBounds);
    const to = center(morph.targetBounds);
    const rendered = composeSemanticZoomCamera(raw, { ...morph, progress: inward.progress });
    const blended = { x: from.x + (to.x - from.x) * inward.progress, y: from.y + (to.y - from.y) * inward.progress };
    expect((blended.x - rendered.x) * zoom).toBeCloseTo((from.x - raw.x) * zoom);
    expect((blended.y - rendered.y) * zoom).toBeCloseTo((from.y - raw.y) * zoom);
    expect(rendered.zoom).toBe(zoom);
    expect(sampleScanContainerMorph(morph, morph.startZoom).progress).toBe(0);
  });

  it('keeps the complete L3 endpoint resident after completion, so a reverse wheel never adopts a tile-sized peer graph', () => {
    const { target, morph } = fixture();
    const terminal = sampleScanContainerMorph(morph, morph.fullZoom);
    const completePeers = target.entities.filter(entity => entity.parentId === morph.focusId && entity.detail === 'component');
    expect(completePeers.length).toBeGreaterThan(1);
    expect(terminal.progress).toBe(1);
    expect(scanContainerMorphOwnsSession(morph, terminal.session)).toBe(true);
  });

  it('suppresses an outgrown ancestor shell throughout expansion while retaining enclosing ancestors', () => {
    const { morph } = fixture();
    const ancestorId = morph.sourceSession.settled[0]!.targetId;
    const visualId = morph.scene.projection!.semanticToVisualEntityId[ancestorId];
    const bounds = morph.scene.projection!.boundsByEntityIdAndDetail;
    const focus = bounds[morph.focusId]!.component!;
    // A scoped file layout is independent of the ancestor's old L1 card.
    bounds[ancestorId] = { ...bounds[ancestorId], context: { x: focus.x, y: focus.y, width: 1, height: 1 } };
    const zoom = (morph.startZoom + morph.fullZoom) / 2;
    const inward = sampleScanContainerMorph(morph, zoom);
    const projection = semanticLensSessionProjectionOverride(morph.scene, inward.session)!;
    const shell = projection.objects.find(object => object.objectId === visualId)!;
    expect(shell).toMatchObject({ sourceOpacity: 0, targetOpacity: 0, targetPickable: false });
    expect(shell.targetRepresentationId).toBeUndefined();
    expect(shell.sourceOpacity! + (shell.targetOpacity! - shell.sourceOpacity!) * projection.progress)
      .toBe(0);
    morph.progress = 1;
    const outward = sampleScanContainerMorph(morph, zoom);
    expect(semanticLensSessionProjectionOverride(morph.scene, outward.session)).toEqual(projection);
    expect(semanticLensSessionProjectionOverride(morph.scene, morph.targetSession)!.objects
      .find(object => object.objectId === visualId)!.targetOpacity).toBe(0);
    expect(semanticLensSessionProjectionOverride(morph.scene, morph.sourceSession)!.objects
      .find(object => object.objectId === visualId)!.targetOpacity).toBe(1);
    bounds[ancestorId] = { ...bounds[ancestorId], context: {
      x: focus.x - 10, y: focus.y - 10, width: focus.width + 20, height: focus.height + 20,
    } };
    expect(semanticLensSessionProjectionOverride(morph.scene, morph.targetSession)!.objects
      .find(object => object.objectId === visualId)!.targetOpacity).toBe(.32);
  });

  it('hides obsolete outgoing L2 routes during the L2→L3 bridge without removing valid L3 internals', () => {
    const { morph } = fixture();
    const middle = sampleScanContainerMorph(morph, (morph.startZoom + morph.fullZoom) / 2);
    const projection = semanticLensSessionProjectionOverride(morph.scene, middle.session)!;
    const sourcePaths = morph.scene.projection!.projectedRelationsByDetail.container;
    const targetPathIds = new Set(morph.scene.projection!.projectedRelationsByDetail.component.map(path => path.id));
    const obsoleteOutgoingIds = sourcePaths
      .filter(path => (path.from === morph.focusId || path.to === morph.focusId) && !targetPathIds.has(path.id))
      .map(path => path.id);

    expect(obsoleteOutgoingIds.length).toBeGreaterThan(0);
    for (const id of obsoleteOutgoingIds) {
      expect(projection.paths.find(path => path.pathId === id)).toMatchObject({ sourceOpacity: 0, targetOpacity: 0 });
    }

    const validInternal = projection.paths.filter(path => !obsoleteOutgoingIds.includes(path.pathId) && path.targetOpacity > 0);
    expect(validInternal.length).toBeGreaterThan(0);
  });

  it.each([.25, .75])('pans without snapping a reveal at progress %s to another layout', fraction => {
    const { morph } = fixture();
    const zoom = morph.startZoom * (morph.fullZoom / morph.startZoom) ** fraction;
    const frame = sampleScanContainerMorph(morph, zoom);
    const selectedId = morph.sourceSession.settled[0]!.targetId;
    const camera = scanContainerMorphCamera(morph, frame.progress, { x: 20, y: 30, zoom });
    const projection = semanticLensSessionProjectionOverride(morph.scene, frame.session);
    for (const phase of ['revealing', 'reversing'] as const) {
      const session = { ...frame.session, active: { ...frame.session.active, phase } };
      const panned = semanticPanFocusPlan(morph.scene, session, selectedId,
        { ...camera, x: camera.x + 98, y: camera.y + 12 },
        { width: 749, height: 538 }, { top: 0, right: 0, bottom: 0, left: 0 }, 160);
      expect(panned.selectedId).toBe(selectedId);
      expect(panned.session).toBe(session);
      expect(semanticLensSessionProjectionOverride(morph.scene, panned.session)).toEqual(projection);
      // The next wheel burst starts from the translated camera without applying
      // the already-rendered structural offset a second time.
      morph.progress = frame.progress;
      morph.baselineProgress = frame.progress;
      const moved = { ...camera, x: camera.x + 98, y: camera.y + 12 };
      expect(scanContainerMorphCamera(morph, frame.progress, moved)).toEqual(moved);
    }
  });

  it('does not create an unfinishable morph at the zoom cap', () => {
    const { source, target } = fixture();
    expect(createScanContainerMorph(source, target, 'container:web-app', 32)).toBeUndefined();
  });

  it('does not double the structural camera offset when idle callbacks receive the adopted camera', () => {
    const { morph } = fixture();
    const raw = { x: 17, y: 23, zoom: 2.5 };
    const frame = sampleScanContainerMorph(morph, raw.zoom);
    const rendered = scanContainerMorphCamera(morph, frame.progress, raw);
    morph.progress = frame.progress;
    expect(scanContainerMorphCamera(morph, frame.progress, raw, rendered)).toEqual(rendered);
    expect(scanContainerMorphCamera(morph, frame.progress, rendered, rendered)).toEqual(rendered);
    morph.baselineProgress = frame.progress;
    expect(scanContainerMorphCamera(morph, frame.progress, rendered)).toEqual(rendered);
  });

  it('retains the L3 file geometry while revealing bounded L4 code peers, then contracts along the shifted leave curve with continuous camera compensation', () => {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const l2 = scan.createScene(scan.navigation.rootEntityId);
    const compiledL3 = scan.createScene('container:web-app', l2);
    const l3Bridge = createScanContainerMorph(l2, compiledL3, 'container:web-app', 2)!;
    const l3 = l3Bridge.scene;
    const file = l3.entities.find(entity => entity.parentId === 'container:web-app' && entity.detail === 'component');
    const sibling = l3.entities.find(entity => entity.parentId === 'container:web-app'
      && entity.detail === 'component' && entity.id !== file?.id);
    expect(file).toBeDefined();
    expect(sibling).toBeDefined();
    const l4 = scan.createScene(file!.id, l3);
    const sourceSession = l3Bridge.targetSession;
    const morph = createScanDetailMorph(l3, l4, file!.id, 'component', 'code', 7.72, sourceSession);
    expect(morph).toBeDefined();
    expect(morph!.sourceDetail).toBe('component');
    expect(morph!.targetDetail).toBe('code');
    expect(morph!.scene.projection!.entityIdsByDetail.component)
      .toEqual(l3.projection!.entityIdsByDetail.component);
    const sourceFrame = sampleScanContainerMorph(morph!, morph!.startZoom);
    expect(sourceFrame.session).toEqual(sourceSession);
    const sourceProjection = semanticLensSessionProjectionOverride(morph!.scene, sourceFrame.session)!;
    const siblingVisual = morph!.scene.projection!.semanticToVisualEntityId[sibling!.id];
    expect(sourceProjection.objects.find(object => object.objectId === siblingVisual))
      .toMatchObject({ sourceOpacity: 1, targetOpacity: 1 });
    const raw = { x: 464.903, y: -252.777, zoom: Math.sqrt(morph!.startZoom * morph!.fullZoom) };
    const middle = sampleScanContainerMorph(morph!, raw.zoom);
    const rendered = scanContainerMorphCamera(morph!, middle.progress, raw);
    const center = (bounds: { x: number; y: number; width: number; height: number }) => ({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    const from = center(morph!.sourceBounds);
    const to = center(morph!.targetBounds);
    const blended = { x: from.x + (to.x - from.x) * middle.progress, y: from.y + (to.y - from.y) * middle.progress };
    expect(rendered.zoom).toBe(raw.zoom);
    expect((blended.x - rendered.x) * raw.zoom).toBeCloseTo((from.x - raw.x) * raw.zoom, 8);
    expect((blended.y - rendered.y) * raw.zoom).toBeCloseTo((from.y - raw.y) * raw.zoom, 8);
    morph!.progress = 1;
    const reverse = sampleScanContainerMorph(morph!, raw.zoom);
    const leave = morph!.codeWindow!;
    const expectedLeave = Math.log(raw.zoom / leave.leaveStartZoom) / Math.log(leave.leaveFullZoom / leave.leaveStartZoom);
    expect(reverse.progress).toBeCloseTo(expectedLeave, 8);
    expect(reverse.progress).toBeGreaterThan(middle.progress);
    expect(reverse.session.active.phase).toBe('reversing');
    morph!.progress = reverse.progress;
    expect(sampleScanContainerMorph(morph!, raw.zoom).progress).toBe(reverse.progress);
    const reverseCamera = scanContainerMorphCamera(morph!, reverse.progress, raw);
    expect(reverseCamera.zoom).toBe(raw.zoom);
    expect(reverseCamera.x).toBeCloseTo(raw.x + (to.x - from.x) * reverse.progress, 8);
    expect(reverseCamera.y).toBeCloseTo(raw.y + (to.y - from.y) * reverse.progress, 8);
    const beyond = morph!.fullZoom * 1.2;
    expect(sampleScanContainerMorph(morph!, beyond, 0).progress).toBe(0);
    expect(sampleScanContainerMorph(morph!, beyond, .5).progress).toBe(.5);
    expect(sampleScanContainerMorph(morph!, beyond, 1).progress).toBe(1);
  });

  it('freezes scan code thresholds across delayed completion and retains continuous ownership through jitter', () => {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const l3 = scan.createScene('container:web-app');
    const file = l3.entities.find(entity => entity.parentId === 'container:web-app' && entity.detail === 'component')!;
    const l4 = scan.createScene(file.id, l3);
    const early = createScanDetailMorph(l3, l4, file.id, 'component', 'code', 5)!;
    const delayed = createScanDetailMorph(l3, l4, file.id, 'component', 'code', 13)!;
    expect([early.startZoom, early.fullZoom]).toEqual([delayed.startZoom, delayed.fullZoom]);
    expect(early.fullZoom).toBeLessThan(7.1);
    const restored = validateRestoredSemanticLensPath(l4, 'context', early.targetSession.settled.map(entry => entry.targetId), early.fullZoom);
    expect(restored.entries.at(-1)?.nextDetail).toBe('code');
    const authored = l4.projection!.semanticTransitionsByEntityId![file.id]!.code!;
    expect(authored.minZoom).toBe(early.startZoom);
    expect(authored.fullZoom).toBe(early.fullZoom);
    const bootstrap = scan.createScene(scan.navigation.rootEntityId);
    const cold = scan.createScene(file.id, bootstrap);
    expect(cold.projection!.semanticTransitionsByEntityId![file.id]!.code!.minZoom).toBe(early.startZoom);
    expect(cold.projection!.semanticTransitionsByEntityId![file.id]!.code!.fullZoom).toBe(early.fullZoom);
    const midpoint = Math.sqrt(early.startZoom * early.fullZoom);
    const entered = sampleScanContainerMorph(early, midpoint + 0.01);
    early.progress = entered.progress;
    expect(entered.progress).toBeGreaterThan(0.5);
    for (const zoom of [midpoint - 0.01, midpoint + 0.01, midpoint - 0.01]) {
      const sample = sampleScanContainerMorph(early, zoom);
      expect(sample.progress).toBe(entered.progress);
      early.progress = sample.progress;
    }
    const leaveMidpoint = Math.sqrt(early.codeWindow!.leaveStartZoom * early.codeWindow!.leaveFullZoom);
    expect(sampleScanContainerMorph(early, leaveMidpoint - 0.01).progress).toBeLessThan(0.5);
    expect(sampleScanContainerMorph(early, early.codeWindow!.leaveStartZoom).progress).toBe(0);
    expect(sampleScanContainerMorph(early, early.fullZoom).progress).toBe(1);
  });

  it('authors narrow safe-width LOD and cold restoration from the actual parent face, not a tiny overview preview', () => {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const l3 = scan.createScene('container:web-app', undefined, { scanCodeSafeWidth: 300 });
    const file = l3.entities.find(entity => entity.parentId === 'container:web-app' && entity.detail === 'component')!;
    const l4 = scan.createScene(file.id, l3, { scanCodeSafeWidth: 300 });
    const morph = createScanDetailMorph(l3, l4, file.id, 'component', 'code', 12)!;
    expect(morph.sourceBounds.width * morph.startZoom).toBeCloseTo(300 * .42 * 1.25, 8);
    expect(morph.sourceBounds.width * morph.fullZoom).toBeCloseTo(300 * .42 * 1.50, 8);
    const overview = scan.createScene(scan.navigation.rootEntityId);
    overview.projection!.boundsByEntityIdAndDetail[file.id] = { component: { x: 0, y: 0, width: 1, height: 1 } };
    const cold = scan.createScene(file.id, overview, { scanCodeSafeWidth: 300 });
    const authored = cold.projection!.semanticTransitionsByEntityId![file.id]!.code!;
    expect(authored.minZoom).toBe(morph.startZoom);
    expect(authored.fullZoom).toBe(morph.fullZoom);
    const ownCode = cold.entities.find(entity => entity.parentId === file.id && entity.detail === 'code')!.id;
    const visual = cold.projection!.semanticToVisualEntityId[ownCode];
    const representation = (cold.protocolSnapshot as SceneSnapshot).objects.find(object => object.id === visual)!.representations.find(rep => rep.id === `${visual}:code`)!;
    expect(representation.lod.minZoom).toBe(morph.startZoom);
    expect(representation.lod.fadeWidth).toBeCloseTo(morph.fullZoom - morph.startZoom, 8);
    const restored = validateRestoredSemanticLensPath(cold, 'context', morph.targetSession.settled.map(entry => entry.targetId), morph.fullZoom);
    expect(restored.entries.at(-1)?.nextDetail).toBe('code');
    expect(validateRestoredSemanticLensPath(cold, 'context', [...morph.targetSession.settled.map(entry => entry.targetId), 'component:unknown'], morph.fullZoom).truncated).toBe(true);
    expect(validateRestoredSemanticLensPath(cold, 'context', morph.targetSession.settled.map(entry => entry.targetId), morph.codeWindow!.leaveStartZoom - .01).entries.at(-1)?.nextDetail).not.toBe('code');
    const reverse = createScanReverseMorph(l3, cold, file.id, 'code')!;
    expect(reverse.codeWindow).toEqual(morph.codeWindow);
  });

  it('reconstructs a cold L4 reverse endpoint with the full parent file neighborhood', () => {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const l3 = scan.createScene('container:web-app');
    const file = l3.entities.find(entity => entity.parentId === 'container:web-app' && entity.detail === 'component')!;
    const cold = scan.createScene(file.id);
    expect(shouldStartScanContainerReverseMorph({
      direction: 'outward', currentDetail: 'code', currentRootId: file.id,
      viewRootId: scan.navigation.rootEntityId, activeTargetId: file.id,
    })).toBe(true);
    const morph = createScanReverseMorph(l3, cold, file.id, 'code')!;
    expect(morph).toBeDefined();
    expect(morph.progress).toBe(1);
    expect(morph.baselineProgress).toBe(1);
    expect(morph.scene.projection!.entityIdsByDetail.component).toEqual(l3.projection!.entityIdsByDetail.component);
    expect(morph.scene.projection!.entityIdsByDetail.code).toEqual(cold.projection!.entityIdsByDetail.code);
    const camera = { x: 12, y: 34, zoom: morph.fullZoom };
    expect(scanContainerMorphCamera(morph, 1, camera)).toEqual(camera);
    const middle = sampleScanContainerMorph(morph, Math.sqrt(morph.startZoom * morph.fullZoom));
    expect(middle.progress).toBeGreaterThan(0);
    expect(middle.progress).toBeLessThan(1);
    expect(middle.session.active.phase).toBe('reversing');
    expect(scanContainerMorphOwnsSession(morph, middle.session)).toBe(true);
    const end = sampleScanContainerMorph(morph, morph.codeWindow?.leaveStartZoom ?? morph.startZoom);
    expect(end.session).toEqual(morph.sourceSession);
    expect(end.progress).toBe(0);
    for (const arrivalZoom of [10, 7]) {
      const restored = createScanReverseMorph(l3, cold, file.id, 'code', arrivalZoom)!;
      expect(sampleScanContainerMorph(restored, arrivalZoom).progress).toBe(1);
      const firstWheel = sampleScanContainerMorph(restored, arrivalZoom / 1.037259);
      expect(firstWheel.progress).toBeGreaterThan(.9);
      // A deep saved camera remains at the complete endpoint until it reaches the fixed face window.
      expect(firstWheel.progress).toBe(1);
      expect(restored.startZoom).toBe(morph.startZoom);
      expect(restored.fullZoom).toBe(morph.fullZoom);
    }
  });

  it('does not create an L3→L4 bridge when the file has no code representation', () => {
    const { source, target } = fixture();
    expect(createScanDetailMorph(source, target, 'container:web-app', 'component', 'code', 7.72)).toBeUndefined();
  });

  it('relinquishes ownership to L4 instead of restoring the old container session on idle or reversal', () => {
    const { morph } = fixture();
    expect(scanContainerMorphOwnsSession(morph, morph.sourceSession)).toBe(true);
    expect(scanContainerMorphOwnsSession(morph, morph.targetSession)).toBe(true);
    const file = morph.scene.entities.find(entity => entity.parentId === morph.focusId && entity.detail === 'component')!;
    const deeper = { targetId: file.id, currentDetail: 'component' as const, nextDetail: 'code' as const };
    expect(scanContainerMorphOwnsSession(morph, {
      ...morph.targetSession, active: { ...deeper, phase: 'revealing', progress: 0.3, assistBlend: 0 },
    })).toBe(false);
    expect(scanContainerMorphOwnsSession(morph, {
      ...morph.targetSession, settled: [...morph.targetSession.settled, deeper],
    })).toBe(false);
  });
});

describe('retained morph source maps (CLA-401)', () => {
  it.each(['context', 'container', 'component'] as const)('maps only ids the merged scene holds when a code scene is left at %s', sourceDetail => {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const code = scan.createScene('component:web-navigation');
    const full = scan.createScene(scan.navigation.rootEntityId);
    const codeSymbol = demoSnapshot.entities.find(entity => entity.kind === 'code' && entity.parentId === 'component:web-navigation')!;
    // The case from production: a code symbol stays selected while the reader zooms out.
    const codeVisualId = code.projection!.semanticToVisualEntityId[codeSymbol.id]!;
    expect(codeVisualId).toBeDefined();
    // A large atlas compiles a bounded neighborhood: the coarser scene does not hold the
    // code objects at all. The demo fixture is small enough to keep them, so remove them.
    const codeVisualIds = new Set(demoSnapshot.entities.filter(entity => entity.kind === 'code')
      .map(entity => full.projection!.semanticToVisualEntityId[entity.id]).filter((id): id is string => Boolean(id)));
    const fullProtocol = full.protocolSnapshot as SceneSnapshot;
    const target = {
      ...full,
      protocolSnapshot: { ...fullProtocol, objects: fullProtocol.objects.filter(object => !codeVisualIds.has(object.id)) },
      projection: {
        ...full.projection!,
        semanticToVisualEntityId: Object.fromEntries(Object.entries(full.projection!.semanticToVisualEntityId).filter(([, id]) => !codeVisualIds.has(id))),
        visualToSemanticEntityId: Object.fromEntries(Object.entries(full.projection!.visualToSemanticEntityId).filter(([id]) => !codeVisualIds.has(id))),
      },
    };
    const merged = retainScanDetailMorphSource(code, target, sourceDetail);
    const protocol = merged.protocolSnapshot as SceneSnapshot;
    const objectIds = new Set(protocol.objects.map(object => object.id));
    const pathIds = new Set(protocol.paths.map(path => path.id));
    const projection = merged.projection!;
    expect(Object.values(projection.semanticToVisualEntityId).filter(id => !objectIds.has(id))).toEqual([]);
    expect(Object.keys(projection.visualToSemanticEntityId).filter(id => !objectIds.has(id))).toEqual([]);
    expect(Object.values(projection.semanticToVisualRelationIds).flat().filter(id => !pathIds.has(id))).toEqual([]);
    expect(Object.keys(projection.visualToSemanticRelationIds).filter(id => !pathIds.has(id))).toEqual([]);
    expect(projection.semanticToVisualEntityId[codeSymbol.id]).toBeUndefined();
    // Retained source objects keep their mapping.
    expect(Object.keys(projection.semanticToVisualEntityId).length).toBeGreaterThanOrEqual(Object.keys(target.projection!.semanticToVisualEntityId).length);
  });
});

describe('container expansion window (CLA-404)', () => {
  function expansion(startZoom: number, safeWidth?: number) {
    const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
    const source = scan.createScene(scan.navigation.rootEntityId);
    const target = scan.createScene('container:web-app', source);
    const morph = createScanContainerMorph(source, target, 'container:web-app', startZoom, safeWidth)!;
    const arms = target.entities.filter(entity => entity.parentId === 'container:web-app')
      .map(entity => scanCodeRevealWindow(semanticBounds(morph.scene, entity.id, 'component'), safeWidth)!.armZoom);
    return { morph, earliestArm: Math.min(...arms) };
  }

  it('ends at the earliest file arm zoom when the expansion starts well below it', () => {
    const { morph, earliestArm } = expansion(3);
    expect(earliestArm).toBeGreaterThan(3 * SCAN_CONTAINER_MORPH_MIN_SPAN);
    expect(earliestArm).toBeLessThan(3 * 1.65);
    expect(morph.fullZoom).toBeCloseTo(earliestArm, 8);
    expect(sampleScanContainerMorph(morph, earliestArm).progress).toBe(1);
  });

  it('keeps a minimum span when the expansion starts at or past the arm zoom', () => {
    const { earliestArm } = expansion(2);
    const { morph } = expansion(earliestArm * 1.1);
    expect(morph.fullZoom).toBeCloseTo(earliestArm * 1.1 * SCAN_CONTAINER_MORPH_MIN_SPAN, 8);
    expect(morph.fullZoom).toBeLessThan(earliestArm * 1.1 * 1.65);
  });

  it('never lengthens an expansion that already ends before the arm zoom', () => {
    const { morph, earliestArm } = expansion(1);
    expect(morph.fullZoom).toBeLessThan(earliestArm);
    expect(morph.fullZoom).toBeGreaterThanOrEqual(1 * 1.65);
  });

  it('measures the arm zoom in the given safe width', () => {
    const wide = expansion(1.2);
    const narrow = expansion(1.2, 390);
    expect(narrow.earliestArm).toBeLessThan(wide.earliestArm);
    expect(narrow.morph.fullZoom).toBeLessThanOrEqual(wide.morph.fullZoom);
  });
});
