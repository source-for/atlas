import { afterEach, expect, it, vi } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture } from './scanFixture';
import * as scanScene from './scanScene';
import { prepareReverseScene } from './reverseScenePreparation';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(['unsupported', 'error', 'timeout'] as const)('retains the map without synchronous compile on a real %s worker session', async failure => {
  class FailedWorker {
    onerror?: () => void;
    terminate = vi.fn();
    postMessage() { if (failure === 'error') queueMicrotask(() => this.onerror?.()); }
  }
  vi.stubGlobal('Worker', failure === 'unsupported' ? undefined : FailedWorker);
  if (failure === 'timeout') vi.useFakeTimers();
  const fixture = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
  const initial = fixture.createScene(fixture.navigation.rootEntityId);
  let visible = initial;
  const compile = vi.spyOn(scanScene, 'compileScanScene');
  const controller = new AbortController();
  const reverse = prepareReverseScene({ signal: controller.signal, owns: () => true,
    generation: fixture.getSceneGeneration, ensure: () => fixture.ensureNeighborhood(fixture.navigation.rootEntityId),
    compile: () => fixture.createSceneAsync(fixture.navigation.rootEntityId, initial, undefined, controller.signal, { fallback: 'forbid' }),
    publish: prepared => { visible = prepared; },
  });
  const rejection = expect(reverse).rejects.toMatchObject({ name: 'SceneWorkerUnavailableError' });
  if (failure === 'timeout') await vi.runAllTimersAsync();
  await rejection;
  expect(compile).not.toHaveBeenCalled();
  expect(visible).toBe(initial);
  fixture.disposeSceneWorker();

  // Explicit navigation retains its original fallback contract.
  vi.stubGlobal('Worker', undefined);
  await expect(fixture.createSceneAsync(fixture.navigation.rootEntityId, initial)).resolves.toMatchObject({ rootEntityId: initial.rootEntityId });
  expect(compile).toHaveBeenCalledTimes(1);
  fixture.disposeSceneWorker();
});
