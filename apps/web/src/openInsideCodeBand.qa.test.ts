import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  sliceArchitectureNeighborhood,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import { getLevel } from './App';
import { createC4Scene, scanZoomCompileHandoff } from './renderer/goldenC4Scene';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import {
  frameCodePeerArrivalCamera,
  frameProjectionScope,
  semanticLevelSession,
} from './semantic/semanticLensEngine';
import { semanticLensSessionDetail } from './semantic/semanticLens';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('CLA-78: Code rail after Open inside a container', () => {
  // Supplementary static wiring guard; executable sequencing tests live in levelScenePreparation.test.ts.
  it('wires neighborhood preparation before the level rail compiles', () => {
    expect(app).toContain('function selectLevel(');
    expect(app).toContain('function selectLevelLoaded(');
    expect(app).toContain('void prepareLevelSceneWithDeadline(controller, () => prepareLoadedLevelScene({');
    expect(app).toContain('ensure: focus => fixture.ensureNeighborhood(focus)');
    const selectLevel = app.slice(app.indexOf('function selectLevel('), app.indexOf('function selectLevelLoaded('));
    const neighborhoodReady = selectLevel.indexOf('ensure: focus => fixture.ensureNeighborhood(focus)');
    const cachedCompile = selectLevel.indexOf('return composeScanSceneAsync(');
    expect(neighborhoodReady).toBeGreaterThanOrEqual(0);
    expect(cachedCompile).toBeGreaterThanOrEqual(0);
    expect(neighborhoodReady).toBeLessThan(cachedCompile);
    expect(selectLevel).toContain('owns: () => fixture === scanFixture');
    expect(selectLevel).toContain('selectLevelLoaded(index, prepared)');
  });

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('after Open inside a container, switching to Code yields L4 entities (explorer count > 0)', async () => {
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
    expect(fixture.snapshot.entities.some(entity => entity.kind === 'code')).toBe(false);

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    expect((l3.projection?.entityIdsByDetail.component ?? []).length).toBeGreaterThan(0);
    expect(l3.projection?.entityIdsByDetail.code ?? []).toEqual([]);

    const containerCompile = fixture.createScene('container:web-app');
    expect(containerCompile.projection?.entityIdsByDetail.code ?? []).toEqual([]);

    const l4Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'code',
      fixture.navigation.rootEntityId,
    );
    expect(l4Focus).not.toBe('container:web-app');
    expect(fixture.snapshot.entities.find(entity => entity.id === l4Focus)?.kind).toBe('component');
    expect(fixture.snapshot.entities.find(entity => entity.id === l4Focus)?.parentId).toBe('container:web-app');

    await fixture.ensureNeighborhood(l4Focus);
    expect(fixture.snapshot.entities.some(entity => entity.kind === 'code' && entity.parentId === l4Focus)).toBe(true);

    const l4 = fixture.createScene(l4Focus);
    const codeIds = l4.projection?.entityIdsByDetail.code ?? [];
    expect(codeIds.length).toBeGreaterThan(0);
    expect(l4.entities.some(entity => entity.detail === 'code' && codeIds.includes(entity.id))).toBe(true);

    const selected = l4.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l4, 'code', ['container:web-app']);
    const rows = explorerEntitiesForView(l4, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: codeIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entity => codeIds.includes(entity.id))).toBe(true);
  });

  it('keeps Open-inside a file compiling that file’s L4 symbols', async () => {
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
    await fixture.ensureNeighborhood('component:web-shell');
    const focus = scanCompileFocusForBand(
      fixture.snapshot,
      'component:web-shell',
      'code',
      fixture.navigation.rootEntityId,
    );
    expect(focus).toBe('component:web-shell');
    const scene = fixture.createScene(focus);
    expect((scene.projection?.entityIdsByDetail.code ?? []).length).toBeGreaterThan(0);
    const selected = scene.entities.find(entity => entity.id === 'component:web-shell');
    expect(selected).toBeDefined();
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: selected!,
      visibleIds: scene.projection?.entityIdsByDetail.code,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(entity => entity.id === 'code:web-shell:app' || entity.detail === 'code')).toBe(true);
  });
});

