import { afterEach, expect, it, vi } from 'vitest';
import { compileSceneOffThread, createSceneCompileSession } from './compileSceneOffThread';
import type { ScanSceneInput } from './scanScene';
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
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps a worker and graph across compiles and reuses worker-owned previous scenes', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
  const result = compileSceneOffThread(input, controller.signal);
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); WorkerStub.latest.reply(); await rejection;
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
});
it('falls back for unsupported workers, errors, wrong scope and timeout', async () => {
  vi.stubGlobal('Worker', undefined);
  expect(await compileSceneOffThread(input)).toBeUndefined();
  vi.stubGlobal('Worker', WorkerStub);
  let result = compileSceneOffThread(input);
  WorkerStub.latest.onerror?.(); expect(await result).toBeUndefined();
  result = compileSceneOffThread(input);
  WorkerStub.latest.reply({ rootEntityId: 'different' } as AtlasScene); expect(await result).toBeUndefined();
  vi.useFakeTimers(); result = compileSceneOffThread(input);
  await vi.advanceTimersByTimeAsync(20_000); expect(await result).toBeUndefined();
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
});

it('rejects disposed sessions without triggering synchronous fallback', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession();
  const active = session.compile(input, { generation: 0 });
  const rejected = expect(active).rejects.toMatchObject({ name: 'AbortError' });
  session.dispose();
  await rejected;
  await expect(session.compile(input, { generation: 0 })).rejects.toMatchObject({ name: 'AbortError' });
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
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
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
  const result = session.initializeNeighborhood(packet, {}, { generation: 2 });
  replyInitialization(WorkerStub.latest, 'invalid');
  expect(await result).toEqual({ status: 'invalid', issues: [{ path: 'snapshot.entities[0]', message: 'invalid' }] });
  expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce(); session.dispose();
});
it('initialization fallback is limited to unsupported/error/timeout failures', async () => {
  vi.stubGlobal('Worker', undefined);
  let session = createSceneCompileSession();
  expect(await session.initializeNeighborhood(packet, {}, { generation: 2 })).toBeUndefined(); session.dispose();
  vi.stubGlobal('Worker', WorkerStub);
  for (const fail of ['status', 'error', 'timeout']) {
    if (fail === 'timeout') vi.useFakeTimers();
    session = createSceneCompileSession();
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
    const session = createSceneCompileSession();
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
