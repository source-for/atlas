import { workerSceneOrigin } from './lazyBandCompile';
import type { ArchitectureNeighborhoodPacket, ValidationIssue } from '@okie/architecture';
import { measureAtlasAsyncPhase, measureAtlasPhase, recordAtlasWorkerCompile, recordAtlasWorkerPhase, recordSceneWorkerDiagnostic, type SceneWorkerDiagnosticMetric } from '../performance/loadTimings';
import { guardScanCompile, type ScanSceneInput, type ScanModeOptions } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneWorkerRequest, SceneWorkerResponse, SceneWorkerProgress } from './sceneCompileProtocol';

export type SceneCompileOptions = { generation: number; priority?: 'selected' | 'speculative'; signal?: AbortSignal };
export type NeighborhoodInitialization = { status: 'ready'; scene: AtlasScene } | { status: 'invalid'; issues: ValidationIssue[] };
export type SceneCompileSession = {
  /** A module-lifetime platform failure requires reload rather than another request. */
  unavailable(): boolean;
  compile(input: ScanSceneInput, options: SceneCompileOptions): Promise<AtlasScene | undefined>;
  /** Only fresh, exclusively owned packets may be supplied: do not publish/mutate
   * the main-thread packet while its worker clone is being validated. */
  initializeNeighborhood(packet: ArchitectureNeighborhoodPacket, modeOptions: ScanModeOptions, options: SceneCompileOptions): Promise<NeighborhoodInitialization | undefined>;
  dispose(): void;
};
type JobInput = { kind: 'compile'; input: ScanSceneInput } | { kind: 'initialize'; packet: ArchitectureNeighborhoodPacket; modeOptions: ScanModeOptions };
type JobResult = AtlasScene | NeighborhoodInitialization | undefined;
type Job = {
  queuedAt: number; id: number; payload: JobInput; options: SceneCompileOptions;
  resolve(result: JobResult): void; reject(reason: unknown): void;
  abort: () => void; timer?: ReturnType<typeof setTimeout>; abandoned?: boolean; settled?: boolean;
};
const snapshotFor = (payload: JobInput) => payload.kind === 'compile' ? payload.input.snapshot : payload.packet.snapshot;

/** One graph generation, two retained scenes and at most one queued job per priority.
 * A caller must advance generation after mutating its snapshot. Active synchronous
 * selected work finishes after its caller is abandoned; only the latest queued
 * request starts next. Speculative work may be terminated for selected work.
 * undefined requests the caller's existing fallback. Superseded work rejects AbortError.
 */
/** One browser module lifetime, shared by every fixture and compatibility session.
 * A failed worker stays unavailable until reload; disposal never clears health. */
