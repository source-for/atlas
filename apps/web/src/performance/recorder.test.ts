import { describe, expect, it, vi } from 'vitest';
import { createPerformanceRecorder, performanceQueryEnabled, startPerformanceSession, type PerformanceHost } from './recorder';
import { installPerformanceDiagnostics } from './install';

function fakeHost(types: string[] = []) {
  const callbacks = new Map<string, (entries: PerformanceEntry[]) => void>();
  const frames = new Map<number, (time: number) => void>();
  let id = 0;
  let hidden = false;
  let visibility: (() => void) | undefined;
  const disconnect = vi.fn();
  const removeVisibility = vi.fn();
  const host: PerformanceHost = {
    now: () => 0, supportedEntryTypes: types,
    observe(type, callback) { callbacks.set(type, callback); return disconnect; },
    requestFrame(callback) { frames.set(++id, callback); return id; },
    cancelFrame(frame) { frames.delete(frame); },
    hidden: () => hidden,
    onVisibility(callback) { visibility = callback; return removeVisibility; },
  };
  return { host, callbacks, frames, disconnect, removeVisibility,
    visibility(value: boolean) { hidden = value; visibility?.(); },
    tick(time: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(time)); },
  };
}

describe('local performance recorder', () => {
  it('requires the exact opt-in flag', () => {
    expect(performanceQueryEnabled('?perf=1')).toBe(true);
    for (const query of ['', '?perf=0', '?perf=true', '?question=perf%3D1', '?perfection=1']) expect(performanceQueryEnabled(query)).toBe(false);
  });
  it('bounds retained samples and exports only a fixed numeric schema', () => {
    const recorder = createPerformanceRecorder(2);
    recorder.record('long-task', 1.234, 60.456);
    recorder.record('interaction', 2, 20);
    recorder.record('frame-stall', 3, 100);
    recorder.record('https://private/key?question=secret' as never, 4, 0);
    recorder.record('long-task', NaN, 4);
    recorder.record('long-task', 1, -1);
    const report = recorder.report();
    expect(report.samples).toEqual([{ metric: 'interaction', startMs: 2, durationMs: 20 }, { metric: 'frame-stall', startMs: 3, durationMs: 100 }]);
    expect(report.droppedSamples).toBe(1);
    report.samples[0]!.startMs = 999;
    expect(recorder.report().samples[0]!.startMs).toBe(2);
    expect(Object.keys(report)).toEqual(['schemaVersion', 'capabilities', 'droppedSamples', 'samples', 'workerJobs', 'droppedWorkerJobs']);
    expect(JSON.stringify(report)).not.toMatch(/secret|question|private|key/);
  });
  it('never exports entry names, targets, URLs or attribution', () => {
    const fake = fakeHost(['event', 'longtask', 'paint']);
    const session = startPerformanceSession(fake.host);
    const entry = { name: 'secret question', startTime: 12, duration: 60, target: { value: 'key' }, attribution: [{ name: 'private.js' }], toJSON: () => ({ secret: true }) } as unknown as PerformanceEntry;
    fake.callbacks.get('event')!([entry]);
    fake.callbacks.get('longtask')!([entry]);
    fake.callbacks.get('paint')!([entry]);
    expect(session.recorder.report().samples).toEqual([{ metric: 'interaction', startMs: 12, durationMs: 60 }, { metric: 'long-task', startMs: 12, durationMs: 60 }]);
    expect(JSON.stringify(session.recorder.report())).not.toMatch(/secret|question|private|target|attribution/);
    session.stop();
  });
  it('reports unsupported and failed capabilities without fake zero samples', () => {
    const fake = fakeHost(['event']);
    fake.host.observe = () => { throw new Error('policy denial'); };
    const session = startPerformanceSession(fake.host);
    expect(session.recorder.report().capabilities).toMatchObject({ navigation: 'unsupported', paint: 'unsupported', event: 'failed', longtask: 'unsupported' });
    expect(session.recorder.report().samples).toEqual([]);
    session.stop();
  });
  it('excludes hidden time and disposes observers, visibility listener and frames exactly once', () => {
    const fake = fakeHost(['event', 'longtask']);
    const session = startPerformanceSession(fake.host);
    fake.tick(10); fake.tick(70);
    fake.visibility(true);
    expect(fake.frames.size).toBe(0);
    fake.visibility(false);
    fake.tick(5000); fake.tick(5016);
    expect(session.recorder.report().samples).toEqual([{ metric: 'frame-stall', startMs: 10, durationMs: 60 }]);
    session.stop(); session.stop();
    expect(fake.frames.size).toBe(0);
    expect(fake.disconnect).toHaveBeenCalledTimes(2);
    expect(fake.removeVisibility).toHaveBeenCalledTimes(1);
    fake.callbacks.get('event')!([{ startTime: 6000, duration: 100 } as PerformanceEntry]);
    expect(session.recorder.report().samples).toHaveLength(1);
  });
  it('does no observer, timer, frame or DOM work by default and cleans activation listeners', () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const createElement = vi.fn();
    const requestAnimationFrame = vi.fn();
    const setInterval = vi.fn();
    const diagnostics = installPerformanceDiagnostics({ location: { search: '' }, addEventListener, removeEventListener, requestAnimationFrame, setInterval } as unknown as Window & typeof globalThis, { createElement } as unknown as Document);
    diagnostics.mark('bootstrap-start');
    expect(createElement).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(setInterval).not.toHaveBeenCalled();
    expect(addEventListener.mock.calls.map(call => call[0])).toEqual(['keydown', 'pagehide', 'pageshow']);
    diagnostics.dispose();
    expect(removeEventListener.mock.calls.map(call => call[0])).toEqual(['keydown', 'pagehide', 'pageshow']);
  });
});
