import { cacheableNeighborhoodScene } from './lazyBandCompile';
import { afterEach, expect, it, vi } from 'vitest';
import { compileSceneOffThread, createSceneCompileSession, createSceneWorkerHealth } from './compileSceneOffThread';
import { compileScanScene, type ScanSceneInput } from './scanScene';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import type { AtlasScene } from './types';
import type { ArchitectureNeighborhoodPacket } from '@okie/architecture';
import { subscribeLoadTiming } from '../performance/loadTimings';
import type { SceneCompileRequest, NeighborhoodInitializeRequest } from './sceneCompileProtocol';
const input = { focusEntityId: 'root', snapshot: {} } as ScanSceneInput;
class WorkerStub {
  static latest: WorkerStub;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { WorkerStub.latest = this; }
  reply(scene = { rootEntityId: 'root' } as AtlasScene) {
    const request = this.postMessage.mock.lastCall![0] as SceneCompileRequest;
    this.onmessage?.({ data: { id: request.id, generation: request.generation, ok: true, scene, durationMs: 3 } });
    return scene;
  }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('keeps a worker and graph across compiles and reuses worker-owned previous scenes', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const first = session.compile(input, { generation: 0 });
  const worker = WorkerStub.latest;
  const scene = worker.reply();
  expect(await first).toBe(scene);
  const second = session.compile({ ...input, previous: scene }, { generation: 0 });
  const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
  expect(request.graph).toBeUndefined();
  expect(request.input.previous).toBeUndefined();
  expect(request.previousId).toBe(1);
  worker.reply(); await second;
  expect(worker.terminate).not.toHaveBeenCalled();
  session.dispose(); expect(worker.terminate).toHaveBeenCalledOnce();
});
it('transfers graph on explicit revision or snapshot identity change', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  for (const [generation, snapshot] of [[0, input.snapshot], [1, input.snapshot], [1, {}]] as const) {
    const result = session.compile({ ...input, snapshot } as ScanSceneInput, { generation });
    expect(WorkerStub.latest.postMessage.mock.lastCall![0].graph.snapshot).toBe(snapshot);
    WorkerStub.latest.reply(); await result;
  }
  await expect(session.compile(input, { generation: 0 })).rejects.toMatchObject({ name: 'AbortError' });
  session.dispose();
});
it('preempts speculative CPU, ignores late replies and reloads graph on restart', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const first = session.compile(input, { generation: 0, priority: 'speculative' });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const old = WorkerStub.latest;
  const result = session.compile(input, { generation: 0 });
  const current = WorkerStub.latest;
  expect(old.terminate).toHaveBeenCalledOnce();
  expect(current).not.toBe(old);
  expect(current.postMessage.mock.lastCall![0].graph).toBeDefined();
  old.reply(); current.reply(); await result; await rejected; session.dispose();
});
it('bounds queued speculative work and rejects superseded jobs', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const selected = session.compile(input, { generation: 0 });
  const first = session.compile(input, { generation: 0, priority: 'speculative' });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const latest = session.compile(input, { generation: 0, priority: 'speculative' });
  expect(WorkerStub.latest.postMessage).toHaveBeenCalledTimes(1);
  WorkerStub.latest.reply(); await selected;
  expect(WorkerStub.latest.postMessage).toHaveBeenCalledTimes(2);
  WorkerStub.latest.reply(); await latest; await rejected; session.dispose();
});
it('aborts compilation and terminates the isolated compatibility worker', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const controller = new AbortController();
  const result = compileSceneOffThread(input, controller.signal, createSceneWorkerHealth());
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); WorkerStub.latest.reply(); await rejection;
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
});
it('falls back for unsupported workers, errors, wrong scope and timeout', async () => {
  vi.stubGlobal('Worker', undefined);
  expect(await compileSceneOffThread(input, undefined, createSceneWorkerHealth())).toBeUndefined();
  vi.stubGlobal('Worker', WorkerStub);
  let result = compileSceneOffThread(input, undefined, createSceneWorkerHealth());
  WorkerStub.latest.onerror?.(); expect(await result).toBeUndefined();
  result = compileSceneOffThread(input, undefined, createSceneWorkerHealth());
  WorkerStub.latest.reply({ rootEntityId: 'different' } as AtlasScene); expect(await result).toBeUndefined();
  vi.useFakeTimers(); result = compileSceneOffThread(input, undefined, createSceneWorkerHealth());
  await vi.advanceTimersByTimeAsync(20_000); expect(await result).toBeUndefined();
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
});

