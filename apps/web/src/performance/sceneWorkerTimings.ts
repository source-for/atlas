/** Explicit diagnostics only; fixed identifiers and scalar clocks, never scene/source data. */
export const WORKER_JOB_LIMIT = 64;
export const WORKER_CLOCK_KEYS = ['mainQueued', 'mainDequeued', 'mainDeadline', 'mainWorkerCreated', 'mainSendBefore', 'mainSendAfter', 'mainReceive', 'mainHandleEnd', 'mainResultHandled', 'mainTerminal', 'mainCancelled', 'mainTimeout', 'mainFailure', 'mainTimeOrigin', 'workerTimeOrigin', 'workerModuleReady', 'workerReceived', 'workerGraphInstalled', 'workerCompileStart', 'workerCompileEnd', 'workerResultPostBefore', 'workerResultPostAfter'] as const;
export type WorkerClock = typeof WORKER_CLOCK_KEYS[number];
export type WorkerClocks = Partial<Record<WorkerClock, number>>;
export const WORKER_PHASES = ['received', 'compiling', 'compiled', 'root-slice', 'projection', 'layout', 'adapter'] as const;
export type WorkerPhase = typeof WORKER_PHASES[number];
export type WorkerPhaseClocks = Partial<Record<WorkerPhase, { worker: number; mainReceive: number; mainHandleEnd: number }>>;
export type SceneWorkerJobTiming = {
  correlationId: number; sessionId: number; jobId: number; generation: number;
  workerId?: number; operation: 'compile' | 'initialize'; priority: 'selected' | 'speculative';
  outcome: 'pending' | 'success' | 'invalid' | 'error' | 'timeout' | 'cancelled';
  abandoned: boolean; graphSent: boolean; workerFresh: boolean;
  clocks: WorkerClocks; phases: WorkerPhaseClocks;
};
const listeners = new Set<(job: SceneWorkerJobTiming) => void>();
export const sceneWorkerTimingEnabled = () => listeners.size > 0;
export function subscribeSceneWorkerTiming(listener: (job: SceneWorkerJobTiming) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function recordSceneWorkerJob(job: SceneWorkerJobTiming): void { for (const listener of listeners) listener(job); }
/** Both window/worker use monotonic time plus their explicit epoch origin. Precision is browser-dependent. */
export const sceneWorkerClock = () => performance.timeOrigin + performance.now();
export function safeWorkerClocks(value: WorkerClocks, scope: 'all' | 'worker' = 'all'): WorkerClocks {
  const result: WorkerClocks = {};
  for (const key of WORKER_CLOCK_KEYS) { if (scope === 'worker' && !key.startsWith('worker')) continue; const time = value[key]; if (typeof time === 'number' && Number.isFinite(time) && time >= 0) result[key] = time; }
  return result;
}
export function copySceneWorkerJob(value: SceneWorkerJobTiming): SceneWorkerJobTiming {
  const phases: WorkerPhaseClocks = {};
  for (const phase of WORKER_PHASES) {
    const times = value.phases[phase];
    if (times && [times.worker, times.mainReceive, times.mainHandleEnd].every(time => Number.isFinite(time) && time >= 0)) phases[phase] = { worker: times.worker, mainReceive: times.mainReceive, mainHandleEnd: times.mainHandleEnd };
  }
  return { correlationId:value.correlationId, sessionId:value.sessionId, jobId:value.jobId, generation:value.generation,
    ...(value.workerId === undefined ? {} : {workerId:value.workerId}), operation:value.operation, priority:value.priority, outcome:value.outcome,
    abandoned:value.abandoned, graphSent:value.graphSent, workerFresh:value.workerFresh, clocks:safeWorkerClocks(value.clocks), phases };
}
