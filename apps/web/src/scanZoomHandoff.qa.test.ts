import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cameraWorldRect,
  expandRectByTileRing,
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import {
  createC4Scene,
  createGoldenC4Scene,
  scanDeeperBandHasPeerCards,
  scanDrillDeeperDetail,
  scanPeerContainerIds,
  scanWindowedCompileDropsPeerGraph,
  scanZoomCompileHandoff,
  scanZoomEntityUnderPointer,
  scanZoomHandoffPreferredId,
  semanticBounds,
} from './renderer/goldenC4Scene';
import { scanCompileFocusForBand, scanEntityIsInSubtree } from './renderer/lazyBandCompile';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES, SCAN_RESIDENT_NODES_PER_BAND } from './renderer/scanFixture';
import { semanticLensSessionDetail } from './semantic/semanticLens';
import {
  frameCodePeerArrivalCamera,
  frameVisibleProjection,
  scanZoomHandoffCamera,
  semanticLevelSession,
} from './semantic/semanticLensEngine';
import { getLevel } from './App';
import type { AtlasScene, SceneEntity } from './renderer/types';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const handleSemanticZoom = sliceBetween(app, 'function handleSemanticZoom(', 'function semanticZoomControl(', 'handleSemanticZoom');
const settleCamera = sliceBetween(app, 'function settleCamera(', 'function flushNavigation(', 'settleCamera');
const applyScanZoomHandoff = sliceBetween(app, 'function applyScanZoomHandoff(', 'function maybeScanZoomHandoff(', 'applyScanZoomHandoff');
const maybeScanZoomHandoff = sliceBetween(app, 'function maybeScanZoomHandoff(', 'function prefetchCommittedBox(', 'maybeScanZoomHandoff');
const refreshViewportNeighborhood = sliceBetween(app, 'function refreshViewportNeighborhood(', 'function applyScanZoomHandoff(', 'refreshViewportNeighborhood');

const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