it('rejects disposed sessions without triggering synchronous fallback', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const active = session.compile(input, { generation: 0 });
  const rejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
  session.dispose();
  await rejected;
  await expect(session.compile(input, { generation: 0 })).rejects.toMatchObject({ name: 'AbortError' });
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
});

it('finishes abandoned selected CPU and starts only the latest bounded queued request without restart', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const first = session.compile(input, { generation: 0 });
  const rejectedFirst = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const worker = WorkerStub.latest;
  const second = session.compile(input, { generation: 0 });
  const rejectedSecond = expect(second).rejects.toMatchObject({ name: 'AbortError' });
  const latest = session.compile(input, { generation: 0 });
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.reply();
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(worker.postMessage.mock.lastCall![0].graph).toBeUndefined();
  const scene = worker.reply(); expect(await latest).toBe(scene);
  await rejectedFirst; await rejectedSecond; session.dispose();
});

it('retains generation-static view, counts and unpublished children rather than re-cloning them', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const graphInput = { ...input, view: { layout: { nodes: { root: {} } } }, childCounts: { root: 2000 }, unpublishedChildren: [{ id: 'pending' }] } as unknown as ScanSceneInput;
  const first = session.compile(graphInput, { generation: 0 });
  const worker = WorkerStub.latest;
  expect(worker.postMessage.mock.lastCall![0].graph).toMatchObject({ view: graphInput.view, childCounts: graphInput.childCounts, unpublishedChildren: graphInput.unpublishedChildren });
  worker.reply(); await first;
  const second = session.compile(graphInput, { generation: 0 });
  const request = worker.postMessage.mock.lastCall![0];
  expect(request.graph).toBeUndefined();
  for (const field of ['snapshot', 'view', 'childCounts', 'unpublishedChildren']) expect(request.input).not.toHaveProperty(field);
  worker.reply(); await second; session.dispose();
});

it('an abandoned active selected job keeps its timeout and cannot starve the newest request', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const controller = new AbortController();
  const first = session.compile(input, { generation: 0, signal: controller.signal });
  const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const old = WorkerStub.latest; controller.abort();
  const latest = session.compile(input, { generation: 0 });
  expect(old.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(old.terminate).toHaveBeenCalledOnce();
  expect(WorkerStub.latest).not.toBe(old);
  old.reply(); const scene = WorkerStub.latest.reply();
  expect(await latest).toBe(scene); await rejection; session.dispose();
});

it('accepts the real compiler guard fallback above 2000 entities across structured clones', async () => {
  const snapshot = structuredClone(demoSnapshot) as unknown as ScanSceneInput['snapshot'];
  const view = structuredClone(demoView) as unknown as ScanSceneInput['view'];
  snapshot.entities.push({ id: 'code:huge', name: 'huge', kind: 'code', parentId: view.rootEntityId, sourceRefs: [] },
    ...Array.from({ length: 2001 }, (_, i) => ({ id: `code:huge-${i}`, name: `leaf${i}`, kind: 'code' as const, parentId: 'code:huge', sourceRefs: [] })));
  const realInput: ScanSceneInput = { snapshot, view, focusEntityId: 'code:huge', boot: 'full', modeOptions: {}, childCounts: {}, unpublishedChildren: [] };
  class RealCompilerWorker extends WorkerStub {
    graph?: SceneCompileRequest['graph'];
    postMessage = vi.fn((request: SceneCompileRequest) => {
      const copy = structuredClone(request);
      this.graph = copy.graph ?? this.graph;
      queueMicrotask(() => {
        const scene = compileScanScene({ ...copy.input, ...this.graph! });
        this.onmessage?.({ data: structuredClone({ id: copy.id, generation: copy.generation, ok: true, scene, durationMs: 1 }) });
      });
    });
  }
  vi.stubGlobal('Worker', RealCompilerWorker);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const scene = await session.compile(realInput, { generation: 0 });
  expect(scene?.rootEntityId).toBe(view.rootEntityId);
  expect(scene?.scanGuardRefusal).toMatchObject({ requestedFocusId: 'code:huge', fallbackFocusId: view.rootEntityId, entityCount: 2002 });
  expect(WorkerStub.latest.terminate).not.toHaveBeenCalled();
  expect(await session.compile(realInput, { generation: 0 })).toEqual(scene);
  expect(WorkerStub.latest.postMessage.mock.lastCall![0].graph).toBeUndefined();
  session.dispose();
  vi.stubGlobal('Worker', WorkerStub);
  for (const patch of [{ requestedFocusId: 'other' }, { fallbackFocusId: 'other' }, { entityCount: 2001 }, { relationCount: 1 }]) {
    const invalidSession = createSceneCompileSession(createSceneWorkerHealth());
    const pending = invalidSession.compile(realInput, { generation: 0 });
    WorkerStub.latest.reply({ ...scene!, scanGuardRefusal: { ...scene!.scanGuardRefusal!, ...patch } });
    expect(await pending).toBeUndefined();
    expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
    invalidSession.dispose();
  }
});

