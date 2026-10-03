export const PERFORMANCE_LIMIT = 240;
export type SearchMetric = 'search-startup' | 'search-prepare' | 'search-index' | 'search-query' | 'search-round-trip' | 'search-fallback';
export type RenderMetric = 'render-scene' | 'render-state' | 'render-draw' | 'render-publish';
import type { LoadMetric } from './loadTimings';
export type Metric = SearchMetric | RenderMetric | LoadMetric | 'navigation' | 'first-paint' | 'first-contentful-paint' | 'largest-contentful-paint' | 'interaction' | 'long-task' | 'frame-stall' | 'bootstrap-start' | 'bootstrap-complete';
export type Capability = 'navigation' | 'paint' | 'largest-contentful-paint' | 'event' | 'longtask' | 'frames';
export type Availability = 'available' | 'unsupported' | 'failed';
export interface Sample { metric: Metric; startMs: number; durationMs: number }
export interface PerformanceReport { schemaVersion: 1; capabilities: Partial<Record<Capability, Availability>>; droppedSamples: number; samples: Sample[] }
const metrics = new Set<Metric>(['navigation', 'first-paint', 'first-contentful-paint', 'largest-contentful-paint', 'interaction', 'long-task', 'frame-stall', 'bootstrap-start', 'bootstrap-complete', 'search-startup', 'search-prepare', 'search-index', 'search-query', 'search-round-trip', 'search-fallback', 'render-scene', 'render-state', 'render-draw', 'render-publish', 'atlas-fetch', 'atlas-body', 'atlas-parse', 'atlas-validate', 'atlas-story', 'atlas-slice', 'atlas-compile', 'atlas-worker-compile', 'atlas-worker-validate', 'atlas-worker-slice', 'atlas-worker-post-message', 'atlas-worker-bootstrap-round-trip', 'atlas-worker-round-trip', 'atlas-first-frame']);

/** Only fixed metric identifiers and numeric timings enter the report. Never serialize browser entries. */
export function createPerformanceRecorder(limit = PERFORMANCE_LIMIT) {
  const bound = Math.max(1, Math.min(PERFORMANCE_LIMIT, Math.floor(limit) || PERFORMANCE_LIMIT));
  const samples: Sample[] = [];
  const capabilities: PerformanceReport['capabilities'] = {};
  let droppedSamples = 0;
  return {
    capability(name: Capability, state: Availability) { capabilities[name] = state; },
    record(metric: Metric, startMs: number, durationMs = 0) {
      if (!metrics.has(metric) || !Number.isFinite(startMs) || !Number.isFinite(durationMs) || startMs < 0 || durationMs < 0) return;
      if (samples.length === bound) { samples.shift(); droppedSamples++; }
      samples.push({ metric, startMs: Math.round(startMs * 10) / 10, durationMs: Math.round(durationMs * 10) / 10 });
    },
    report(): PerformanceReport { return { schemaVersion: 1, capabilities: { ...capabilities }, droppedSamples, samples: samples.map(sample => ({ ...sample })) }; },
  };
}

export function performanceQueryEnabled(search: string): boolean { return new URLSearchParams(search).get('perf') === '1'; }

export interface PerformanceHost {
  now(): number;
  supportedEntryTypes: readonly string[];
  observe(type: string, callback: (entries: readonly Pick<PerformanceEntry, 'name' | 'startTime' | 'duration'>[]) => void, buffered: boolean): () => void;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  hidden(): boolean;
  onVisibility(callback: () => void): () => void;
}

/** All observers and the frame loop exist only while this explicit session is active. */
export function startPerformanceSession(host: PerformanceHost, recorder = createPerformanceRecorder(), buffered = true) {
  let stopped = false;
  const cleanup: (() => void)[] = [];
  const observe = (type: Exclude<Capability, 'frames'>, consume: (entry: Pick<PerformanceEntry, 'name' | 'startTime' | 'duration'>) => void) => {
    if (!host.supportedEntryTypes.includes(type)) { recorder.capability(type, 'unsupported'); return; }
    try {
      cleanup.push(host.observe(type, entries => { if (!stopped) entries.forEach(consume); }, buffered));
      recorder.capability(type, 'available');
    } catch { recorder.capability(type, 'failed'); }
  };
  observe('navigation', entry => recorder.record('navigation', entry.startTime, entry.duration));
  observe('paint', entry => {
    if (entry.name === 'first-paint' || entry.name === 'first-contentful-paint') recorder.record(entry.name, entry.startTime);
  });
  observe('largest-contentful-paint', entry => recorder.record('largest-contentful-paint', entry.startTime));
  observe('event', entry => recorder.record('interaction', entry.startTime, entry.duration));
  observe('longtask', entry => recorder.record('long-task', entry.startTime, entry.duration));
  let previous: number | undefined;
  let frame: number | undefined;
  const tick = (time: number) => {
    frame = undefined;
    if (stopped || host.hidden()) { previous = undefined; return; }
    if (previous !== undefined && time - previous > 50) recorder.record('frame-stall', previous, time - previous);
    previous = time;
    frame = host.requestFrame(tick);
  };
  const visibility = () => {
    previous = undefined;
    if (frame !== undefined) host.cancelFrame(frame);
    frame = undefined;
    if (!stopped && !host.hidden()) frame = host.requestFrame(tick);
  };
  try {
    cleanup.push(host.onVisibility(visibility));
    visibility();
    recorder.capability('frames', 'available');
  } catch { recorder.capability('frames', 'failed'); }
  return { recorder, stop() {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) host.cancelFrame(frame);
    cleanup.forEach(dispose => dispose());
  } };
}
