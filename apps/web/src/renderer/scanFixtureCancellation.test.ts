import { afterEach, expect, it, vi } from 'vitest';
import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView, type ArchitectureNeighborhoodPacket } from '@okie/architecture';
import snapshotDoc from '../../../../fixtures/architecture/demo-snapshot.json';
import viewDoc from '../../../../fixtures/architecture/demo-view.json';
import storyDoc from '../../../../fixtures/architecture/demo-story.json';
import { compileScanNeighborhoodFixture, fetchScanNeighborhoodHost, fetchScanTrioLoader, loadScanFixture } from './scanFixture';

vi.mock('./compileSceneOffThread', async importOriginal => {
  const actual = await importOriginal<typeof import('./compileSceneOffThread')>();
  return { ...actual, createSceneCompileSession: () => actual.createSceneCompileSession(actual.createSceneWorkerHealth()) };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const focus = 'code:web-shell:app';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function packets() {
  const snapshot = structuredClone(snapshotDoc) as unknown as ArchitectureSnapshot;
  const view = structuredClone(viewDoc) as unknown as ArchitectureView;
  return {
    initial: sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId, maxBand: 'container' }),
    deep: sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: focus }),
  };
}
function fixtureWithDeferredHost() {
  const { initial, deep } = packets();
  const calls: { work: ReturnType<typeof deferred<ArchitectureNeighborhoodPacket>>; signal?: AbortSignal }[] = [];
  const fixture = compileScanNeighborhoodFixture(initial, storyDoc, {
    loadNeighborhood: async (_focus, signal) => { const work = deferred<ArchitectureNeighborhoodPacket>(); calls.push({ work, signal }); return work.promise; },
    loadExcerpts: async () => undefined, loadStory: async () => storyDoc,
  });
  expect(fixture.snapshot.entities.some(entity => entity.id === focus)).toBe(false);
  return { fixture, calls, deep };
}
it('one cancelled waiter releases immediately while another keeps the shared host request alive', async () => {
  const { fixture, calls, deep } = fixtureWithDeferredHost();
  const first = new AbortController(); const second = new AbortController();
  const old = fixture.ensureNeighborhood(focus, first.signal);
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  const current = fixture.ensureNeighborhood(focus, second.signal);
  first.abort(); await rejected;
  expect(calls).toHaveLength(1); expect(calls[0]!.signal!.aborted).toBe(false);
  calls[0]!.work.resolve(deep); await current;
  expect(fixture.getSceneGeneration()).toBe(1);
  expect(fixture.snapshot.entities.some(entity => entity.id === focus)).toBe(true);
  fixture.disposeSceneWorker();
});
it('all cancelled waiters abort the host immediately and ignore its late result', async () => {
  const { fixture, calls, deep } = fixtureWithDeferredHost();
  const first = new AbortController(); const second = new AbortController();
  const a = fixture.ensureNeighborhood(focus, first.signal); const b = fixture.ensureNeighborhood(focus, second.signal);
  const rejected = [expect(a).rejects.toMatchObject({ name: 'AbortError' }), expect(b).rejects.toMatchObject({ name: 'AbortError' })];
  first.abort(); second.abort(); await Promise.all(rejected);
  expect(calls[0]!.signal!.aborted).toBe(true);
  calls[0]!.work.resolve(deep); await Promise.resolve(); await Promise.resolve();
  expect(fixture.getSceneGeneration()).toBe(0);
  expect(fixture.snapshot.entities.some(entity => entity.id === focus)).toBe(false);
  fixture.disposeSceneWorker();
});
it('old completion cannot merge data or clear a replacement shared fetch', async () => {
  const { fixture, calls, deep } = fixtureWithDeferredHost();
  const controller = new AbortController();
  const old = fixture.ensureNeighborhood(focus, controller.signal);
  const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejected;
  const current = fixture.ensureNeighborhood(focus);
  calls[0]!.work.resolve(deep); await Promise.resolve(); await Promise.resolve();
  const shared = fixture.ensureNeighborhood(focus);
  expect(calls).toHaveLength(2); expect(fixture.getSceneGeneration()).toBe(0);
  calls[1]!.work.resolve(deep); await Promise.all([current, shared]);
  expect(fixture.getSceneGeneration()).toBe(1);
  fixture.disposeSceneWorker();
});
it('disposal releases signal-free waiters and prevents late host data merging', async () => {
  const { fixture, calls, deep } = fixtureWithDeferredHost();
  const pending = fixture.ensureNeighborhood(focus);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  fixture.disposeSceneWorker(); await rejected;
  expect(calls[0]!.signal!.aborted).toBe(true);
  calls[0]!.work.resolve(deep); await Promise.resolve(); await Promise.resolve();
  expect(fixture.getSceneGeneration()).toBe(0);
});
it('runtime neighborhood fetch receives an abort signal and releases even when fetch ignores it', async () => {
  const response = deferred<Response>(); let received: AbortSignal | undefined;
  const fetchImpl = vi.fn((_url, init) => { received = init?.signal as AbortSignal; return response.promise; }) as unknown as typeof fetch;
  const host = fetchScanNeighborhoodHost('example', fetchImpl);
  const controller = new AbortController();
  const pending = host.loadNeighborhood(focus, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(received).toBe(controller.signal); controller.abort(); await rejected;
  response.resolve(new Response('{}'));
});
it('full trio loader forwards the boot signal to each actual fetch and rejects before validation after cancellation', async () => {
  const received: AbortSignal[] = [];
  const fetchImpl = vi.fn((_url, init) => { received.push(init?.signal as AbortSignal); return new Promise<Response>(() => {}); }) as unknown as typeof fetch;
  // Catalog fetch is separate; keep it unavailable without network traffic.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  const controller = new AbortController();
  const pending = loadScanFixture(fetchScanTrioLoader('example', fetchImpl), {}, undefined, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(received).toEqual([controller.signal, controller.signal, controller.signal]);
  controller.abort(); await rejected;
});
it('cancelled full boot disposes its owned worker while initial preparation is active', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  const started = deferred<void>(); let worker: { terminate: ReturnType<typeof vi.fn> } | undefined;
  class HangingWorker {
    onmessage = null; onerror = null; terminate = vi.fn();
    constructor() { worker = this; }
    postMessage() { started.resolve(); }
  }
  vi.stubGlobal('Worker', HangingWorker);
  const controller = new AbortController();
  const docs = { snapshot: snapshotDoc, view: viewDoc, story: storyDoc };
  const pending = loadScanFixture(async name => structuredClone(docs[name]), {}, undefined, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await started.promise; controller.abort(); await rejected;
  expect(worker!.terminate).toHaveBeenCalledOnce();
});