describe('CLA-104: continuous zoom L2→L3 hands off the focused container graph', () => {
  it('drives wheel/pinch through the Open-inside compile-focus seam, not a hang-guard raise', () => {
    expect(handleSemanticZoom).toContain('maybeScanZoomHandoff(');
    expect(handleSemanticZoom).toContain('sample.pointer');
    expect(app).toContain('function maybeScanZoomHandoff(');
    expect(maybeScanZoomHandoff).toContain('scanZoomHandoffPreferredId(');
    expect(maybeScanZoomHandoff).toContain('inspectorSelectionRef.current ?? selected.id');
    expect(app).toContain('const liveCamera = renderedCameraRef.current');
    expect(maybeScanZoomHandoff).toContain('await composeScanSceneAsync(handoff.compileFocus, sourceScene, request.signal)');
    expect(app).toContain('applyScanZoomHandoff(still, liveCamera, livePreferredId, prepared)');
    expect(maybeScanZoomHandoff).toContain('if (!owns()) return;');
    expect(refreshViewportNeighborhood).toContain('composeScanSceneAsync(compileFocus, sourceScene, request.signal, next)');
    expect(refreshViewportNeighborhood).toContain('viewportRequestedTileRef.current !== tileKey');
    expect(refreshViewportNeighborhood).not.toContain('updateCamera(');
    expect(refreshViewportNeighborhood).toContain('if (!scanFixture || zoomHandoffInflightRef.current) return;');
    expect(applyScanZoomHandoff).not.toContain('composeScene(');
    expect(settleCamera).toContain('maybeScanZoomHandoff(');
    expect(settleCamera).toContain('scanZoomPointerRef.current');
    expect(app).toContain('function applyScanZoomHandoff(');
    expect(app).toContain('scanZoomCompileHandoff(');
    expect(app).toContain('scanCompileFocusForBand(');
    expect(applyScanZoomHandoff).toContain('semanticLevelSession(nextScene, handoff.detail, preferredIds)');
    expect(applyScanZoomHandoff).toContain('scanZoomHandoffCamera(');
    expect(applyScanZoomHandoff).toContain('scanDeeperBandHasPeerCards(');
    expect(applyScanZoomHandoff).toContain('scanZoomAdoptRawRef.current = nextCamera');
    expect(applyScanZoomHandoff).not.toContain('frameProjectionScope(');
    expect(app).toContain('consumeScanZoomAdoptRaw');
    expect(app).toContain('scanZoomAdoptRawRef={scanZoomAdoptRawRef}');
    expect(applyScanZoomHandoff).toContain("historyControllerRef.current?.replace(navigation)");
    expect(refreshViewportNeighborhood).toContain('semanticLensSessionDetail(semanticLensSessionRef.current)');
    expect(refreshViewportNeighborhood).toContain('scanZoomCompileHandoff(');
    expect(refreshViewportNeighborhood).toContain('handoff?.compileFocus ?? currentFocus');
    expect(refreshViewportNeighborhood).toContain('scanWindowedCompileDropsPeerGraph(');
    expect(refreshViewportNeighborhood).toContain('scanContainerMorphOwnsSession(containerMorph, semanticLensSessionRef.current)');
    expect(refreshViewportNeighborhood).not.toContain('semanticLensSessionRef.current.baseDetail');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
    expect(app).not.toContain('SCAN_BAND_DEPTH_MIN_ENTITIES = 4000');
    expect(handleSemanticZoom).toContain('const dormant = { ...containerMorph.scene, rootEntityId }');
    expect(handleSemanticZoom).toContain('const resumed = { ...containerMorph.scene, rootEntityId: containerMorph.focusId }');
    expect(handleSemanticZoom).toContain('scanZoomEntityUnderPointer(dormantBridge.scene, sample.camera, viewport, sample.pointer, dormantBridge.sourceDetail)');
    expect(handleSemanticZoom).toContain('const hasLeftSourceBand = dormantBridge && sourceDetailIndex > 0');
    expect(handleSemanticZoom).toContain("sample.direction === 'outward' && hasLeftSourceBand");
    expect(handleSemanticZoom).toContain('containerMorph.baselineProgress = 0;');
    expect(handleSemanticZoom).not.toContain('scanContainerMorphRef.current = undefined;\n          sceneRef.current = containerMorph.sourceScene');
  });

  it('L1→L2 zoom stays on the system compile; L2→L3 into web-app compiles that file graph', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(l2Scene.rootEntityId).toBe('system:okie');
    expect((l2Scene.projection?.entityIdsByDetail.container ?? []).length).toBeGreaterThan(1);
    expect((l2Scene.projection?.entityIdsByDetail.component ?? [])
      .filter(id => l2Scene.entities.find(entity => entity.id === id)?.detail === 'component').length).toBe(0);

    expect(getLevel(2.10)).toBe(1);
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'container',
    )).toBeUndefined();

    expect(getLevel(4)).toBe(2);
    const container = l2Scene.entities.find(entity => entity.id === 'container:web-app');
    expect(container).toBeDefined();
    expect(scanDrillDeeperDetail(l2Scene, container!, fixture.snapshot)).toBe('component');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    const componentIds = l3.projection?.entityIdsByDetail.component ?? [];
    expect(componentIds.length).toBeGreaterThan(0);
    expect(l3.entities.some(entity => entity.detail === 'component' && entity.parentId === 'container:web-app')).toBe(true);
    expect(componentIds).not.toEqual(l2Scene.projection?.entityIdsByDetail.container);

    const session = semanticLevelSession(l3, 'component', ['container:web-app']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const selected = l3.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const rows = explorerEntitiesForView(l3, {
      detail: 'component',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
    });
    expect(rows.some(row => row.detail === 'component')).toBe(true);

    const fit = frameVisibleProjection(l3, componentIds, 'component', viewport, chromeSafeArea);
    expect(fit).toBeDefined();
    expect(fit!.zoom).toBeGreaterThan(3);
    expect(scanZoomCompileHandoff(
      l3,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toBeUndefined();
  });

  it('keeps the L3 file graph when the camera is still on the reserved shell interior', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    await fixture.ensureNeighborhood('container:web-app');
    const l3 = fixture.createScene('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);

    const shell = semanticBounds(l3, 'container:web-app', 'component');
    expect(shell).toBeDefined();
    const hollowCamera = { x: 1_000_000, y: 1_000_000, zoom: 4.96 };
    const windowedHollow = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(hollowCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanWindowedCompileDropsPeerGraph(l3, windowedHollow, 'container:web-app', 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(windowedHollow, 'container:web-app', 'component')).toBe(false);

    const handoffCamera = scanZoomHandoffCamera(
      hollowCamera,
      l3,
      'container:web-app',
      'component',
      viewport,
      chromeSafeArea,
      undefined,
      shell,
    );
    expect(handoffCamera.zoom).toBe(hollowCamera.zoom);
    expect(Math.hypot(handoffCamera.x - hollowCamera.x, handoffCamera.y - hollowCamera.y)).toBeGreaterThan(100);
    const windowedPeers = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(handoffCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanDeeperBandHasPeerCards(windowedPeers, 'container:web-app', 'component')).toBe(true);
    expect(scanWindowedCompileDropsPeerGraph(l3, windowedPeers, 'container:web-app', 'component')).toBe(false);

    const session = semanticLevelSession(windowedPeers, 'component', ['container:web-app']);
    const selected = windowedPeers.entities.find(entity => entity.id === 'container:web-app')!;
    const rows = explorerEntitiesForView(windowedPeers, {
      detail: 'component',
      selected,
      settledTargetIds: session.settled.map(entry => entry.targetId),
    });
    expect(rows.some(row => row.detail === 'component')).toBe(true);

    // A continuous band handoff preserves the semantic anchor under the
    // pointer; peer framing is only for handoffs with no outgoing bound.
    const previousBounds = { x: 1_000, y: 600, width: 240, height: 120 };
    const anchoredCamera = { x: 1_130, y: 600, zoom: 4.96 };
    const continuous = scanZoomHandoffCamera(
      anchoredCamera,
      l3,
      'container:web-app',
      'component',
      viewport,
      chromeSafeArea,
      previousBounds,
      shell,
    );
    const previousCenter = { x: previousBounds.x + previousBounds.width / 2, y: previousBounds.y + previousBounds.height / 2 };
    const targetCenter = { x: shell!.x + shell!.width / 2, y: shell!.y + shell!.height / 2 };
    expect((previousCenter.x - anchoredCamera.x) * anchoredCamera.zoom)
      .toBeCloseTo((targetCenter.x - continuous.x) * continuous.zoom, 8);
    expect((previousCenter.y - anchoredCamera.y) * anchoredCamera.zoom)
      .toBeCloseTo((targetCenter.y - continuous.y) * continuous.zoom, 8);
    const offscreen = scanZoomHandoffCamera(
      { x: previousCenter.x - 1_000, y: previousCenter.y - 1_000, zoom: 4.96 },
      l3,
      'container:web-app',
      'component',
      viewport,
      chromeSafeArea,
      previousBounds,
      shell,
    );
    expect((previousCenter.x - (previousCenter.x - 1_000)) * 4.96)
      .toBeCloseTo((targetCenter.x - offscreen.x) * offscreen.zoom, 8);
    // L4 never maps the selected L3-card centre into its nested layout. When
    // a scoped scene has no resident code peers, it leaves the camera alone;
    // when peers exist, scanZoomHandoffCamera delegates to their peer framer.
    const codePeer = frameCodePeerArrivalCamera(l3, 'container:web-app', viewport, chromeSafeArea);
    const codeArrival = scanZoomHandoffCamera(
      anchoredCamera, l3, 'container:web-app', 'code', viewport, chromeSafeArea,
      previousBounds, shell,
    );
    expect(codeArrival).toEqual(codePeer
      ? codePeer
      : anchoredCamera);
    const fit = frameVisibleProjection(
      windowedPeers,
      windowedPeers.projection?.entityIdsByDetail.component ?? [],
      'component',
      viewport,
      chromeSafeArea,
    );
    expect(fit).toBeDefined();
    expect(fit!.zoom).toBeGreaterThan(3);
  });

  it('scanWindowedCompileDropsPeerGraph is true only when a windowed compile removes L3/L4 peers', () => {
    const bounds = { x: 0, y: 0, width: 1, height: 1 };
    const withPeers = {
      id: 's',
      title: '',
      subtitle: '',
      rootEntityId: 'container:c',
      entities: [
        { id: 'container:c', name: 'c', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
        { id: 'component:x', parentId: 'container:c', name: 'x', kind: 'component', detail: 'component', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
      ],
      relations: [],
      regions: [],
      projection: {
        boundsByEntityIdAndDetail: {
          'container:c': { container: bounds, component: bounds },
          'component:x': { component: bounds },
        },
        entityIdsByDetail: {
          context: [],
          container: ['container:c'],
          component: ['component:x'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    const hollow = {
      ...withPeers,
      entities: withPeers.entities.slice(0, 1) as SceneEntity[],
      projection: {
        ...withPeers.projection,
        entityIdsByDetail: {
          context: [],
          container: ['container:c'],
          component: ['container:c'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    expect(scanWindowedCompileDropsPeerGraph(withPeers, hollow, 'container:c', 'component')).toBe(true);
    expect(scanWindowedCompileDropsPeerGraph(withPeers, withPeers, 'container:c', 'component')).toBe(false);
    expect(scanWindowedCompileDropsPeerGraph(withPeers, hollow, 'container:c', 'container')).toBe(true);
  });
});

describe('CLA-124: L4 arrival frames selected-file symbols before contextual ghosts', () => {
  it('places an owned code card inside the safe viewport', () => {
    const scene = createGoldenC4Scene();
    const fileId = 'component:model-normalized';
    const camera = frameCodePeerArrivalCamera(scene, fileId, viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    const ownedCode = scene.entities.filter(entity => entity.detail === 'code' && entity.parentId === fileId);
    expect(ownedCode.length).toBeGreaterThan(0);
    const visible = ownedCode.some(entity => {
      const bounds = scene.projection!.boundsByEntityIdAndDetail[entity.id]?.code!;
      const centerX = (bounds.x + bounds.width / 2 - camera!.x) * camera!.zoom + viewport.width / 2;
      const centerY = (bounds.y + bounds.height / 2 - camera!.y) * camera!.zoom + viewport.height / 2;
      return centerX >= chromeSafeArea.left && centerX <= viewport.width - chromeSafeArea.right
        && centerY >= chromeSafeArea.top && centerY <= viewport.height - chromeSafeArea.bottom;
    });
    expect(visible).toBe(true);
  });
});

describe('CLA-105: pointer-centric L2→L3 handoff (no black void)', () => {
  it('wheels into the container under the pointer when inspector selection is the system root', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const webApp = semanticBounds(l2Scene, 'container:web-app', 'container');
    expect(webApp).toBeDefined();
    const camera = {
      x: webApp!.x + webApp!.width / 2,
      y: webApp!.y + webApp!.height / 2,
      zoom: 4,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };

    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'system:okie',
      fixture.navigation.rootEntityId,
      'component',
    )).toBeUndefined();
    expect(scanZoomEntityUnderPointer(l2Scene, camera, viewport, pointer, 'container'))
      .toBe('container:web-app');

    const preferred = scanZoomHandoffPreferredId(
      l2Scene,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      'component',
      l2Scene.rootEntityId ?? fixture.navigation.rootEntityId,
      camera,
      viewport,
      pointer,
      'container',
      'system:okie',
    );
    expect(preferred).toBe('container:web-app');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      preferred,
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

    await fixture.ensureNeighborhood('container:web-app');
    const l3 = fixture.createScene('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);
    expect((l3.projection?.entityIdsByDetail.component ?? []).length).toBeGreaterThan(0);
  });

  it('keeps the selected-container CLA-104 path when the pointer misses every card', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const miss = { x: 1_000_000, y: 1_000_000, zoom: 4 };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    expect(scanZoomEntityUnderPointer(l2Scene, miss, viewport, pointer, 'container')).toBeUndefined();
    const preferred = scanZoomHandoffPreferredId(
      l2Scene,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      'component',
      l2Scene.rootEntityId ?? fixture.navigation.rootEntityId,
      miss,
      viewport,
      pointer,
      'container',
      'container:web-app',
    );
    expect(preferred).toBe('container:web-app');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      preferred,
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
  });
});

describe('CLA-106: L2→L3 handoff keeps peer containers (no pan into void)', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('Open inside / wheel L3 compile keeps sibling containers in distinct world space', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const l2Peers = (l2Scene.projection?.entityIdsByDetail.container ?? [])
      .filter(id => id !== 'system:okie' && id !== 'container:web-app');
    expect(l2Peers.length).toBeGreaterThan(1);

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);

    const peers = scanPeerContainerIds(l3, 'container:web-app');
    expect(peers).toEqual(expect.arrayContaining(['container:architecture-model', 'container:scene-compiler']));
    expect(peers.some(id => l2Peers.includes(id))).toBe(true);

    const focusBounds = semanticBounds(l3, 'container:web-app', 'component')
      ?? semanticBounds(l3, 'container:web-app', 'container');
    expect(focusBounds).toBeDefined();
    const peerBounds = peers.map(id => ({
      id,
      bounds: semanticBounds(l3, id, 'component') ?? semanticBounds(l3, id, 'container'),
    }));
    expect(peerBounds.every(entry => entry.bounds)).toBe(true);
    expect(peerBounds.some(entry => (
      entry.bounds!.x !== focusBounds!.x
      || entry.bounds!.y !== focusBounds!.y
      || entry.bounds!.width !== focusBounds!.width
      || entry.bounds!.height !== focusBounds!.height
    ))).toBe(true);

    const union = peerBounds.reduce((acc, entry) => {
      const box = entry.bounds!;
      const x = Math.min(acc.x, box.x);
      const y = Math.min(acc.y, box.y);
      const right = Math.max(acc.x + acc.width, box.x + box.width);
      const bottom = Math.max(acc.y + acc.height, box.y + box.height);
      return { x, y, width: right - x, height: bottom - y };
    }, { ...focusBounds! });
    expect(union.width * union.height).toBeGreaterThan(focusBounds!.width * focusBounds!.height);

    expect(l3.entities.some(entity =>
      entity.parentId === 'container:architecture-model' && entity.detail === 'component',
    )).toBe(false);

    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({ detail: 'component', compileFocus: 'container:web-app' });
  });

  it('windowed L3 compile still keeps a peer container outside the focused interior', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    await fixture.ensureNeighborhood('container:web-app');
    const l3 = fixture.createScene('container:web-app');
    const focusBounds = semanticBounds(l3, 'container:web-app', 'component')!;
    const interiorCamera = {
      x: focusBounds.x + focusBounds.width / 2,
      y: focusBounds.y + focusBounds.height / 2,
      zoom: 4,
    };
    const windowed = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(interiorCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanDeeperBandHasPeerCards(windowed, 'container:web-app', 'component')).toBe(true);
    expect(scanPeerContainerIds(windowed, 'container:web-app').length).toBeGreaterThan(0);
    expect(scanWindowedCompileDropsPeerGraph(l3, windowed, 'container:web-app', 'component')).toBe(false);
  });
});

describe('CLA-107: small-repo L2 still pre-places landmarks; CLA-117 wheel re-roots fat shells', () => {
  it('rail/pan still route through scanZoomCompileHandoff (CLA-117 re-roots L2 shells)', () => {
    const selectLevelLoaded = sliceBetween(app, 'function selectLevelLoaded(', 'function openInside(', 'selectLevelLoaded');
    expect(selectLevelLoaded).toContain('scanZoomCompileHandoff(scene, activeSnapshot, selected.id, viewRootId, detail, currentFocus)');
    expect(selectLevelLoaded).toContain('handoff?.compileFocus ?? currentFocus');
    expect(refreshViewportNeighborhood).toContain('handoff?.compileFocus ?? currentFocus');
  });

  it('opt-in L1 packet still pre-places L3 pills; L2→L3 wheel re-roots web-app', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const sliceOptions = neighborhoodSliceOptionsForFocus(snapshot, 'system:okie');
    expect(sliceOptions).toEqual({ maxBand: 'code' });
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        {
          focusEntityId: focus || 'system:okie',
          ...neighborhoodSliceOptionsForFocus(snapshot, focus || 'system:okie'),
        },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, {
      focusEntityId: 'system:okie',
      ...sliceOptions,
    });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2 = fixture.createScene(fixture.navigation.rootEntityId);
    expect(l2.rootEntityId).toBe('system:okie');
    expect((l2.projection?.entityIdsByDetail.component ?? [])
      .filter(id => l2.entities.find(entity => entity.id === id)?.detail === 'component').length).toBeGreaterThan(0);

    const webApp = semanticBounds(l2, 'container:web-app', 'container');
    expect(webApp).toBeDefined();
    const camera = {
      x: webApp!.x + webApp!.width / 2,
      y: webApp!.y + webApp!.height / 2,
      zoom: 4,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    expect(scanZoomEntityUnderPointer(l2, camera, viewport, pointer, 'container'))
      .toBe('container:web-app');

    expect(getLevel(2.10)).toBe(1);
    expect(getLevel(4)).toBe(2);
    expect(scanZoomCompileHandoff(
      l2,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'container',
    )).toBeUndefined();
    expect(scanZoomCompileHandoff(
      l2,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    expect(scanZoomCompileHandoff(
      l2,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'code',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    expect(scanZoomCompileHandoff(
      l2,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      fixture.navigation.rootEntityId,
      'code',
    )).toBeUndefined();

    const preferred = scanZoomHandoffPreferredId(
      l2,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      'component',
      l2.rootEntityId ?? fixture.navigation.rootEntityId,
      camera,
      viewport,
      pointer,
      'container',
      'system:okie',
    );
    expect(preferred).toBe('container:web-app');
    expect(scanZoomCompileHandoff(
      l2,
      fixture.snapshot,
      preferred,
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

    const container = l2.entities.find(entity => entity.id === 'container:web-app');
    expect(container).toBeDefined();
    expect(scanDrillDeeperDetail(l2, container!, fixture.snapshot)).toBe('component');

    const session = semanticLevelSession(l2, 'component', ['container:web-app']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const rows = explorerEntitiesForView(l2, {
      detail: 'component',
      selected: container!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
    });
    expect(rows.some(row => row.detail === 'component')).toBe(true);

    await fixture.ensureNeighborhood('container:web-app');
    const opened = fixture.createScene('container:web-app');
    expect(scanZoomCompileHandoff(
      opened,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'container',
    )).toEqual({
      detail: 'container',
      compileFocus: 'system:okie',
    });
  });
});

describe('CLA-117: L2→L3 zoom handoff for fat containers with resident pills', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
    expect(applyScanZoomHandoff).toContain('scanDeeperBandHasPeerCards(');
    expect(maybeScanZoomHandoff).toContain('scanZoomCompileHandoff(');
  });

  it('wheels into @okie/web past L2→L3 even when L3 pills already sit in the L2 shell', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        {
          focusEntityId: focus || 'system:okie',
          ...neighborhoodSliceOptionsForFocus(snapshot, focus || 'system:okie'),
        },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, {
      focusEntityId: 'system:okie',
      ...neighborhoodSliceOptionsForFocus(snapshot, 'system:okie'),
    });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const viewRoot = fixture.navigation.rootEntityId;
    const l2 = fixture.createScene(viewRoot);
    expect(l2.rootEntityId).toBe(viewRoot);
    expect(scanDeeperBandHasPeerCards(l2, viewRoot, 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(l2, 'container:web-app', 'component')).toBe(true);

    const pill = l2.entities.find(entity =>
      entity.parentId === 'container:web-app' && entity.detail === 'component');
    expect(pill).toBeDefined();
    expect(l2.projection?.boundsByEntityIdAndDetail[pill!.id]?.component).toBeDefined();

    expect(getLevel(3.35)).toBe(2);
    expect(scanZoomCompileHandoff(l2, fixture.snapshot, 'container:web-app', viewRoot, 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    expect(scanZoomCompileHandoff(l2, fixture.snapshot, 'container:web-app', viewRoot, 'code')).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

    const web = l2.entities.find(entity => entity.id === 'container:web-app')!;
    expect(scanDrillDeeperDetail(l2, web, fixture.snapshot)).toBe('component');

    await fixture.ensureNeighborhood('container:web-app');
    const l3 = fixture.createScene('container:web-app');
    expect(l3.rootEntityId).toBe('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);
    const card = l3.entities.find(entity => entity.id === pill!.id);
    expect(card).toBeDefined();
    expect(card!.detail).toBe('component');
    expect(l3.projection?.boundsByEntityIdAndDetail[card!.id]?.component).toBeDefined();

    expect(scanZoomCompileHandoff(l3, fixture.snapshot, 'container:web-app', viewRoot, 'component')).toBeUndefined();
    expect(scanZoomCompileHandoff(l3, fixture.snapshot, 'container:web-app', viewRoot, 'container')).toEqual({
      detail: 'container',
      compileFocus: viewRoot,
    });
  });

  it('hands off fat web and server packages from an L2 shell packed with resident pills', () => {
    const entities: ArchitectureEntity[] = [
      { id: 'system:okie', kind: 'softwareSystem', name: 'Okie', sourceRefs: [] },
      { id: 'container:apps-web', kind: 'container', parentId: 'system:okie', name: '@okie/web', sourceRefs: [] },
      { id: 'container:apps-server', kind: 'container', parentId: 'system:okie', name: '@okie/server', sourceRefs: [] },
    ];
    for (const [containerId, prefix] of [
      ['container:apps-web', 'web'],
      ['container:apps-server', 'server'],
    ] as const) {
      for (let index = 0; index < 24; index += 1) {
        entities.push({
          id: `component:${prefix}-${index}`,
          kind: 'component',
          parentId: containerId,
          name: `${prefix}-${index}.ts`,
          sourceRefs: [],
        });
      }
    }
    const snapshot: ArchitectureSnapshot = {
      schemaVersion: 1,
      id: 'snapshot:cla117',
      repositoryId: 'repo:cla117',
      commitSha: 'a'.repeat(40),
      generatedAt: '2026-01-01T00:00:00.000Z',
      entities,
      relations: [],
    };
    const l2 = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
    expect(l2.rootEntityId).toBe('system:okie');
    expect(scanDeeperBandHasPeerCards(l2, 'system:okie', 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(l2, 'container:apps-web', 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(l2, 'container:apps-server', 'component')).toBe(true);

    const webPill = l2.entities.find(entity =>
      entity.parentId === 'container:apps-web' && entity.detail === 'component');
    const webPillBounds = l2.projection?.boundsByEntityIdAndDetail[webPill!.id]?.component;
    expect(webPillBounds).toBeDefined();

    expect(scanZoomCompileHandoff(l2, snapshot, 'container:apps-web', 'system:okie', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:apps-web',
    });
    expect(scanZoomCompileHandoff(l2, snapshot, 'container:apps-server', 'system:okie', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:apps-server',
    });
    expect(scanZoomCompileHandoff(l2, snapshot, 'system:okie', 'system:okie', 'component')).toBeUndefined();

    const l3Web = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'container:apps-web',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'component',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
    });
    expect(l3Web.rootEntityId).toBe('container:apps-web');
    const webCard = l3Web.entities.find(entity =>
      entity.parentId === 'container:apps-web' && entity.detail === 'component');
    const webCardBounds = l3Web.projection?.boundsByEntityIdAndDetail[webCard!.id]?.component;
    expect(webCardBounds).toBeDefined();
    expect(webCardBounds!.width * webCardBounds!.height).toBeGreaterThan(webPillBounds!.width * webPillBounds!.height);
    expect(scanZoomCompileHandoff(l3Web, snapshot, 'container:apps-web', 'system:okie', 'component')).toBeUndefined();
    expect(scanDrillDeeperDetail(l2, l2.entities.find(entity => entity.id === 'container:apps-web')!, snapshot))
      .toBe('component');
  });
});

function fatWebServerSnapshot(): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:okie', kind: 'softwareSystem', name: 'Okie', sourceRefs: [] },
    { id: 'container:apps-web', kind: 'container', parentId: 'system:okie', name: '@okie/web', sourceRefs: [] },
    { id: 'container:apps-server', kind: 'container', parentId: 'system:okie', name: '@okie/server', sourceRefs: [] },
    {
      id: 'component:apps-web-src-ask-ask-atlas-ts',
      kind: 'component',
      parentId: 'container:apps-web',
      name: 'askAtlas.ts',
      sourceRefs: [],
    },
    {
      id: 'component:apps-web-api-oembed-ts',
      kind: 'component',
      parentId: 'container:apps-web',
      name: 'oembed.ts',
      sourceRefs: [],
    },
    {
      id: 'component:apps-server-src-enrichment-ts',
      kind: 'component',
      parentId: 'container:apps-server',
      name: 'enrichment.ts',
      sourceRefs: [],
    },
    {
      id: 'component:apps-server-src-github-access-ts',
      kind: 'component',
      parentId: 'container:apps-server',
      name: 'githubAccess.ts',
      sourceRefs: [],
    },
  ];
  for (const [containerId, prefix] of [
    ['container:apps-web', 'web'],
    ['container:apps-server', 'server'],
  ] as const) {
    for (let index = 0; index < 24; index += 1) {
      entities.push({
        id: `component:${prefix}-${index}`,
        kind: 'component',
        parentId: containerId,
        name: `${prefix}-${index}.ts`,
        sourceRefs: [],
      });
    }
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla122',
    repositoryId: 'repo:cla122',
    commitSha: 'b'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function l3ContainerScene(snapshot: ArchitectureSnapshot, focusEntityId: string): AtlasScene {
  return createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: 'system:okie',
    focusEntityId,
    familyId: 'f',
    sceneId: 's',
    title: 't',
    subtitle: 's',
    frozenRevision: 'c',
    maxBand: 'component',
    maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
  });
}

function pointerAtWorld(
  camera: { x: number; y: number; zoom: number },
  worldX: number,
  worldY: number,
) {
  return {
    x: viewport.width / 2 + (worldX - camera.x) * camera.zoom,
    y: viewport.height / 2 + (worldY - camera.y) * camera.zoom,
  };
}

describe('CLA-122: L3→L4 wheel stays inside the opened container', () => {
  const viewRoot = 'system:okie';
  const webFile = 'component:apps-web-src-ask-ask-atlas-ts';
  const serverFile = 'component:apps-server-src-enrichment-ts';
  const camera = { x: 100, y: 80, zoom: 8.6 };

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('from server L3, pointer over a web peer shell does not re-root into a web file', () => {
    const snapshot = fatWebServerSnapshot();
    const l3Server: AtlasScene = {
      id: 's',
      title: '',
      subtitle: '',
      rootEntityId: 'container:apps-server',
      entities: [
        { id: viewRoot, name: 'Okie', kind: 'system', detail: 'context', responsibility: '', x: 0, y: 0, width: 400, height: 200 },
        { id: 'container:apps-server', parentId: viewRoot, name: '@okie/server', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 200, height: 160 },
        { id: 'container:apps-web', parentId: viewRoot, name: '@okie/web', kind: 'container', detail: 'container', responsibility: '', x: 240, y: 0, width: 180, height: 140 },
        { id: serverFile, parentId: 'container:apps-server', name: 'enrichment.ts', kind: 'component', detail: 'component', responsibility: '', x: 10, y: 10, width: 80, height: 40 },
      ],
      relations: [],
      regions: [],
      projection: {
        boundsByEntityIdAndDetail: {
          [viewRoot]: { context: { x: 0, y: 0, width: 400, height: 200 }, container: { x: 0, y: 0, width: 400, height: 200 } },
          'container:apps-server': {
            container: { x: 0, y: 0, width: 200, height: 160 },
            component: { x: 0, y: 0, width: 200, height: 160 },
          },
          'container:apps-web': {
            container: { x: 240, y: 0, width: 180, height: 140 },
            component: { x: 240, y: 0, width: 180, height: 140 },
          },
          [serverFile]: { component: { x: 10, y: 10, width: 80, height: 40 } },
        },
        entityIdsByDetail: {
          context: [viewRoot],
          container: [viewRoot, 'container:apps-server', 'container:apps-web'],
          component: ['container:apps-server', 'container:apps-web', serverFile],
          code: [],
        },
      },
    } as unknown as AtlasScene;

    const webPointer = pointerAtWorld(camera, 330, 70);
    expect(scanZoomEntityUnderPointer(l3Server, camera, viewport, webPointer, 'component'))
      .toBe('container:apps-web');

    const preferred = scanZoomHandoffPreferredId(
      l3Server, snapshot, viewRoot, 'code', 'container:apps-server',
      camera, viewport, webPointer, 'component', 'container:apps-server',
    );
    expect(preferred).toBe('container:apps-server');
    expect(scanEntityIsInSubtree(snapshot, preferred, 'container:apps-server')).toBe(true);

    const handoff = scanZoomCompileHandoff(
      l3Server, snapshot, preferred, viewRoot, 'code', 'container:apps-server',
    );
    expect(handoff?.detail).toBe('code');
    expect(handoff?.compileFocus).toBeDefined();
    expect(scanEntityIsInSubtree(snapshot, handoff!.compileFocus, 'container:apps-server')).toBe(true);
    expect(scanEntityIsInSubtree(snapshot, handoff!.compileFocus, 'container:apps-web')).toBe(false);
    expect(handoff!.compileFocus).not.toBe(webFile);

    expect(scanZoomCompileHandoff(
      l3Server, snapshot, webFile, viewRoot, 'code', 'container:apps-server',
    )).toEqual({
      detail: 'code',
      compileFocus: scanCompileFocusForBand(snapshot, 'container:apps-server', 'code', viewRoot),
    });
  });

  it('from server L3, pointer over a server file still opens that file', () => {
    const snapshot = fatWebServerSnapshot();
    const l3 = l3ContainerScene(snapshot, 'container:apps-server');
    expect(l3.rootEntityId).toBe('container:apps-server');
    const card = l3.entities.find(entity =>
      entity.parentId === 'container:apps-server' && entity.detail === 'component');
    const bounds = l3.projection?.boundsByEntityIdAndDetail[card!.id]?.component;
    expect(bounds).toBeDefined();
    const liveCamera = {
      x: bounds!.x + bounds!.width / 2,
      y: bounds!.y + bounds!.height / 2,
      zoom: 8.6,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    expect(scanZoomEntityUnderPointer(l3, liveCamera, viewport, pointer, 'component')).toBe(card!.id);

    const preferred = scanZoomHandoffPreferredId(
      l3, snapshot, viewRoot, 'code', 'container:apps-server',
      liveCamera, viewport, pointer, 'component', 'container:apps-server',
    );
    expect(preferred).toBe(card!.id);
    expect(scanZoomCompileHandoff(l3, snapshot, preferred, viewRoot, 'code', 'container:apps-server')).toEqual({
      detail: 'code',
      compileFocus: card!.id,
    });
  });

  it('from web L3, further wheel stays inside web (file under pointer and peer-server miss)', () => {
    const snapshot = fatWebServerSnapshot();
    const l3 = l3ContainerScene(snapshot, 'container:apps-web');
    expect(l3.rootEntityId).toBe('container:apps-web');
    expect(scanPeerContainerIds(l3, 'container:apps-web')).toContain('container:apps-server');

    const card = l3.entities.find(entity =>
      entity.parentId === 'container:apps-web' && entity.detail === 'component');
    const bounds = l3.projection?.boundsByEntityIdAndDetail[card!.id]?.component;
    expect(bounds).toBeDefined();
    const liveCamera = {
      x: bounds!.x + bounds!.width / 2,
      y: bounds!.y + bounds!.height / 2,
      zoom: 8.6,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    const preferredFile = scanZoomHandoffPreferredId(
      l3, snapshot, viewRoot, 'code', 'container:apps-web',
      liveCamera, viewport, pointer, 'component', 'container:apps-web',
    );
    expect(scanEntityIsInSubtree(snapshot, preferredFile, 'container:apps-web')).toBe(true);
    const fileHandoff = scanZoomCompileHandoff(
      l3, snapshot, preferredFile, viewRoot, 'code', 'container:apps-web',
    );
    expect(fileHandoff?.detail).toBe('code');
    expect(scanEntityIsInSubtree(snapshot, fileHandoff!.compileFocus, 'container:apps-web')).toBe(true);

    const serverPeer = semanticBounds(l3, 'container:apps-server', 'component')
      ?? semanticBounds(l3, 'container:apps-server', 'container');
    expect(serverPeer).toBeDefined();
    const peerCamera = {
      x: serverPeer!.x + serverPeer!.width / 2,
      y: serverPeer!.y + serverPeer!.height / 2,
      zoom: 8.6,
    };
    const preferredPeer = scanZoomHandoffPreferredId(
      l3, snapshot, viewRoot, 'code', 'container:apps-web',
      peerCamera, viewport, pointer, 'component', 'container:apps-web',
    );
    expect(scanEntityIsInSubtree(snapshot, preferredPeer, 'container:apps-web')).toBe(true);
    const peerHandoff = scanZoomCompileHandoff(
      l3, snapshot, preferredPeer, viewRoot, 'code', 'container:apps-web',
    );
    expect(peerHandoff?.compileFocus).toBeDefined();
    expect(scanEntityIsInSubtree(snapshot, peerHandoff!.compileFocus, 'container:apps-web')).toBe(true);
    expect(scanEntityIsInSubtree(snapshot, peerHandoff!.compileFocus, 'container:apps-server')).toBe(false);
  });

  it('compiled server L3 neighborhood keeps L3→L4 inside server when a web peer is in world space', () => {
    const snapshot = fatWebServerSnapshot();
    const l3 = l3ContainerScene(snapshot, 'container:apps-server');
    expect(l3.rootEntityId).toBe('container:apps-server');
    expect(scanPeerContainerIds(l3, 'container:apps-server')).toContain('container:apps-web');
    expect(scanDeeperBandHasPeerCards(l3, 'container:apps-server', 'component')).toBe(true);

    const webPeer = semanticBounds(l3, 'container:apps-web', 'component')
      ?? semanticBounds(l3, 'container:apps-web', 'container');
    expect(webPeer).toBeDefined();
    const peerCamera = {
      x: webPeer!.x + webPeer!.width / 2,
      y: webPeer!.y + webPeer!.height / 2,
      zoom: 8.6,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    const preferred = scanZoomHandoffPreferredId(
      l3, snapshot, viewRoot, 'code', 'container:apps-server',
      peerCamera, viewport, pointer, 'component', 'container:apps-server',
    );
    expect(scanEntityIsInSubtree(snapshot, preferred, 'container:apps-server')).toBe(true);
    const handoff = scanZoomCompileHandoff(
      l3, snapshot, preferred, viewRoot, 'code', 'container:apps-server',
    );
    expect(handoff?.compileFocus).toBeDefined();
    expect(scanEntityIsInSubtree(snapshot, handoff!.compileFocus, 'container:apps-server')).toBe(true);
    expect(handoff!.compileFocus).not.toBe(webFile);
    expect(explorerEntitiesForView(l3, {
      detail: 'component',
      selected: l3.entities.find(entity => entity.id === 'container:apps-server')!,
      settledTargetIds: ['container:apps-server'],
    }).length).toBeGreaterThan(0);
  });
});