it('generation changes abandon selected work without restart and transfer the newer graph after it finishes', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const first = session.compile(input, { generation: 0 });
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
  const worker = WorkerStub.latest;
  const latest = session.compile(input, { generation: 1 });
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.reply();
  const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
  expect(request.generation).toBe(1); expect(request.graph?.snapshot).toBe(input.snapshot);
  const scene = worker.reply(); expect(await latest).toBe(scene);
  await rejected; session.dispose();
});

it('ignores wrong request IDs and generations before accepting a selected response', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const pending = session.compile(input, { generation: 4 });
  const worker = WorkerStub.latest;
  const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
  for (const [id, generation] of [[request.id + 1, 4], [request.id, 3]]) {
    worker.onmessage?.({ data: { id, generation, ok: true, scene: { rootEntityId: 'root' } } });
  }
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const scene = worker.reply(); expect(await pending).toBe(scene); session.dispose();
});
const packet = { snapshot: input.snapshot, view: { rootEntityId: 'root' } } as ArchitectureNeighborhoodPacket;
function replyInitialization(worker: WorkerStub, status: 'ready' | 'invalid' | 'failed' = 'ready') {
  const request = worker.postMessage.mock.lastCall![0] as NeighborhoodInitializeRequest;
  const scene = { rootEntityId: 'root' } as AtlasScene;
  worker.onmessage?.({ data: { operation: 'initializeNeighborhood', id: request.id, generation: request.generation, status,
    ...(status === 'ready' ? { scene, validateDurationMs: 7, sliceDurationMs: 2, compileDurationMs: 3 }
      : status === 'invalid' ? { issues: [{ path: 'snapshot.entities[0]', message: 'invalid' }], validateDurationMs: 7 } : {}),
  } });
  return scene;
}
it('uploads the bootstrap packet once, retains full graph for enrichment and records scalar phases', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const samples: unknown[][] = [];
  const stop = subscribeLoadTiming((...sample) => samples.push(sample));
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const initial = session.initializeNeighborhood(packet, {}, { generation: 2 });
  const worker = WorkerStub.latest;
  expect(worker.postMessage.mock.lastCall![0].packet).toBe(packet);
  const scene = replyInitialization(worker);
  expect(await initial).toEqual({ status: 'ready', scene });
  const enriched = session.compile({ ...input, previous: scene }, { generation: 2, priority: 'speculative' });
  const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
  expect(request.graph).toBeUndefined();
  expect(request.input.previous).toBeUndefined();
  expect(request.previousId).toBe(1);
  worker.reply(); await enriched;
  expect(worker.postMessage.mock.calls.filter(([request]) => request.packet || request.graph)).toHaveLength(1);
  expect(samples.map(sample => sample[0])).toEqual(expect.arrayContaining([
    'atlas-worker-post-message', 'atlas-worker-bootstrap-round-trip', 'atlas-worker-validate', 'atlas-worker-slice', 'atlas-worker-compile',
  ]));
  expect(samples.every(sample => sample.length === 3 && typeof sample[1] === 'number' && typeof sample[2] === 'number')).toBe(true);
  stop(); session.dispose();
});
it('preserves invalid issue data rather than returning the fallback signal', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const result = session.initializeNeighborhood(packet, {}, { generation: 2 });
  replyInitialization(WorkerStub.latest, 'invalid');
  expect(await result).toEqual({ status: 'invalid', issues: [{ path: 'snapshot.entities[0]', message: 'invalid' }] });
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce(); session.dispose();
});
it('initialization fallback is limited to unsupported/error/timeout failures', async () => {
  vi.stubGlobal('Worker', undefined);
  let session = createSceneCompileSession(createSceneWorkerHealth());
  expect(await session.initializeNeighborhood(packet, {}, { generation: 2 })).toBeUndefined(); session.dispose();
  vi.stubGlobal('Worker', WorkerStub);
  for (const fail of ['status', 'error', 'timeout']) {
    if (fail === 'timeout') vi.useFakeTimers();
    session = createSceneCompileSession(createSceneWorkerHealth());
    const result = session.initializeNeighborhood(packet, {}, { generation: 2 });
    if (fail === 'status') replyInitialization(WorkerStub.latest, 'failed');
    else if (fail === 'error') WorkerStub.latest.onerror?.();
    else { await vi.advanceTimersByTimeAsync(20_000); vi.useRealTimers(); }
    expect(await result).toBeUndefined();
    expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce(); session.dispose();
  }
});
it('aborts, supersedes and disposes initializer jobs without fallback or accepting late replies', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  for (const action of ['abort', 'supersede', 'dispose']) {
    const session = createSceneCompileSession(createSceneWorkerHealth());
    const controller = new AbortController();
    const first = session.initializeNeighborhood(packet, {}, { generation: 2, signal: controller.signal });
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const old = WorkerStub.latest;
    if (action === 'abort') controller.abort();
    else if (action === 'dispose') session.dispose();
    else {
      const next = session.initializeNeighborhood(packet, {}, { generation: 4 });
      old.onmessage?.({ data: { operation: 'initializeNeighborhood', id: 1, generation: 2, status: 'invalid', issues: [] } });
      replyInitialization(WorkerStub.latest); expect((await next)?.status).toBe('ready');
      await expect(session.initializeNeighborhood(packet, {}, { generation: 2 })).rejects.toMatchObject({ name: 'AbortError' });
    }
    replyInitialization(old); await rejection;
    expect(old.terminate).toHaveBeenCalledOnce(); session.dispose();
  }
});

