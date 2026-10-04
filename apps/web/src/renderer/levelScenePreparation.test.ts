import { compileCurrentGeneration } from './compileCurrentGeneration';
import { expect, it, vi } from 'vitest';
import { prepareLoadedLevelScene, prepareLevelSceneWithDeadline, clearLevelScenePreparation, LEVEL_SCENE_PREPARING, finishLevelScenePreparation, levelScenePreparationPending, runLevelSceneGesture } from './levelScenePreparation';
it('holds selected compile priority against pan and releases it on completion', () => {
  const request = new AbortController();
  const owner = { current: request as AbortController | undefined };
  expect(levelScenePreparationPending(owner.current)).toBe(true);
  expect(finishLevelScenePreparation(owner, request)).toBe(true);
  expect(levelScenePreparationPending(owner.current)).toBe(false);
});
it('cancellation releases gesture priority and old completion cannot clear a newer level', () => {
  const old = new AbortController(); old.abort();
  expect(levelScenePreparationPending(old)).toBe(false);
  const next = new AbortController(); const owner = { current: next as AbortController | undefined };
  expect(finishLevelScenePreparation(owner, old)).toBe(false);
  expect(levelScenePreparationPending(owner.current)).toBe(true);
});

it('keeps camera movement but never runs reverse or morph scope transitions while a level prepares', () => {
  const request = new AbortController();
  const camera = { x: 10, y: 20, zoom: 2 };
  const transition = vi.fn(() => ({ ...camera, zoom: 3 }));
  expect(runLevelSceneGesture(request, camera, transition)).toBe(camera);
  expect(transition).not.toHaveBeenCalled();
  finishLevelScenePreparation({ current: request }, request);
  expect(runLevelSceneGesture(undefined, camera, transition).zoom).toBe(3);
  expect(transition).toHaveBeenCalledTimes(1);
});

it('clears a cancelled level immediately while its fetch remains unresolved and protects a newer cue', () => {
  const old = new AbortController();
  const owner = { current: old as AbortController | undefined };
  let message = LEVEL_SCENE_PREPARING;
  const updateMessage = (update: (current: string) => string) => { message = update(message); };
  const unresolvedFetch = new Promise<void>(() => {});
  void unresolvedFetch;
  old.signal.addEventListener('abort', () => clearLevelScenePreparation(owner, old, updateMessage));
  old.abort();
  expect(owner.current).toBeUndefined();
  expect(message).toContain('cancelled');
  const next = new AbortController(); owner.current = next; message = LEVEL_SCENE_PREPARING;
  clearLevelScenePreparation(owner, old, updateMessage);
  expect(owner.current).toBe(next);
  expect(message).toBe(LEVEL_SCENE_PREPARING);
});

