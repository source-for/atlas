import { expect, it, vi } from 'vitest';
import { prepareReverseScene } from './reverseScenePreparation';
import { createSceneRequestOwner } from './sceneRequestOwner';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('allows ensure merges and publishes using the latest live camera without waiting for settle', async () => {
  let generation = 1;
  const camera = { x: 0, zoom: 3 };
  const compiled = deferred<string>();
  const publish = vi.fn();
  const request = createSceneRequestOwner().begin();
  const pending = prepareReverseScene({ ...request, generation: () => generation,
    ensure: async () => { generation++; }, compile: () => compiled.promise,
    publish: scene => publish(scene, { ...camera }),
  });
  await Promise.resolve();
  camera.x = 350; camera.zoom = 1.1;
  compiled.resolve('adjacent endpoint');
  await pending;
  expect(publish).toHaveBeenCalledWith('adjacent endpoint', { x: 350, zoom: 1.1 });
});

it('rejects graph changes in the cached compilation reply microtask', async () => {
  let generation = 1;
  const publish = vi.fn();
  await prepareReverseScene({ ...createSceneRequestOwner().begin(), generation: () => generation,
    ensure: async () => {}, compile: async () => {
      queueMicrotask(() => generation++);
      return 'cached source';
    }, publish,
  });
  expect(publish).not.toHaveBeenCalled();
});

it('rejects inward reversal, actual pan and foreground replacement while a worker reply is pending', async () => {
  for (const reason of ['inward reversal', 'pan', 'foreground navigation']) {
    const owner = createSceneRequestOwner();
    const request = owner.begin();
    const compiled = deferred<string>();
    const publish = vi.fn();
    const pending = prepareReverseScene({ ...request, generation: () => 1,
      ensure: async () => {}, compile: () => compiled.promise, publish,
    });
    await Promise.resolve();
    owner.cancel();
    compiled.resolve(reason);
    await pending;
    expect(request.signal.aborted).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  }
});

it('does not dispatch compilation after fixture/scene/session/selection ownership changes during ensure', async () => {
  const ensured = deferred<void>();
  let owns = true;
  const compile = vi.fn();
  const publish = vi.fn();
  const pending = prepareReverseScene({ signal: new AbortController().signal, owns: () => owns,
    generation: () => 1, ensure: () => ensured.promise, compile, publish,
  });
  owns = false; ensured.resolve(); await pending;
  expect(compile).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
});

it('keeps the current map on genuine compile failure without a second compilation fallback', async () => {
  const compile = vi.fn(async () => { throw new Error('worker failed'); });
  const publish = vi.fn();
  await expect(prepareReverseScene({ ...createSceneRequestOwner().begin(), generation: () => 1,
    ensure: async () => {}, compile, publish,
  })).rejects.toThrow('worker failed');
  expect(compile).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
});