const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };
const CODE_BAND_ENTER = C4_ZOOM_BANDS[3]!.enterZoom;
const CODE_BAND_FOCUS = C4_ZOOM_BANDS[3]!.focusZoom;

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

function busyFileSnapshot(codeCount: number): ArchitectureSnapshot {
  const fileId = 'component:ask-atlas';
  const entities: ArchitectureSnapshot['entities'] = [
    { id: 'system:okie', kind: 'softwareSystem', name: 'okie', sourceRefs: [] },
    { id: 'container:web', kind: 'container', parentId: 'system:okie', name: 'web', sourceRefs: [] },
    { id: fileId, kind: 'component', parentId: 'container:web', name: 'askAtlas.ts', sourceRefs: [] },
  ];
  for (let index = 0; index < codeCount; index += 1) {
    entities.push({
      id: `code:ask-atlas:${String(index).padStart(2, '0')}`,
      kind: 'code',
      parentId: fileId,
      name: `sym${index}`,
      sourceRefs: [],
    });
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-110',
    repositoryId: 'repo:cla-110',
    commitSha: 'c'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

describe('CLA-110: Open inside L4 lands at code-band zoom (no kick-out to system)', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('Open inside a reserved file does not contain the owner shell', () => {
    const openInsideLoaded = sliceBetween(app, 'function openInsideLoaded(', 'function navigateRoot(', 'openInsideLoaded');
    expect(openInsideLoaded).toContain("deeperDetail === 'container' || deeperDetail === 'component' || deeperDetail === 'code'");
    expect(openInsideLoaded).toContain('frameProjectionScope(nextScene, compileFocus, deeperDetail, viewport, mapSafeArea)');
  });

  it('resident and nonresident implementation-link code children enter the canonical owner L4 drill', () => {
    const openInspectorChild = sliceBetween(app, 'async function openInspectorChild(', 'const omittedChildNodes', 'openInspectorChild');
    const openInsideLoaded = sliceBetween(app, 'function openInsideLoaded(', 'function navigateRoot(', 'openInsideLoaded');
    const composeScene = sliceBetween(app, 'function composeScene(', '/** Recompile the current C4 neighborhood', 'composeScene');
    expect(openInspectorChild).toContain("if (resident?.detail !== 'code' && resident && residentPlan)");
    expect(openInspectorChild).toContain("openInsideLoaded(focusId, 'preserve', id)");
    expect(openInspectorChild).toContain('if (target?.kind === \'code\' && focusId !== id)');
    expect(openInspectorChild).toContain("updateInspectorHistoryForNavigation('panel')");
    expect(openInsideLoaded).toContain('const codeChild = codeChildId');
    expect(openInsideLoaded).toContain('codeChildId ? [codeChildId] : undefined');
    expect(openInsideLoaded).toContain("setInspectorTab(inspectorTabFor(codeChild, 'source'))");
    expect(openInsideLoaded).toContain('selectedId: destination.id');
    expect(composeScene).toContain('keepEntityIds?: readonly string[]');
    expect(composeScene).toContain('retainedEntityIds.join(\',\')');
  });

  it('pins an implementation-linked declaration beyond the L4 page cap', () => {
    const snapshot = busyFileSnapshot(52);
    const base = {
      baseSnapshot: snapshot,
      rootEntityId: 'component:ask-atlas',
      focusEntityId: 'component:ask-atlas',
      familyId: 'f',
      sceneId: 'scan:cla-110:code-page',
      title: 'askAtlas.ts',
      subtitle: '',
      frozenRevision: 'c',
      maxBand: 'code' as const,
      maxNodesPerBand: 50,
      pageCodeLandmarks: true,
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    };
    const childId = 'code:ask-atlas:51';
    const paged = createC4Scene(base);
    const retained = createC4Scene({ ...base, keepEntityIds: [childId] });
    expect(paged.projection?.entityIdsByDetail.code ?? []).not.toContain(childId);
    expect(retained.projection?.entityIdsByDetail.code ?? []).toContain(childId);
  });

  it('Open inside a 52-symbol file lands at code-band zoom, not container-band coverage-reveal', () => {
    const snapshot = busyFileSnapshot(52);
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'component:ask-atlas',
      focusEntityId: 'component:ask-atlas',
      familyId: 'f',
      sceneId: 'scan:cla-110:c4',
      title: 'askAtlas.ts',
      subtitle: '',
      frozenRevision: 'c',
      maxBand: 'code',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    const codeIds = (scene.projection?.entityIdsByDetail.code ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'code');
    expect(codeIds.length).toBe(52);

    const camera = frameProjectionScope(scene, 'component:ask-atlas', 'code', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera).toEqual(frameCodePeerArrivalCamera(scene, 'component:ask-atlas', viewport, chromeSafeArea));
    expect(camera!.zoom).toBeGreaterThanOrEqual(CODE_BAND_ENTER - 1e-9);
    expect(camera!.zoom).toBeCloseTo(CODE_BAND_FOCUS, 0);
    expect(getLevel(camera!.zoom)).toBe(3);
    expect(getLevel(camera!.zoom, 3)).toBe(3);

    const session = semanticLevelSession(scene, 'code', ['component:ask-atlas']);
    expect(semanticLensSessionDetail(session)).toBe('code');
  });

  it('first wheel tick after Open inside stays in the file/code neighborhood', () => {
    const snapshot = busyFileSnapshot(52);
    const viewRoot = 'system:okie';
    const fileId = 'component:ask-atlas';
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: fileId,
      focusEntityId: fileId,
      familyId: 'f',
      sceneId: 'scan:cla-110:wheel',
      title: 'askAtlas.ts',
      subtitle: '',
      frozenRevision: 'c',
      maxBand: 'code',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    const camera = frameProjectionScope(scene, fileId, 'code', viewport, chromeSafeArea)!;
    expect(camera.zoom).toBeGreaterThanOrEqual(CODE_BAND_ENTER - 1e-9);
    expect(getLevel(camera.zoom, 3)).toBe(3);

    const zoomDetail = (['context', 'container', 'component', 'code'] as const)[getLevel(camera.zoom, 3)]!;
    expect(zoomDetail).toBe('code');
    expect(scanZoomCompileHandoff(scene, snapshot, fileId, viewRoot, zoomDetail, fileId)).toBeUndefined();

    const inward = getLevel(camera.zoom * 1.08, 3);
    const outward = getLevel(camera.zoom * 0.92, 3);
    expect(inward).toBe(3);
    expect(outward).toBe(3);
    expect(scanZoomCompileHandoff(
      scene,
      snapshot,
      fileId,
      viewRoot,
      (['context', 'container', 'component', 'code'] as const)[inward]!,
      fileId,
    )).toBeUndefined();
    expect(scanZoomCompileHandoff(scene, snapshot, fileId, viewRoot, 'container', fileId)).toEqual({
      detail: 'container',
      compileFocus: viewRoot,
    });
    expect(scanCompileFocusForBand(snapshot, fileId, 'code', viewRoot)).toBe(fileId);
    expect(scanCompileFocusForBand(snapshot, fileId, 'container', viewRoot)).toBe(viewRoot);

    // The pre-fix coverage-reveal landing (~z=2.87) is container band and would
    // recompile to system:okie. That zoom must not be the Open-inside camera.
    expect(getLevel(2.87, 3)).toBe(1);
    expect(scanZoomCompileHandoff(scene, snapshot, fileId, viewRoot, 'container', fileId)?.compileFocus)
      .toBe(viewRoot);
  });
});
