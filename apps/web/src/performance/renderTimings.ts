import type { RenderMetric } from './recorder';

type Listener = (metric: RenderMetric, startMs: number, durationMs: number) => void;
const listeners = new Set<Listener>();
let lastSampleMs = -Infinity;

export function subscribeRenderTiming(listener: Listener): () => void {
  if (!listeners.size) lastSampleMs = -Infinity;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** No clock reads or allocations unless local recording is active. Timings are CPU submission, not GPU completion. */
export function beginRenderTiming(now?: () => number) {
  if (!listeners.size) return undefined;
  const clock = now ?? (() => performance.now());
  const start = clock();
  let previous = start;
  const samples: [RenderMetric, number, number][] = [];
  return (metric: RenderMetric) => {
    const end = clock();
    samples.push([metric, previous, Math.max(0, end - previous)]);
    previous = end;
    if (metric !== 'render-publish') return;
    if (end - start <= 16 && start - lastSampleMs < 250) return;
    lastSampleMs = start;
    for (const sample of samples) for (const listener of listeners) listener(...sample);
  };
}