it('bounds a stalled host, immediately releases camera-only priority and rejects late publication', async () => {
  vi.useFakeTimers();
  try {
    const request = new AbortController(); const owner = { current: request as AbortController | undefined };
    let message = LEVEL_SCENE_PREPARING;
    request.signal.addEventListener('abort', () => clearLevelScenePreparation(owner, request, update => { message = update(message); }));
    let release!: () => void;
    const host = new Promise<void>(resolve => { release = resolve; });
    const publish = vi.fn();
    const prepared = prepareLevelSceneWithDeadline(request, async () => { await host; if (!request.signal.aborted) publish(); }, () => { message = 'Timed out'; }, 100);
    const rejected = expect(prepared).rejects.toMatchObject({ name: 'AbortError' });
    const transition = vi.fn(() => 'transition');
    expect(runLevelSceneGesture(owner.current, 'camera', transition)).toBe('camera');
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(owner.current).toBeUndefined(); expect(message).toBe('Timed out');
    expect(runLevelSceneGesture(owner.current, 'camera', transition)).toBe('transition');
    release(); await Promise.resolve(); expect(publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('cleans successful and cancelled deadlines without aborting or clearing newer ownership', async () => {
  vi.useFakeTimers();
  try {
    const timeout = vi.fn(); const first = new AbortController();
    expect(await prepareLevelSceneWithDeadline(first, async () => 42, timeout, 100)).toBe(42);
    await vi.advanceTimersByTimeAsync(100); expect(first.signal.aborted).toBe(false); expect(timeout).not.toHaveBeenCalled();
    const old = new AbortController(); const next = new AbortController(); const owner = { current: next as AbortController | undefined };
    const pending = prepareLevelSceneWithDeadline(old, () => new Promise(() => {}), timeout, 100);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); old.abort(); await rejected;
    clearLevelScenePreparation(owner, old, () => {}); expect(owner.current).toBe(next);
    await vi.advanceTimersByTimeAsync(100); expect(timeout).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});


it('waits both merged neighborhoods before compile and publication', async () => {
  const pending: (() => void)[] = []; const calls: string[] = [];
  let merged = false;
  const compile = vi.fn(async () => { calls.push('compile'); return 'scene'; }); const publish = vi.fn();
  const result = prepareLoadedLevelScene({ signal: new AbortController().signal, initialFocus: 'initial',
    ensure: focus => { calls.push(focus); return new Promise<void>(resolve => pending.push(resolve)); },
    recomputeFocus: () => merged ? 'deep' : 'initial', owns: () => true, compile, publish });
  expect(calls).toEqual(['initial']); expect(compile).not.toHaveBeenCalled();
  merged = true; pending.shift()!(); await Promise.resolve();
  expect(calls).toEqual(['initial', 'deep']); expect(compile).not.toHaveBeenCalled();
  pending.shift()!(); await result;
  expect(calls).toEqual(['initial', 'deep', 'compile']); expect(publish).toHaveBeenCalledExactlyOnceWith('scene');
});

it('does not compile after cancelled fetch and does not publish a late compiled scene', async () => {
  const request = new AbortController(); let release!: () => void;
  const compile = vi.fn(async () => 'scene'); const publish = vi.fn();
  const cancelled = prepareLoadedLevelScene({ signal: request.signal, initialFocus: 'initial',
    ensure: () => new Promise<void>(resolve => { release = resolve; }), recomputeFocus: () => 'deep', owns: () => true, compile, publish });
  request.abort(); release(); await cancelled; expect(compile).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled();
  const next = new AbortController(); let owns = true;
  const late = prepareLoadedLevelScene({ signal: next.signal, initialFocus: 'initial', ensure: async () => {},
    recomputeFocus: () => 'deep', owns: () => owns, compile: () => new Promise<string>(resolve => { release = () => resolve('late'); }), publish });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  owns = false; release(); await late; expect(publish).not.toHaveBeenCalled();
});

it('rejects an already aborted deadline without starting work or orphaning cancellation promises', async () => {
  const controller = new AbortController(); controller.abort(); const prepare = vi.fn();
  await expect(prepareLevelSceneWithDeadline(controller, prepare, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); expect(prepare).not.toHaveBeenCalled();
});

it('rejects a merge after the stable compile callback but publishes a current recorded result', async () => {
  let generation = 1; const scene = {}; const generations = new WeakMap<object, number>(); const publish = vi.fn();
  const run = (merge: boolean) => prepareLoadedLevelScene({ signal: new AbortController().signal, initialFocus: 'scope',
    ensure: async () => {}, recomputeFocus: () => 'scope', owns: () => true,
    compile: () => compileCurrentGeneration(() => generation, async () => scene, undefined, (result, stableGeneration) => {
      generations.set(result, stableGeneration);
      if (merge) queueMicrotask(() => { generation++; });
    }), isPreparedCurrent: result => generations.get(result) === generation, publish });
  await expect(run(true)).rejects.toThrow('Atlas data changed'); expect(publish).not.toHaveBeenCalled();
  await run(false); expect(publish).toHaveBeenCalledExactlyOnceWith(scene);
});