it('reuses a retained patch-free cache copy but clones a modified copy', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  try {
    const first = session.compile(input, { generation: 0 });
    const worker = WorkerStub.latest;
    const original = worker.reply({ rootEntityId: 'root', protocolPatch: { revision: 1 } } as unknown as AtlasScene);
    await first;
    const copy = cacheableNeighborhoodScene(original) as AtlasScene;
    const second = session.compile({ ...input, previous: copy }, { generation: 0 });
    expect(worker.postMessage.mock.lastCall![0].previousId).toBe(1);
    expect(worker.postMessage.mock.lastCall![0].input.previous).toBeUndefined();
    worker.reply(); await second;
    copy.rootEntityId = 'modified';
    const third = session.compile({ ...input, previous: copy }, { generation: 0 });
    expect(worker.postMessage.mock.lastCall![0].previousId).toBeUndefined();
    expect(worker.postMessage.mock.lastCall![0].input.previous).toBe(copy);
    worker.reply(); await third;
  } finally { session.dispose(); }
});

it('retains an abandoned guarded result without comparing it to a subsequently merged snapshot', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const snapshot = structuredClone(demoSnapshot) as unknown as ScanSceneInput['snapshot'];
  const view = structuredClone(demoView) as unknown as ScanSceneInput['view'];
  snapshot.entities.push({ id: 'code:huge', name: 'huge', kind: 'code', parentId: view.rootEntityId, sourceRefs: [] },
    ...Array.from({ length: 2001 }, (_, i) => ({ id: `code:huge-${i}`, name: `leaf${i}`, kind: 'code' as const, parentId: 'code:huge', sourceRefs: [] })));
  const realInput: ScanSceneInput = { snapshot, view, focusEntityId: 'code:huge', boot: 'full', modeOptions: {}, childCounts: {}, unpublishedChildren: [] };
  const session = createSceneCompileSession(createSceneWorkerHealth());
  try {
    const old = session.compile(realInput, { generation: 0 });
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
    const worker = WorkerStub.latest;
    const oldScene = compileScanScene(structuredClone(realInput));
    expect(oldScene.scanGuardRefusal).toBeDefined();
    snapshot.entities.push({ id: 'code:merged', name: 'merged', kind: 'code', parentId: view.rootEntityId, sourceRefs: [] });
    const current = session.compile({ ...realInput, focusEntityId: view.rootEntityId }, { generation: 1 });
    worker.reply(oldScene);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(WorkerStub.latest).toBe(worker);
    expect(worker.postMessage.mock.lastCall![0].graph).toBeDefined();
    worker.reply({ rootEntityId: view.rootEntityId } as AtlasScene);
    expect(await current).toBeDefined(); await rejected;
  } finally { session.dispose(); }
});

