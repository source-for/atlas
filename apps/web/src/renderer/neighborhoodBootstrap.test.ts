import { subscribeLoadTiming, type LoadMetric } from '../performance/loadTimings';
import { afterEach, expect, it, vi } from 'vitest';
import { sliceArchitectureNeighborhood, validateNeighborhoodPacket, type ArchitectureNeighborhoodPacket, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { initializeNeighborhoodBootstrap } from './neighborhoodBootstrap';
import { compileScanScene, type ScanSceneInput } from './scanScene';
import { compileScanNeighborhoodFixture, loadScanNeighborhoodFixture, ScanFixtureError, type ScanNeighborhoodHost } from './scanFixture';
import type { SceneWorkerRequest, SceneWorkerResponse } from './sceneCompileProtocol';

function largePacket(): ArchitectureNeighborhoodPacket {
  const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
  const view = structuredClone(demoView) as unknown as ArchitectureView;
  const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
  snapshot.entities.push(...Array.from({ length: 150 }, (_, index) => ({ id: `code:bootstrap-${index}`, name: `declaration${index}`, kind: 'code' as const, parentId: owner.id, sourceRefs: [] })));
  const packet = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId });
  // Published roots may contain the complete graph, while their first view is L1/L2.
  return { ...packet, snapshot, view, childCounts: { ...packet.childCounts, [owner.id]: 150 } };
}
function hostFor(packet: ArchitectureNeighborhoodPacket): ScanNeighborhoodHost {
  return { loadNeighborhood: async () => packet, loadExcerpts: async () => undefined, loadStory: async () => structuredClone(demoStory) };
}
class ProcessingWorker {
  static instances: ProcessingWorker[] = [];
  static mode: 'ready' | 'failed' | 'silent' = 'ready';
  onmessage?: (event: { data: SceneWorkerResponse }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  graph?: ScanSceneInput['snapshot'];
  terminated = false;
  terminate = vi.fn(() => { this.terminated = true; this.graph = undefined; });
  postMessage = vi.fn((request: SceneWorkerRequest) => {
    const copied = structuredClone(request);
    queueMicrotask(() => {
      if (this.terminated || ProcessingWorker.mode === 'silent') return;
      if ('operation' in copied) {
        const result = ProcessingWorker.mode === 'failed' ? { status: 'failed' as const } : initializeNeighborhoodBootstrap(copied.packet, copied.modeOptions);
        if (result.status === 'ready') this.graph = copied.packet.snapshot;
        this.onmessage?.({ data: structuredClone({ operation: 'initializeNeighborhood', id: copied.id, generation: copied.generation, ...result }) });
      } else {
        this.graph = copied.graph?.snapshot ?? this.graph;
        const scene = compileScanScene({ ...copied.input, snapshot: this.graph! });
        this.onmessage?.({ data: structuredClone({ id: copied.id, generation: copied.generation, ok: true, scene, durationMs: 1 }) });
      }
    });
  });
  constructor() { ProcessingWorker.instances.push(this); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); ProcessingWorker.instances = []; ProcessingWorker.mode = 'ready'; });

