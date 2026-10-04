import { cacheableNeighborhoodScene } from './lazyBandCompile';
import { afterEach, expect, it, vi } from 'vitest';
import { compileSceneOffThread, createSceneCompileSession } from './compileSceneOffThread';
import { compileScanScene, type ScanSceneInput } from './scanScene';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import type { AtlasScene } from './types';
import type { SceneCompileRequest } from './sceneCompileProtocol';
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

it('finishes abandoned selected CPU and starts only the latest bounded queued request without restart', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
  const scene = await session.compile(realInput, { generation: 0 });
  expect(scene?.rootEntityId).toBe(view.rootEntityId);
  expect(scene?.scanGuardRefusal).toMatchObject({ requestedFocusId: 'code:huge', fallbackFocusId: view.rootEntityId, entityCount: 2002 });
  expect(WorkerStub.latest.terminate).not.toHaveBeenCalled();
  expect(await session.compile(realInput, { generation: 0 })).toEqual(scene);
  expect(WorkerStub.latest.postMessage.mock.lastCall![0].graph).toBeUndefined();
  session.dispose();
  vi.stubGlobal('Worker', WorkerStub);
  for (const patch of [{ requestedFocusId: 'other' }, { fallbackFocusId: 'other' }, { entityCount: 2001 }, { relationCount: 1 }]) {
    const invalidSession = createSceneCompileSession();
    const pending = invalidSession.compile(realInput, { generation: 0 });
    WorkerStub.latest.reply({ ...scene!, scanGuardRefusal: { ...scene!.scanGuardRefusal!, ...patch } });
    expect(await pending).toBeUndefined();
    expect(WorkerStub.latest.terminate).toHaveBeenCalledOnce();
    invalidSession.dispose();
  }
});

it('generation changes abandon selected work without restart and transfer the newer graph after it finishes', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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

it('reuses a retained patch-free cache copy but clones a modified copy', async () => {
  vi.stubGlobal('Worker', WorkerStub);
  const session = createSceneCompileSession();
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
  const session = createSceneCompileSession();
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