it('records worker progress and timeout without settling early or exposing payload data', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const diagnostics: { metric: string; duration: number }[] = [];
  const unsubscribe = subscribeLoadTiming((metric, _start, duration) => diagnostics.push({ metric, duration }));
  const session = createSceneCompileSession(createSceneWorkerHealth());
  try {
    const result = session.compile(input, { generation: 4 });
    const worker = WorkerStub.latest;
    const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
    for (const phase of ['received', 'compiling']) worker.onmessage?.({ data: { operation: 'progress', id: request.id, generation: 4, phase } });
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await result).toBeUndefined();
    expect(diagnostics.map(sample => sample.metric)).toEqual(['atlas-worker-queue', 'atlas-worker-post-message', 'atlas-worker-received', 'atlas-worker-compiling', 'atlas-worker-timeout']);
    expect(diagnostics.every(sample => Number.isFinite(sample.duration))).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('root');
    expect(warning).toHaveBeenCalledWith('Atlas worker preparation failed', { reason: 'atlas-worker-timeout', phase: 'compiling', elapsedMs: expect.any(Number) });
  } finally { unsubscribe(); session.dispose(); }
});

it('latches a postMessage platform failure across sessions and disposal sharing browser health', async () => {
  class BrokenWorker extends WorkerStub { postMessage = vi.fn(() => { throw new Error('transport unavailable'); }); }
  vi.stubGlobal('Worker', BrokenWorker);
  const health = createSceneWorkerHealth();
  const first = createSceneCompileSession(health);
  expect(first.unavailable()).toBe(false);
  const pending = first.compile(input, { generation: 0 });
  const worker = WorkerStub.latest;
  expect(await pending).toBeUndefined(); first.dispose();
  const next = createSceneCompileSession(health);
  expect(first.unavailable()).toBe(true);
  expect(next.unavailable()).toBe(true);
  expect(await next.compile(input, { generation: 4 })).toBeUndefined();
  expect(WorkerStub.latest).toBe(worker);
  expect(worker.postMessage).toHaveBeenCalledOnce();
  next.dispose();
});
it('request-specific rejected scope does not disable later worker sessions', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const health = createSceneWorkerHealth();
  const first = createSceneCompileSession(health);
  const pending = first.compile(input, { generation: 0 });
  WorkerStub.latest.reply({ rootEntityId: 'wrong' } as AtlasScene);
  expect(await pending).toBeUndefined(); first.dispose();
  const next = createSceneCompileSession(health);
  expect(next.unavailable()).toBe(false);
  const current = next.compile(input, { generation: 0 });
  const scene = WorkerStub.latest.reply();
  expect(await current).toBe(scene); next.dispose();
});

