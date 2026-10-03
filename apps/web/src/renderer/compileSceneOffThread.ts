import type { ArchitectureNeighborhoodPacket, ValidationIssue } from '@okie/architecture';
import { measureAtlasAsyncPhase, measureAtlasPhase, recordAtlasWorkerCompile, recordAtlasWorkerPhase } from '../performance/loadTimings';
import type { ScanSceneInput, ScanModeOptions } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneWorkerRequest, SceneWorkerResponse } from './sceneCompileProtocol';

export type SceneCompileOptions = { generation: number; priority?: 'selected' | 'speculative'; signal?: AbortSignal };
export type NeighborhoodInitialization = { status: 'ready'; scene: AtlasScene } | { status: 'invalid'; issues: ValidationIssue[] };
export type SceneCompileSession = {
  compile(input: ScanSceneInput, options: SceneCompileOptions): Promise<AtlasScene | undefined>;
  /** Only fresh, exclusively owned packets may be supplied: do not publish/mutate
   * the main-thread packet while its worker clone is being validated. */
  initializeNeighborhood(packet: ArchitectureNeighborhoodPacket, modeOptions: ScanModeOptions, options: SceneCompileOptions): Promise<NeighborhoodInitialization | undefined>;
  dispose(): void;
};
type JobInput = { kind: 'compile'; input: ScanSceneInput } | { kind: 'initialize'; packet: ArchitectureNeighborhoodPacket; modeOptions: ScanModeOptions };
type JobResult = AtlasScene | NeighborhoodInitialization | undefined;
type Job = {
  id: number; payload: JobInput; options: SceneCompileOptions;
  resolve(result: JobResult): void; reject(reason: unknown): void;
  abort: () => void; timer?: ReturnType<typeof setTimeout>;
};
const snapshotFor = (payload: JobInput) => payload.kind === 'compile' ? payload.input.snapshot : payload.packet.snapshot;

/** One graph generation, two retained scenes and at most one queued job per priority.
 * A caller must advance generation after mutating its snapshot. Active synchronous
 * work can only be cancelled by terminating the worker; the next job reloads graph.
 * undefined requests the caller's existing fallback. Superseded work rejects AbortError.
 */
export function createSceneCompileSession(): SceneCompileSession {
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
    clearTimeout(job.timer);
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
    active = job;
    const fail = () => {
      if (active !== job) return;
      active = undefined; reset(); settle(job); pump();
    };
    if (!worker) {
      if (typeof Worker === 'undefined') { fail(); return; }
      try { worker = new Worker(new URL('./sceneCompileWorker.ts', import.meta.url), { type: 'module' }); }
      catch { fail(); return; }
    }
    const currentWorker = worker;
    currentWorker.onmessage = event => {
      if (worker !== currentWorker || active !== job) return;
      const result = event.data as SceneWorkerResponse;
      if (result.id !== job.id || result.generation !== job.options.generation) return;
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
      if ('operation' in result || !result.ok || result.scene?.rootEntityId !== job.payload.input.focusEntityId) { fail(); return; }
      if (typeof result.durationMs === 'number') recordAtlasWorkerCompile(result.durationMs);
      retainScene(job, result.scene);
      active = undefined; settle(job, result.scene); pump();
    };
    currentWorker.onerror = fail;
    currentWorker.onmessageerror = fail;
    job.timer = setTimeout(fail, 20_000);
    let request: SceneWorkerRequest;
    let needsGraph = false;
    const snapshot = snapshotFor(job.payload);
    if (job.payload.kind === 'initialize') {
      request = { operation: 'initializeNeighborhood', id: job.id, generation: job.options.generation,
        packet: job.payload.packet, modeOptions: job.payload.modeOptions };
    } else {
      const { snapshot: _snapshot, ...input } = job.payload.input;
      needsGraph = workerGeneration !== job.options.generation || workerSnapshot !== snapshot;
      const previousId = needsGraph || !input.previous ? undefined : scenes.get(input.previous);
      if (previousId !== undefined) delete input.previous;
      request = { id: job.id, generation: job.options.generation, input, previousId,
        ...(needsGraph ? { graph: { snapshot } } : {}) };
    }
    try {
      measureAtlasPhase('atlas-worker-post-message', () => currentWorker.postMessage(request));
      if (needsGraph) { workerGeneration = job.options.generation; workerSnapshot = snapshot; scenes.clear(); }
    } catch { fail(); }
  };
  const cancel = (job: Job, aborted = true) => {
    if (active === job) { active = undefined; reset(); }
    if (selected === job) selected = undefined;
    if (speculative === job) speculative = undefined;
    settle(job, undefined, aborted);
  };
  const enqueue = (payload: JobInput, options: SceneCompileOptions): Promise<JobResult> => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (disposed) return Promise.reject(new DOMException('Disposed', 'AbortError'));
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
      const job: Job = { id: ++nextId, payload, options, resolve, reject, abort: () => { cancel(job, true); pump(); } };
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
    compile(input, options) {
      return enqueue({ kind: 'compile', input }, options) as Promise<AtlasScene | undefined>;
    },
    initializeNeighborhood(packet, modeOptions, options) {
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
export async function compileSceneOffThread(input: ScanSceneInput, signal?: AbortSignal): Promise<AtlasScene | undefined> {
  const session = createSceneCompileSession();
  try { return await session.compile(input, { generation: 0, signal }); }
  finally { session.dispose(); }
}
