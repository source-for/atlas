import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const restoreRestore = (() => {
  const start = app.indexOf('async restore(');
  const end = app.indexOf('onCommit(commit)', start);
  if (start < 0 || end < 0) throw new Error('Missing navigation restore()');
  return app.slice(start, end);
})();

const initializeRearm = (() => {
  const start = restoreRestore.indexOf("if (source === 'initialize' && !initialCameraExplicit)");
  if (start < 0) throw new Error('Missing initialize restore camera-fit branch');
  return restoreRestore.slice(start);
})();

const autoFitEffect = (() => {
  const start = app.indexOf('const requiresFit = !initialMapFitAppliedRef.current;');
  const end = app.indexOf('}, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);');
  if (start < 0 || end < 0) throw new Error('Missing auto-fit effect');
  return app.slice(start, end);
})();

const pointerUp = sliceBetween(app, 'function handlePointerUp', 'function pickAt', 'handlePointerUp');
const handlePick = sliceBetween(app, 'function handlePick', 'function closeDetails', 'handlePick');
const focusEntity = sliceBetween(app, 'function focusEntity(', 'function navigateInspectorHierarchy', 'focusEntity');

describe('CLA-11: camera does not re-fit without a user gesture', () => {
  it('does not re-arm a delayed map fit after initialize restore', () => {
    // The previous path waited two rAFs (so WASM compile could block the main thread
    // for seconds), then cleared the one-shot flag and bumped safeAreaEpoch. That
    // wrote a new `cx` with `sel` unchanged — the load-time jump this issue reports.
    expect(restoreRestore).toContain('initialMapFitAppliedRef.current = true;');
    expect(restoreRestore).not.toContain('initialMapFitAppliedRef.current = false');
    expect(initializeRearm).not.toContain('setSafeAreaEpoch');
    expect(initializeRearm).toContain('initialMapFitAppliedRef.current = true;');
    expect(restoreRestore.indexOf('await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))'))
      .toBeLessThan(restoreRestore.indexOf("if (source === 'initialize' && !initialCameraExplicit)"));
  });

  it('keeps the auto-fit effect one-shot so a later epoch bump cannot write the camera', () => {
    expect(autoFitEffect).toContain('initialMapFitAppliedRef.current = true;');
    expect(autoFitEffect).toContain('if (!requiresFit) return;');
    expect(autoFitEffect).toContain('frameProjectionScope(');
    expect(autoFitEffect).toContain('updateCamera(next);');
    expect(app).toContain('if (!isUsableAtlasViewport(viewport)) return;');
    expect(restoreRestore).toContain('isFramedBrowsingContext()');
    // Click/inspector chrome still bump safeAreaEpoch; the flag, not the dep list,
    // is what stops those from becoming a second unsolicited frame.
    expect(app).toContain('safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);');
  });

  it('does not frame or update the camera on an empty-canvas click', () => {
    expect(pointerUp).toContain('if (!pointer.moved)');
    expect(pointerUp).toContain('if (picked) onPick(picked);');
    expect(pointerUp).not.toContain('frameProjectionScope(');
    expect(pointerUp).not.toContain('frameEntities(');
    expect(pointerUp).not.toContain('updateCamera(');
    expect(pointerUp).not.toContain('navigateCamera(');
    expect(handlePick).toContain("focusEntity(entity, 'replace', 'preserve', 'auto')");
    expect(focusEntity).toContain("const nextCamera = cameraIntent === 'frame'");
    expect(focusEntity).toContain("const explicitCameraIntent = cameraIntent === 'frame' || inspectorIntent === 'source';");
    expect(focusEntity).toContain("if (explicitCameraIntent) reframeEntityAfterInspectorChange(entity, nextInspectorTab === 'source');");
  });

  it('still moves the camera on pan/zoom, Show on map, Open inside, search jump, and story', () => {
    expect(app).toContain("navigateCamera(next, 'replace', 'Panned the map overview')");
    expect(app).toContain("onClick={() => semanticZoomControl('inward')}");
    expect(app).toContain("onClick={() => semanticZoomControl('outward')}");
    expect(app).toContain("aria-label=\"Fit architecture to view\"");
    expect(app).toContain('frameVisibleProjection(scene, activeProjectionEntityIds, activeDetail, viewport, measureCurrentMapSafeArea()) ?? camera');
    expect(app).toContain("navigateCamera(next, 'replace', 'Fit the current architecture scope')");
    expect(app).toContain("onClick={() => focusEntity(selected, 'replace', 'frame', 'details', 'preserve')}");
    expect(app).toContain("onClick={() => focusEntity(entity, 'push', 'frame')}");
    expect(app).toContain('function openInside(');
    expect(app).toContain('updateCamera(plan.camera);');
    expect(app).toContain('function setStep(');
    expect(app).toContain('createStoryFlight(');
  });
});