it('a non-abandoned timeout permits a successful retry on a fresh worker across session disposal', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const health = createSceneWorkerHealth();
  const first = createSceneCompileSession(health);
  const pending = first.compile(input, { generation: 0 });
  const old = WorkerStub.latest;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await pending).toBeUndefined();
  expect(old.terminate).toHaveBeenCalledOnce();
  expect(first.unavailable()).toBe(false);
  first.dispose();
  const next = createSceneCompileSession(health);
  const retry = next.compile(input, { generation: 4 });
  const current = WorkerStub.latest;
  expect(current).not.toBe(old);
  expect(current.postMessage.mock.lastCall![0].graph).toBeDefined();
  old.reply(); const scene = current.reply();
  expect(await retry).toBe(scene);
  next.dispose();
});
it.each(['onerror', 'onmessageerror'] as const)('a transient %s resets the worker without disabling a fresh attempt', async event => {
  vi.stubGlobal('Worker', WorkerStub);
  const health = createSceneWorkerHealth();
  const session = createSceneCompileSession(health);
  const first = session.compile(input, { generation: 0 });
  const old = WorkerStub.latest;
  old[event]?.();
  expect(await first).toBeUndefined();
  expect(session.unavailable()).toBe(false);
  const retry = session.compile(input, { generation: 0 });
  const current = WorkerStub.latest;
  expect(current).not.toBe(old);
  const scene = current.reply(); expect(await retry).toBe(scene);
  session.dispose();
});

it.each(['timeout', 'onerror', 'onmessageerror'] as const)('caps three consecutive %s faults across disposed sessions without constructing a fourth worker', async fault => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const health = createSceneWorkerHealth();
  let last: WorkerStub | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = createSceneCompileSession(health);
    const pending = session.compile(input, { generation: attempt });
    const worker = WorkerStub.latest;
    expect(worker).not.toBe(last); last = worker;
    if (fault === 'timeout') await vi.advanceTimersByTimeAsync(20_000);
    else worker[fault]?.();
    expect(await pending).toBeUndefined();
    expect(session.unavailable()).toBe(attempt === 2);
    session.dispose();
  }
  const blocked = createSceneCompileSession(health);
  expect(await blocked.compile(input, { generation: 4 })).toBeUndefined();
  expect(WorkerStub.latest).toBe(last);
  blocked.dispose();
});
it('successful compilation resets a mixed transient failure streak', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession(createSceneWorkerHealth());
  const fail = async (event: 'onerror' | 'onmessageerror') => {
    const pending = session.compile(input, { generation: 0 });
    WorkerStub.latest[event]?.(); expect(await pending).toBeUndefined();
  };
  await fail('onerror'); await fail('onmessageerror');
  const successful = session.compile(input, { generation: 0 });
  const scene = WorkerStub.latest.reply(); expect(await successful).toBe(scene);
  await fail('onmessageerror'); await fail('onerror');
  expect(session.unavailable()).toBe(false);
  const retry = session.compile(input, { generation: 0 });
  const recovered = WorkerStub.latest.reply(); expect(await retry).toBe(recovered);
  session.dispose();
});
it('an abandoned timeout neither advances a two-failure streak nor reports user failure while newest work runs', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const metrics: string[] = [];
  const unsubscribe = subscribeLoadTiming(metric => metrics.push(metric));
  const session = createSceneCompileSession(createSceneWorkerHealth());
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = session.compile(input, { generation: 0 });
      WorkerStub.latest.onerror?.(); expect(await pending).toBeUndefined();
    }
    warning.mockClear(); metrics.length = 0;
    const controller = new AbortController();
    const abandoned = session.compile(input, { generation: 0, signal: controller.signal });
    const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    const old = WorkerStub.latest; controller.abort();
    const latest = session.compile(input, { generation: 0 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(session.unavailable()).toBe(false);
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(WorkerStub.latest).not.toBe(old);
    expect(warning).not.toHaveBeenCalled(); expect(metrics).not.toContain('atlas-worker-timeout');
    const scene = WorkerStub.latest.reply(); expect(await latest).toBe(scene); await rejected;
  } finally { unsubscribe(); session.dispose(); }
});
it('a successful bootstrap resets prior transient faults before a mixed third-failure cap', async () => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', WorkerStub);
  const health = createSceneWorkerHealth();
  const session = createSceneCompileSession(health);
  const eventFault = async (event: 'onerror' | 'onmessageerror') => {
    const pending = session.compile(input, { generation: 0 });
    WorkerStub.latest[event]?.(); expect(await pending).toBeUndefined();
  };
  await eventFault('onerror'); await eventFault('onmessageerror');
  const bootstrap = session.initializeNeighborhood(packet, {}, { generation: 2 });
  replyInitialization(WorkerStub.latest); expect(await bootstrap).toMatchObject({ status: 'ready' });
  for (const event of ['onerror', 'onmessageerror'] as const) {
    const pending = session.compile(input, { generation: 2 });
    WorkerStub.latest[event]?.(); expect(await pending).toBeUndefined();
  }
  expect(session.unavailable()).toBe(false);
  const timed = session.compile(input, { generation: 2 });
  await vi.advanceTimersByTimeAsync(20_000); expect(await timed).toBeUndefined();
  expect(session.unavailable()).toBe(true);
  session.dispose();
});

