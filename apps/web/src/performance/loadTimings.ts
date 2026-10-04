export type LoadMetric = 'atlas-fetch' | 'atlas-body' | 'atlas-parse' | 'atlas-validate' | 'atlas-story' | 'atlas-slice' | 'atlas-compile' | 'atlas-worker-compile' | 'atlas-worker-round-trip' | 'atlas-first-frame';
type Listener = (metric: LoadMetric, startMs: number, durationMs: number) => void;
const listeners = new Set<Listener>();
let firstFrameSubmitted = false;
/** First successful real-scene draw submission, not GPU completion or inspector readiness. Late recording cannot recover it. */
export function recordAtlasFirstFrame(): void {
  if (firstFrameSubmitted) return;
  firstFrameSubmitted = true;
  if (!listeners.size) return;
  const time = performance.now();
  for (const listener of listeners) listener('atlas-first-frame', time, 0);
}
export function subscribeLoadTiming(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function measureAtlasPhase<T>(metric: LoadMetric, work: () => T): T {
  if (!listeners.size) return work();
  const start = performance.now();
  try { return work(); }
  finally { for (const listener of listeners) listener(metric, start, performance.now() - start); }
}
export async function measureAtlasAsyncPhase<T>(metric: LoadMetric, work: () => Promise<T>): Promise<T> {
  if (!listeners.size) return work();
  const start = performance.now();
  try { return await work(); }
  finally { for (const listener of listeners) listener(metric, start, performance.now() - start); }
}

export function recordAtlasWorkerCompile(durationMs: number): void {
  if (!listeners.size || !Number.isFinite(durationMs) || durationMs < 0) return;
  const receipt = performance.now();
  for (const listener of listeners) listener('atlas-worker-compile', receipt, durationMs);
}
