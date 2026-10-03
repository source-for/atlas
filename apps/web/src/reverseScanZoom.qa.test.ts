import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

it('prepares the adjacent reverse endpoint through the async fixture seam and samples the latest camera', () => {
  const reverse = app.slice(app.indexOf('function startScanContainerReverseMorph'), app.indexOf('function handleSemanticZoom'));
  expect(reverse).toContain('prepareReverseScene(');
  expect(reverse).toContain('composeScanSceneAsync(sourceFocusId, undefined, request.signal');
  expect(reverse).toContain('[focusId], undefined, undefined, true)');
  expect(app).toContain("workerRequired ? { fallback: 'forbid' } : undefined");
  expect(reverse).not.toContain('composeScene(');
  expect(reverse).toContain('const liveCamera = renderedCameraRef.current;');
  expect(reverse).toContain('sampleScanContainerMorph(bridge, liveCamera.zoom)');
  expect(reverse).toContain('bridge.baselineProgress = frame.progress;');
  expect(reverse).toContain('scanZoomAdoptRawRef.current = next;');
  expect(reverse).toContain('fixture === foregroundFixtureRef.current');
  expect(reverse).toContain('target === sceneRef.current && session === semanticLensSessionRef.current && selection === inspectorSelectionRef.current');
});

it('freezes pending semantic zoom while camera samples continue, and cancels at real pan start', () => {
  const zoom = app.slice(app.indexOf('function handleSemanticZoom'), app.indexOf('function settleCamera'));
  expect(zoom).toContain('if (startScanContainerReverseMorph(sample.camera, sample.direction');
  expect(zoom).toContain('publishSemanticRenderPacket(sample.camera);\n      return sample.camera;');
  const pan = app.slice(app.indexOf('if (!pointer.moved)'), app.indexOf('pointer.x = event.clientX'));
  expect(pan).toContain('onCameraPanStartRef.current();');
  expect(pan).not.toContain('onInteractionStartRef.current');
  expect(app).toContain('onCameraPanStart={cancelReverseScenePreparation}');
  expect(app).toContain("if (direction !== 'inward' && pending.scene === target");
});

it('retains a newer valid reverse owner during delayed scene effects and guards the loading cue', () => {
  expect(app).toContain('if (reverseScenePendingRef.current && !reverseScenePendingRef.current.owns()) cancelReverseScenePreparation();');
  expect(app).toContain('cancelGestureSceneRequests(false);');
  expect(app).toContain('if (reverseScenePendingRef.current === intent) { reverseScenePendingRef.current = undefined; setReverseViewLoading(false); }');
  expect(app).toContain('foregroundViewLoading || reverseViewLoading');
});