export function createSceneWorkerHealth() {
  let broken = false;
  return { unavailable: () => broken, markBroken: () => { broken = true; } };
}
const browserSceneWorkerHealth = createSceneWorkerHealth();
export function createSceneCompileSession(health = browserSceneWorkerHealth): SceneCompileSession {
  let worker: Worker | undefined;
  let workerGeneration: number | undefined;
  let workerSnapshot: ScanSceneInput['snapshot'] | undefined;
  let latestSnapshot: ScanSceneInput['snapshot'] | undefined;
  let latestGeneration: number | undefined;
  let active: Job | undefined;
  let selected: Job | undefined;
  let speculative: Job | undefined;
  let disposed = false;
  let nextId = 0;
  const scenes = new Map<AtlasScene, number>();
  const settle = (job: Job, result?: JobResult, aborted = false) => {
    if (job.settled) return;
    job.settled = true;
    if (!job.abandoned) clearTimeout(job.timer);
    job.options.signal?.removeEventListener('abort', job.abort);
    if (aborted) job.reject(job.options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    else job.resolve(result);
  };
  const reset = () => {
    worker?.terminate(); worker = undefined; workerGeneration = undefined; workerSnapshot = undefined; scenes.clear();
  };
  const retainScene = (job: Job, scene: AtlasScene) => {
    scenes.set(scene, job.id);
    while (scenes.size > 2) scenes.delete(scenes.keys().next().value!);
  };
  const pump = () => {
    if (disposed || active) return;
    const job = selected ?? speculative;
    if (!job) return;
    if (selected === job) selected = undefined; else speculative = undefined;
    if (health.unavailable()) { settle(job); pump(); return; }
    active = job;
    recordSceneWorkerDiagnostic('atlas-worker-queue', job.queuedAt);
    const startedAt = performance.now();
    let lastPhase: SceneWorkerProgress['phase'] | 'queued' = 'queued';
    const fail = (reason: SceneWorkerDiagnosticMetric = 'atlas-worker-response-error') => {
      if (active !== job) return;
      if (reason !== 'atlas-worker-response-error') health.markBroken();
      recordSceneWorkerDiagnostic(reason, startedAt);
      // Fixed reason/phase and scalar elapsed time survive performance-ring eviction.
      console.warn('Atlas worker preparation failed', { reason, phase: lastPhase, elapsedMs: Math.round(performance.now() - startedAt) });
      clearTimeout(job.timer); active = undefined; reset(); settle(job); pump();
    };
    if (!worker) {
      if (typeof Worker === 'undefined') { fail('atlas-worker-unavailable'); return; }
      try { worker = new Worker(new URL('./sceneCompileWorker.ts', import.meta.url), { type: 'module' }); }
      catch { fail('atlas-worker-unavailable'); return; }
    }
    const currentWorker = worker;
    currentWorker.onmessage = event => {
      if (worker !== currentWorker || active !== job) return;
      const result = event.data as SceneWorkerResponse;
      if (result.id !== job.id || result.generation !== job.options.generation) return;
      if ('operation' in result && result.operation === 'progress') {
        lastPhase = result.phase;
        recordSceneWorkerDiagnostic(`atlas-worker-${result.phase}`, startedAt);
        return;
      }
      // The caller is gone, but worker retention still advances. Do not validate
      // an older guarded result against a snapshot that has since been merged.
      if (job.abandoned) {
        if (!('operation' in result) && result.ok && result.scene) retainScene(job, result.scene);
        clearTimeout(job.timer); active = undefined; pump(); return;
      }
      if (job.payload.kind === 'initialize') {
        if (!('operation' in result) || result.status === 'failed') { fail(); return; }
        recordAtlasWorkerPhase('atlas-worker-validate', result.validateDurationMs);
        if (result.status === 'invalid') {
          active = undefined; reset(); settle(job, { status: 'invalid', issues: result.issues }); pump(); return;
        }
        if (result.scene.rootEntityId !== job.payload.packet.view.rootEntityId) { fail(); return; }
        recordAtlasWorkerPhase('atlas-worker-slice', result.sliceDurationMs);
        recordAtlasWorkerCompile(result.compileDurationMs);
        // The worker retained the full validated snapshot, not its temporary L1 slice.
        workerGeneration = job.options.generation;
        workerSnapshot = job.payload.packet.snapshot;
        scenes.clear(); retainScene(job, result.scene);
        active = undefined; settle(job, { status: 'ready', scene: result.scene }); pump(); return;
      }
      if ('operation' in result) { fail(); return; }
      const requested = job.payload.input;
      let validScope = result.scene?.rootEntityId === requested.focusEntityId;
      if (!validScope && result.scene?.scanGuardRefusal) {
        const expected = guardScanCompile(requested.snapshot, requested.focusEntityId, requested.view.rootEntityId);
        const actual = result.scene.scanGuardRefusal;
        validScope = Boolean(expected.refusal && result.scene.rootEntityId === expected.focusEntityId
          && actual.requestedFocusId === expected.refusal.requestedFocusId
          && actual.fallbackFocusId === expected.refusal.fallbackFocusId
          && actual.entityCount === expected.refusal.entityCount
          && actual.relationCount === expected.refusal.relationCount);
      }
      if (!result.ok || !result.scene || !validScope) { fail(); return; }
      if (typeof result.durationMs === 'number') recordAtlasWorkerCompile(result.durationMs);
      retainScene(job, result.scene);
      clearTimeout(job.timer);
      active = undefined; settle(job, result.scene); pump();
    };
    currentWorker.onerror = () => fail('atlas-worker-runtime-error');
    currentWorker.onmessageerror = () => fail('atlas-worker-message-error');
    job.timer = setTimeout(() => fail('atlas-worker-timeout'), 20_000);
    let request: SceneWorkerRequest;
    let needsGraph = false;
    const snapshot = snapshotFor(job.payload);
    if (job.payload.kind === 'initialize') {
      request = { operation: 'initializeNeighborhood', id: job.id, generation: job.options.generation,
        packet: job.payload.packet, modeOptions: job.payload.modeOptions };
    } else {
      const { snapshot: _snapshot, view, childCounts, unpublishedChildren, ...input } = job.payload.input;
      needsGraph = workerGeneration !== job.options.generation || workerSnapshot !== snapshot;
      const previousId = needsGraph || !input.previous ? undefined : scenes.get(workerSceneOrigin(input.previous));
      if (previousId !== undefined) delete input.previous;
      request = { id: job.id, generation: job.options.generation, input, previousId,
        ...(needsGraph ? { graph: { snapshot, view, childCounts, unpublishedChildren } } : {}) };
    }
    try {
      measureAtlasPhase('atlas-worker-post-message', () => currentWorker.postMessage(request));
      if (needsGraph) { workerGeneration = job.options.generation; workerSnapshot = snapshot; scenes.clear(); }
    } catch { fail('atlas-worker-post-message-error'); }
  };
  const cancel = (job: Job, aborted = true) => {
    if (active === job) {
      if (!disposed && job.payload.kind === 'compile' && job.options.priority !== 'speculative') {
        job.abandoned = true; settle(job, undefined, aborted); return;
      }
      clearTimeout(job.timer); active = undefined; reset();
    }
    if (selected === job) selected = undefined;
    if (speculative === job) speculative = undefined;
    settle(job, undefined, aborted);
  };
  const enqueue = (payload: JobInput, options: SceneCompileOptions): Promise<JobResult> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (disposed) return Promise.reject(new DOMException('Disposed', 'AbortError'));
    if (health.unavailable()) return Promise.resolve(undefined);
    const snapshot = snapshotFor(payload);
    if (latestGeneration !== undefined && options.generation < latestGeneration) return Promise.reject(new DOMException('Stale generation', 'AbortError'));
    if (latestGeneration !== options.generation || latestSnapshot !== snapshot) {
      latestGeneration = options.generation;
      latestSnapshot = snapshot;
      if (active) cancel(active);
      if (selected) cancel(selected);
      if (speculative) cancel(speculative);
    }
    return new Promise((resolve, reject) => {
      const job: Job = { queuedAt: performance.now(), id: ++nextId, payload, options, resolve, reject, abort: () => { cancel(job, true); pump(); } };
      options.signal?.addEventListener('abort', job.abort, { once: true });
      if (options.priority === 'speculative') {
        if (speculative) cancel(speculative);
        speculative = job;
      } else {
        if (selected) cancel(selected);
        if (active) cancel(active);
        selected = job;
      }
      pump();
    });
  };
  return {
    unavailable: () => health.unavailable(),
    compile(input, options) {
      return enqueue({ kind: 'compile', input }, options) as Promise<AtlasScene | undefined>;
    },
    initializeNeighborhood(packet, modeOptions, options) {
      // Attempt duration includes failure, timeout and cancellation. The fixture
      // separately records atlas-worker-bootstrap-fallback when it uses sync work.
      return measureAtlasAsyncPhase('atlas-worker-bootstrap-round-trip', () =>
        enqueue({ kind: 'initialize', packet, modeOptions }, options)) as Promise<NeighborhoodInitialization | undefined>;
    },
    dispose() {
      disposed = true;
      if (active) cancel(active);
      if (selected) cancel(selected);
      if (speculative) cancel(speculative);
      latestSnapshot = undefined;
      reset();
    },
  };
}

/** Compatibility helper for isolated callers; fixtures should own a session. */
export async function compileSceneOffThread(input: ScanSceneInput, signal?: AbortSignal, health = browserSceneWorkerHealth): Promise<AtlasScene | undefined> {
  const session = createSceneCompileSession(health);
  try { return await session.compile(input, { generation: 0, signal }); }
  finally { session.dispose(); }
}
