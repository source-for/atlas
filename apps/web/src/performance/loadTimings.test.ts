import { expect, it, vi } from 'vitest';
import { createPerformanceRecorder } from './recorder';
import { measureAtlasAsyncPhase, measureAtlasPhase, recordAtlasWorkerPhase, subscribeLoadTiming } from './loadTimings';

it('preserves sync and async results/errors without retaining input data', async () => {
  const samples: unknown[][] = [];
  const stop = subscribeLoadTiming((...sample) => samples.push(sample));
  const payload = { privateSource: 'not a metric' };
  expect(measureAtlasPhase('atlas-compile', () => payload)).toBe(payload);
  expect(await measureAtlasAsyncPhase('atlas-fetch', async () => payload)).toBe(payload);
  const failure = new Error('private URL');
  expect(() => measureAtlasPhase('atlas-parse', () => { throw failure; })).toThrow(failure);
  await expect(measureAtlasAsyncPhase('atlas-body', async () => { throw failure; })).rejects.toBe(failure);
  expect(samples.map(sample => sample[0])).toEqual(['atlas-compile', 'atlas-fetch', 'atlas-parse', 'atlas-body']);
  expect(samples.every(sample => sample.length === 3 && typeof sample[1] === 'number' && typeof sample[2] === 'number')).toBe(true);
  expect(JSON.stringify(samples)).not.toMatch(/private/);
  stop();
  measureAtlasPhase('atlas-compile', () => payload);
  expect(samples).toHaveLength(4);
});

it('marks only the first submission and does not invent readiness after late activation', async () => {
  vi.resetModules();
  let module = await import('./loadTimings');
  module.recordAtlasFirstFrame();
  const late = vi.fn();
  let stop = module.subscribeLoadTiming(late);
  module.recordAtlasFirstFrame();
  expect(late).not.toHaveBeenCalled();
  stop();
  vi.resetModules();
  module = await import('./loadTimings');
  const active = vi.fn();
  stop = module.subscribeLoadTiming(active);
  module.recordAtlasFirstFrame();
  module.recordAtlasFirstFrame();
  expect(active).toHaveBeenCalledOnce();
  expect(active.mock.calls[0]?.[0]).toBe('atlas-first-frame');
  expect(active.mock.calls[0]?.[2]).toBe(0);
  stop();
});

it('records bootstrap worker phases and postMessage clone cost in the bounded scalar recorder', async () => {
  const recorder = createPerformanceRecorder();
  const stop = subscribeLoadTiming((metric, start, duration) => recorder.record(metric, start, duration));
  recordAtlasWorkerPhase('atlas-worker-validate', 775.1);
  recordAtlasWorkerPhase('atlas-worker-slice', 1.2);
  recordAtlasWorkerPhase('atlas-worker-validate', NaN);
  recordAtlasWorkerPhase('atlas-worker-slice', -1);
  measureAtlasPhase('atlas-worker-post-message', () => undefined);
  await measureAtlasAsyncPhase('atlas-worker-bootstrap-round-trip', async () => undefined);
  stop();
  const samples = recorder.report().samples;
  expect(samples.map(sample => sample.metric)).toEqual([
    'atlas-worker-validate', 'atlas-worker-slice', 'atlas-worker-post-message', 'atlas-worker-bootstrap-round-trip',
  ]);
  expect(samples[0]?.durationMs).toBe(775.1);
  expect(samples.every(sample => Object.keys(sample).join(',') === 'metric,startMs,durationMs')).toBe(true);
});

it('exports renderer startup phases as scalars while preserving failure behavior', async () => {
  const recorder = createPerformanceRecorder();
  const stop = subscribeLoadTiming((metric, start, duration) => recorder.record(metric, start, duration));
  const source = { privateSource: 'not exported' };
  const failure = new Error('private GPU error');
  try {
    expect(await measureAtlasAsyncPhase('renderer-wasm-init', async () => source)).toBe(source);
    await expect(measureAtlasAsyncPhase('renderer-gpu-init', async () => { throw failure; })).rejects.toBe(failure);
    expect(measureAtlasPhase('renderer-protocol', () => source)).toBe(source);
    expect(() => measureAtlasPhase('renderer-native-scene', () => { throw failure; })).toThrow(failure);
  } finally { stop(); }
  const report = recorder.report();
  expect(report.samples.map(sample => sample.metric)).toEqual([
    'renderer-wasm-init', 'renderer-gpu-init', 'renderer-protocol', 'renderer-native-scene',
  ]);
  expect(report.samples.every(sample => Object.keys(sample).join(',') === 'metric,startMs,durationMs')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/private|GPU error|Source/);
});