it('worker bootstrap has identical first-scene geometry/protocol to the existing large-packet slice', () => {
  const packet = largePacket();
  expect(packet.snapshot.entities.length).toBeGreaterThan(128);
  expect(validateNeighborhoodPacket(packet)).toEqual([]);
  const first = sliceArchitectureNeighborhood(packet.snapshot, packet.view, { focusEntityId: packet.view.rootEntityId, maxBand: 'container' });
  const options = { targetAspect: 1.6 };
  const expected = compileScanScene({ snapshot: first.snapshot, view: first.view, focusEntityId: packet.view.rootEntityId, boot: 'neighborhood', modeOptions: options, childCounts: packet.childCounts, unpublishedChildren: first.unpublishedChildren ?? [] });
  const result = initializeNeighborhoodBootstrap(packet, options);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('Expected ready');
  expect(result.scene).toEqual(expected);
  for (const duration of [result.validateDurationMs, result.sliceDurationMs, result.compileDurationMs]) expect(duration).toBeGreaterThanOrEqual(0);
});
it('keeps every invalid issue in original order and skips slicing/compilation', () => {
  const packet = largePacket();
  packet.snapshot.entities[0]!.name = '';
  packet.snapshot.entities[1]!.id = packet.snapshot.entities[0]!.id;
  const issues = validateNeighborhoodPacket(packet);
  expect(issues.length).toBeGreaterThan(1);
  const result = initializeNeighborhoodBootstrap(packet, {});
  expect(result).toEqual({ status: 'invalid', issues, validateDurationMs: expect.any(Number) });
  expect(() => compileScanNeighborhoodFixture(packet, demoStory, hostFor(packet))).toThrow(ScanFixtureError);
});
it('constructs the fixture only after validation and enriches with the original full graph without uploading again', async () => {
  vi.stubGlobal('Worker', ProcessingWorker);
  const packet = largePacket();
  const fixture = await loadScanNeighborhoodFixture(hostFor(packet), undefined, { targetAspect: 1.6 });
  const worker = ProcessingWorker.instances[0]!;
  expect(ProcessingWorker.instances).toHaveLength(1);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const initial = fixture.createScene(fixture.navigation.rootEntityId);
  const expected = initializeNeighborhoodBootstrap(packet, { targetAspect: 1.6 });
  expect(expected.status).toBe('ready');
  if (expected.status !== 'ready') throw new Error('Expected ready');
  expect(initial).toEqual(expected.scene);
  // prepareInitialScene must not replace the adopted full graph with an older slim generation.
  await fixture.prepareInitialScene();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const enriched = await fixture.enrichInitialScene();
  const request = worker.postMessage.mock.calls[1]![0];
  expect('operation' in request).toBe(false);
  expect('graph' in request ? request.graph : undefined).toBeUndefined();
  expect(worker.graph?.entities.length).toBe(packet.snapshot.entities.length);
  expect(enriched).toEqual(compileScanScene({ snapshot: packet.snapshot, view: packet.view, focusEntityId: packet.view.rootEntityId, boot: 'neighborhood', modeOptions: { targetAspect: 1.6 }, childCounts: packet.childCounts, unpublishedChildren: packet.unpublishedChildren ?? [] }));
  fixture.disposeSceneWorker(); expect(worker.terminate).toHaveBeenCalledOnce();
});
it('invalid worker validation throws the same formatted error as the public synchronous API', async () => {
  vi.stubGlobal('Worker', ProcessingWorker);
  const packet = largePacket(); packet.snapshot.entities[0]!.name = '';
  let expected: unknown;
  try { compileScanNeighborhoodFixture(packet, demoStory, hostFor(packet)); } catch (error) { expected = error; }
  await expect(loadScanNeighborhoodFixture(hostFor(packet), undefined)).rejects.toMatchObject({ name: 'ScanFixtureError', issues: (expected as ScanFixtureError).issues, message: (expected as ScanFixtureError).message });
  expect(ProcessingWorker.instances).toHaveLength(1);
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
});
it('unsupported and failed workers use the original synchronous validator rather than accepting an invalid packet', async () => {
  const packet = largePacket(); packet.snapshot.entities[0]!.name = '';
  vi.stubGlobal('Worker', undefined);
  await expect(loadScanNeighborhoodFixture(hostFor(packet), undefined)).rejects.toBeInstanceOf(ScanFixtureError);
  vi.stubGlobal('Worker', ProcessingWorker); ProcessingWorker.mode = 'failed';
  await expect(loadScanNeighborhoodFixture(hostFor(packet), undefined)).rejects.toBeInstanceOf(ScanFixtureError);
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
});
it('valid unsupported and failed initializers preserve the synchronous first-scene fallback', async () => {
  const packet = largePacket();
  const expected = initializeNeighborhoodBootstrap(packet, {});
  if (expected.status !== 'ready') throw new Error('Expected ready');
  vi.stubGlobal('Worker', undefined);
  const unsupported = await loadScanNeighborhoodFixture(hostFor(packet), undefined);
  expect(unsupported.createScene(unsupported.navigation.rootEntityId)).toEqual(expected.scene);
  unsupported.disposeSceneWorker();
  vi.stubGlobal('Worker', ProcessingWorker); ProcessingWorker.mode = 'failed';
  const failed = await loadScanNeighborhoodFixture(hostFor(packet), undefined);
  expect(failed.createScene(failed.navigation.rootEntityId)).toEqual(expected.scene);
  expect(ProcessingWorker.instances).toHaveLength(1);
  expect(ProcessingWorker.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  failed.disposeSceneWorker();
});
it('disposes adopted graph if story construction fails and releases a pending worker on fetch failure', async () => {
  vi.stubGlobal('Worker', ProcessingWorker);
  const packet = largePacket();
  await expect(loadScanNeighborhoodFixture({ ...hostFor(packet), loadStory: async () => null }, undefined)).rejects.toBeInstanceOf(ScanFixtureError);
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  ProcessingWorker.mode = 'silent';
  const failure = new Error('story unavailable');
  await expect(loadScanNeighborhoodFixture({ ...hostFor(packet), loadStory: async () => { throw failure; } }, undefined)).rejects.toBe(failure);
  expect(ProcessingWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
  await expect(loadScanNeighborhoodFixture({ ...hostFor(packet), loadStory: () => { throw failure; } }, undefined)).rejects.toBe(failure);
  expect(ProcessingWorker.instances[2]!.terminate).toHaveBeenCalledOnce();
});
it('cancels a pending validator without synchronous fallback or fixture publication', async () => {
  vi.stubGlobal('Worker', ProcessingWorker); ProcessingWorker.mode = 'silent';
  const controller = new AbortController();
  const pending = loadScanNeighborhoodFixture(hostFor(largePacket()), undefined, {}, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve();
  expect(ProcessingWorker.instances).toHaveLength(1);
  controller.abort(); await rejection;
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
});

it('aborts promptly while story fetch remains pending after worker validation has finished', async () => {
  vi.stubGlobal('Worker', ProcessingWorker);
  const controller = new AbortController();
  let releaseStory: (story: unknown) => void;
  const story = new Promise<unknown>(resolve => { releaseStory = resolve; });
  const packet = largePacket();
  const pending = loadScanNeighborhoodFixture({ ...hostFor(packet), loadStory: () => story }, undefined, {}, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(ProcessingWorker.instances[0]!.graph).toBeDefined();
  controller.abort(); await rejection;
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  releaseStory!(demoStory);
  await Promise.resolve();
  expect(ProcessingWorker.instances).toHaveLength(1);
});

it('a hung bootstrap spends one timeout budget before the real fixture compiles synchronously', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', ProcessingWorker); ProcessingWorker.mode = 'silent';
  const packet = largePacket();
  const expected = initializeNeighborhoodBootstrap(packet, {});
  if (expected.status !== 'ready') throw new Error('Expected ready');
  const metrics: LoadMetric[] = [];
  const stop = subscribeLoadTiming(metric => metrics.push(metric));
  const pending = loadScanNeighborhoodFixture(hostFor(packet), undefined);
  await vi.advanceTimersByTimeAsync(20_000);
  const fixture = await pending;
  expect(ProcessingWorker.instances).toHaveLength(1);
  expect(ProcessingWorker.instances[0]!.postMessage).toHaveBeenCalledTimes(1);
  expect(ProcessingWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  expect(fixture.createScene(fixture.navigation.rootEntityId)).toEqual(expected.scene);
  expect(vi.getTimerCount()).toBe(0);
  expect(metrics).toContain('atlas-worker-bootstrap-round-trip');
  expect(metrics).toContain('atlas-worker-bootstrap-fallback');
  expect(metrics).not.toContain('atlas-worker-round-trip');
  stop();
  fixture.disposeSceneWorker();
});
