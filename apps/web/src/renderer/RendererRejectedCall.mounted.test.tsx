// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_CONSECUTIVE_REJECTED_CALLS, REJECTED_CALL_EPISODE_MS, REJECTED_CALL_ERROR_NAME } from './gpuLoss';
import type { ZoomMotionTraceCollector } from '../zoomMotionTrace';

const control = vi.hoisted(() => ({ failRender: undefined as unknown, rendered: 0, forgotten: 0, recovered: 0, frames: [] as FrameRequestCallback[], trace: undefined as ZoomMotionTraceCollector | undefined }));
vi.mock('../zoomMotionTrace', async importOriginal => {
  const actual = await importOriginal<typeof import('../zoomMotionTrace')>();
  return { ...actual, createZoomMotionTrace: (options: Parameters<typeof actual.createZoomMotionTrace>[0]) => (control.trace = actual.createZoomMotionTrace(options)) };
});
vi.mock('./createRenderer', () => {
  const session = (host: HTMLElement, kind: string, render: () => void) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind, setScene() {}, setCamera() {}, setRenderState() {}, resize() {}, render, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, forgetScene() { control.forgotten += 1; }, diagnostics: () => ({ requestedBackend: 'auto', activeBackend: kind, gpuAccelerated: kind === 'webgpu', lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  };
  return {
    createRenderer: async (host: HTMLElement) => session(host, 'webgpu', () => { if (control.failRender) throw control.failRender; control.rendered += 1; }),
    recoverRenderer: async (host: HTMLElement) => { control.recovered += 1; return session(host, 'webgl2', () => {}); },
  };
});
let root: Root;
let host: HTMLDivElement;
let error: ReturnType<typeof vi.spyOn>;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  return event;
}
/** The canvas draws on demand: after a good frame it is idle until input asks for another. */
async function input() {
  const canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: true, deltaMode: 0, deltaY: -20, clientX: 720, clientY: 450 })));
}
/**
 * Runs the frame the canvas scheduler has requested, and fails when it asked for none.
 * The far-future time ends the zoom animation window, so only a rejected frame asks for another.
 */
async function frame() {
  const pending = control.frames.splice(0);
  expect(pending.length).toBeGreaterThan(0);
  await act(async () => { for (const callback of pending) callback(performance.now() + 60_000); });
  await settle();
}
const rejected = (message: string) => Object.assign(new Error(message), { name: REJECTED_CALL_ERROR_NAME });
const reports = (text: string) => error.mock.calls.filter(call => String(call[0]).includes(text));
/** Holds performance.now still, on a whole millisecond, so only the test moves the report window. */
function holdClock() {
  const clock = { nowMs: Math.ceil(performance.now()) };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.nowMs);
  return clock;
}
/** One rejected frame, then a drawn one. */
async function rejectOnce(failure: Error) {
  control.failRender = failure;
  await input();
  await frame();
  control.failRender = undefined;
  await frame();
}

