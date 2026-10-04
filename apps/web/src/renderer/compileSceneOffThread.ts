import { workerSceneOrigin } from './lazyBandCompile';
import { recordAtlasWorkerCompile } from '../performance/loadTimings';
import { guardScanCompile, type ScanSceneInput } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneCompileRequest, SceneCompileResponse } from './sceneCompileProtocol';

export type SceneCompileOptions = { generation: number; priority?: 'selected' | 'speculative'; signal?: AbortSignal };
export type SceneCompileSession = {
  compile(input: ScanSceneInput, options: SceneCompileOptions): Promise<AtlasScene | undefined>;
  dispose(): void;
};
type Job = {
  id: number; input: ScanSceneInput; options: SceneCompileOptions;
  resolve(scene: AtlasScene | undefined): void; reject(reason: unknown): void;
  abort: () => void; timer?: ReturnType<typeof setTimeout>; abandoned?: boolean; settled?: boolean;
};

/** One graph generation, two retained scenes and at most one queued job per priority.
 * A caller must advance generation after mutating its snapshot. Active synchronous
 * selected work finishes after its caller is abandoned; only the latest queued
 * request starts next. Speculative work may be terminated for selected work.
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
  const retainScene = (job: Job, scene: AtlasScene) => {
    scenes.set(scene, job.id);
    while (scenes.size > 2) scenes.delete(scenes.keys().next().value!);
  };
  const settle = (job: Job, scene?: AtlasScene, aborted = false) => {
    if (job.settled) return;
    job.settled = true;
    if (!job.abandoned) clearTimeout(job.timer);
    job.options.signal?.removeEventListener('abort', job.abort);
    if (aborted) job.reject(job.options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    else job.resolve(scene);
  };
  const reset = () => {
    worker?.terminate(); worker = undefined; workerGeneration = undefined; workerSnapshot = undefined; scenes.clear();
  };
  const pump = () => {
    if (disposed || active) return;
    const job = selected ?? speculative;
    if (!job) return;
    if (selected === job) selected = undefined; else speculative = undefined;
    active = job;
    const fail = () => {
      if (active !== job) return;
      clearTimeout(job.timer); active = undefined; reset(); settle(job); pump();
    };
    if (!worker) {
      if (typeof Worker === 'undefined') { fail(); return; }
      try { worker = new Worker(new URL('./sceneCompileWorker.ts', import.meta.url), { type: 'module' }); }
      catch { fail(); return; }
    }
    const currentWorker = worker;
    currentWorker.onmessage = event => {
      if (worker !== currentWorker || active !== job) return;
      const result = event.data as SceneCompileResponse;
      if (result.id !== job.id || result.generation !== job.options.generation) return;
      // The caller is gone, but worker retention still advances. Do not validate
      // an older guarded result against a snapshot that has since been merged.
      if (job.abandoned) {
        if (result.ok && result.scene) retainScene(job, result.scene);
        clearTimeout(job.timer); active = undefined; pump(); return;
      }
      let validScope = result.scene?.rootEntityId === job.input.focusEntityId;
      if (!validScope && result.scene?.scanGuardRefusal) {
        const expected = guardScanCompile(job.input.snapshot, job.input.focusEntityId, job.input.view.rootEntityId);
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
    currentWorker.onerror = fail;
    currentWorker.onmessageerror = fail;
    job.timer = setTimeout(fail, 20_000);
    const { snapshot, view, childCounts, unpublishedChildren, ...input } = job.input;
    const needsGraph = workerGeneration !== job.options.generation || workerSnapshot !== snapshot;
    const previousId = needsGraph || !input.previous ? undefined : scenes.get(workerSceneOrigin(input.previous));
    if (previousId !== undefined) delete input.previous;
    const request: SceneCompileRequest = {
      id: job.id, generation: job.options.generation, input, previousId,
      ...(needsGraph ? { graph: { snapshot, view, childCounts, unpublishedChildren } } : {}),
    };
    try {
      currentWorker.postMessage(request);
      if (needsGraph) { workerGeneration = job.options.generation; workerSnapshot = snapshot; scenes.clear(); }
    } catch { fail(); }
  };
  const cancel = (job: Job, aborted = true) => {
    if (active === job) {
      if (!disposed && job.options.priority !== 'speculative') {
        job.abandoned = true; settle(job, undefined, aborted); return;
      }
      clearTimeout(job.timer); active = undefined; reset();
    }
    if (selected === job) selected = undefined;
    if (speculative === job) speculative = undefined;
    settle(job, undefined, aborted);
  };
  return {
    compile(input, options) {
      if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException('Aborted', 'AbortError'));
      if (disposed) return Promise.reject(new DOMException('Disposed', 'AbortError'));
      // Older generation requests cannot resurrect a graph after publication advances.
      if (latestGeneration !== undefined && options.generation < latestGeneration) return Promise.reject(new DOMException('Stale generation', 'AbortError'));
      if (latestGeneration !== options.generation || latestSnapshot !== input.snapshot) {
        latestGeneration = options.generation;
        latestSnapshot = input.snapshot;
        if (active) cancel(active);
        if (selected) cancel(selected);
        if (speculative) cancel(speculative);
      }
      return new Promise((resolve, reject) => {
        const job: Job = { id: ++nextId, input, options, resolve, reject, abort: () => { cancel(job, true); pump(); } };
        options.signal?.addEventListener('abort', job.abort, { once: true });
        if (options.priority === 'speculative') {
          if (speculative) cancel(speculative);
          speculative = job;
        } else {
          if (selected) cancel(selected);
          // Selected work abandons a caller without re-cloning its graph;
          // speculative work can be interrupted to make room immediately.
          if (active) cancel(active);
          selected = job;
        }
        pump();
      });
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
