import { expect, it, vi } from 'vitest';
import { measureAtlasAsyncPhase, measureAtlasPhase, subscribeLoadTiming } from './loadTimings';

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