beforeEach(async () => {
  Object.assign(control, { failRender: undefined, rendered: 0, forgotten: 0, recovered: 0, frames: [] });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  const requestFrame = (callback: FrameRequestCallback) => control.frames.push(callback);
  vi.stubGlobal('requestAnimationFrame', requestFrame); vi.spyOn(window, 'requestAnimationFrame').mockImplementation(requestFrame);
  vi.stubGlobal('cancelAnimationFrame', () => {}); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? 1440 : 0, map ? 900 : 0);
  });
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  window.history.replaceState(null, '', '/');
  const module = await import('../App');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  // One good frame, so each test starts from a renderer that draws.
  await frame();
  expect(control.rendered).toBeGreaterThan(0);
  error.mockClear();
});
afterEach(async () => { control.trace?.stop(); await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('keeps the renderer after a rejected call, reports it once and draws the next frame (CLA-413)', async () => {
  control.trace!.start({ timeOrigin: 0, startedAtMs: 0 });
  const failure = rejected('visibility filter failed: unknown object visual-node:code:gone');
  control.failRender = failure;
  await input();
  await frame();
  await frame();
  expect(control.recovered).toBe(0);
  expect(control.forgotten).toBe(2);
  // Two rejected frames are one episode.
  expect(error).toHaveBeenCalledExactlyOnceWith('[atlas] webgpu renderer rejected a call: visibility filter failed: unknown object visual-node:code:gone', failure);
  const drawn = control.rendered;
  control.failRender = undefined;
  await frame();
  expect(control.rendered).toBe(drawn + 1);
  // The frame after that is on demand again.
  expect(control.frames).toHaveLength(0);
  expect(host.querySelector('[data-testid="atlas-canvas"] canvas')).not.toBeNull();
  const events = control.trace!.stop()!.samples.filter(sample => sample.kind === 'renderer');
  expect(events).toEqual([expect.objectContaining({ phase: 'rejected', backend: 'webgpu', reason: failure.message })]);
});

it('replaces a renderer that rejects every frame', async () => {
  const failure = rejected('scene patch failed: revision mismatch: expected 4, received 3');
  control.failRender = failure;
  await input();
  for (let index = 1; index < MAX_CONSECUTIVE_REJECTED_CALLS; index += 1) await frame();
  expect(control.recovered).toBe(0);
  await frame();
  expect(control.recovered).toBe(1);
  expect(reports('renderer rejected a call')).toHaveLength(1);
  expect(error).toHaveBeenCalledWith(`[atlas] webgpu renderer lost: ${failure.message}`, failure);
});

it('counts only consecutive rejected frames', async () => {
  for (let round = 0; round < 3; round += 1) {
    control.failRender = rejected('timeline validation failed: unknown path visual-edge:gone');
    await input();
    for (let index = 1; index < MAX_CONSECUTIVE_REJECTED_CALLS; index += 1) await frame();
    control.failRender = undefined;
    await frame();
  }
  expect(control.forgotten).toBe(3 * (MAX_CONSECUTIVE_REJECTED_CALLS - 1));
  expect(control.recovered).toBe(0);
});

it('replaces the renderer at once when the surface is lost', async () => {
  const failure = new Error('render failed: surface lost');
  control.failRender = failure;
  await input();
  await frame();
  expect(control.recovered).toBe(1);
  expect(control.forgotten).toBe(0);
  expect(reports('renderer rejected a call')).toHaveLength(0);
  expect(error).toHaveBeenCalledWith('[atlas] webgpu renderer lost: render failed: surface lost', failure);
});

it('reports a different rejection inside the same episode', async () => {
  holdClock();
  control.failRender = rejected('visibility filter failed: unknown object visual-node:code:gone');
  await input();
  await frame();
  control.failRender = rejected('timeline validation failed: unknown path visual-edge:gone');
  await frame();
  expect(reports('renderer rejected a call: visibility filter failed')).toHaveLength(1);
  expect(reports('renderer rejected a call: timeline validation failed')).toHaveLength(1);
});

it('reports a rejection that keeps happening once per episode, not once for ever', async () => {
  const clock = holdClock();
  const failure = rejected('visibility filter failed: unknown object visual-node:code:gone');
  // A rejection every second, each followed by a drawn frame.
  const seconds = REJECTED_CALL_EPISODE_MS / 1_000;
  for (let second = 0; second < seconds; second += 1) {
    await rejectOnce(failure);
    clock.nowMs += 1_000;
  }
  expect(reports('renderer rejected a call')).toHaveLength(1);
  await rejectOnce(failure);
  expect(reports('renderer rejected a call')).toHaveLength(2);
  expect(control.recovered).toBe(0);
});

it('gives a zoom trace started after the console report its own rejected event', async () => {
  holdClock();
  const failure = rejected('visibility filter failed: unknown object visual-node:code:gone');
  await rejectOnce(failure);
  for (let recording = 0; recording < 2; recording += 1) {
    control.trace!.start({ timeOrigin: 0, startedAtMs: 0 });
    await rejectOnce(failure);
    await rejectOnce(failure);
    const events = control.trace!.stop()!.samples.filter(sample => sample.kind === 'renderer');
    // One event for the recording, however many frames were rejected.
    expect(events).toEqual([expect.objectContaining({ phase: 'rejected', backend: 'webgpu', reason: failure.message })]);
  }
  // The console line was printed before the first recording and is not repeated.
  expect(reports('renderer rejected a call')).toHaveLength(1);
});