it('correlates worker clocks, main receipt/handling and post ACK after a job has settled', async()=>{
  const {subscribeSceneWorkerTiming}=await import('../performance/sceneWorkerTimings');
  const {createPerformanceRecorder}=await import('../performance/recorder');
  const recorder=createPerformanceRecorder();const stop=subscribeSceneWorkerTiming(job=>recorder.recordWorkerJob(job));
  vi.stubGlobal('Worker',WorkerStub);
  const session=createSceneCompileSession(createSceneWorkerHealth());
  try {
    const pending=session.compile(input,{generation:7});const worker=WorkerStub.latest;
    const request=worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
    expect(request.diagnostics).toBe(true);
    worker.onmessage!({data:{operation:'progress',id:request.id,generation:7,phase:'received',workerPhaseAt:100,clocks:{workerReceived:100,workerModuleReady:90,workerTimeOrigin:0,mainSendBefore:0}}});
    worker.reply();await pending;
    worker.onmessage!({data:{operation:'timing',id:request.id,generation:7,clocks:{workerResultPostBefore:200,workerResultPostAfter:220}}});
    const trace=recorder.report().workerJobs[0];
    expect(trace).toMatchObject({jobId:request.id,generation:7,outcome:'success',graphSent:true,workerFresh:true});
    expect(trace.clocks.workerResultPostAfter).toBe(220);
    expect(trace.clocks.mainSendBefore).toBeGreaterThan(0);
    expect(trace.clocks.mainHandleEnd).toBeGreaterThanOrEqual(trace.clocks.mainResultHandled!);
    expect(trace.clocks.mainHandleEnd).toBeGreaterThanOrEqual(trace.clocks.mainReceive!);
    expect(trace.phases.received).toMatchObject({worker:100,mainReceive:expect.any(Number),mainHandleEnd:expect.any(Number)});
    const second=session.compile(input,{generation:7});worker.reply();await second;
    const traces=recorder.report().workerJobs;
    expect(traces[1]).toMatchObject({workerId:trace.workerId,workerFresh:false,graphSent:false});
    expect(traces[1].correlationId).not.toBe(trace.correlationId);
  } finally {session.dispose();stop();}
});

it('retains queued cancellation and active timeout clocks without changing job behavior',async()=>{
  const {subscribeSceneWorkerTiming}=await import('../performance/sceneWorkerTimings');
  const {createPerformanceRecorder}=await import('../performance/recorder');
  const recorder=createPerformanceRecorder();const stop=subscribeSceneWorkerTiming(job=>recorder.recordWorkerJob(job));
  vi.useFakeTimers();vi.stubGlobal('Worker',WorkerStub);
  const session=createSceneCompileSession(createSceneWorkerHealth());
  try {
    const active=session.compile(input,{generation:0});
    const controller=new AbortController();
    const queued=session.compile(input,{generation:0,priority:'speculative',signal:controller.signal});
    const rejected=expect(queued).rejects.toMatchObject({name:'AbortError'});controller.abort();await rejected;
    await vi.advanceTimersByTimeAsync(20000);expect(await active).toBeUndefined();
    const traces=recorder.report().workerJobs;
    expect(traces[0]).toMatchObject({outcome:'timeout',clocks:{mainTerminal:expect.any(Number)}});
    expect(traces[1]).toMatchObject({outcome:'cancelled',clocks:{mainTerminal:expect.any(Number)}});
    expect(traces[1].clocks.mainSendBefore).toBeUndefined();
  } finally {session.dispose();stop();}
});
