import { afterEach, expect, it, vi } from 'vitest';
import { compileSceneOffThread, createSceneCompileSession } from './compileSceneOffThread';
import type { ScanSceneInput } from './scanScene';
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
