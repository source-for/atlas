// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NavigationHistoryController } from './navigation/historyController';
import { canonicalNavigationUrl, type NavigationState } from './navigation/navigationState';
import { REJECTED_CALL_ERROR_NAME } from './renderer/gpuLoss';
import type { RenderState } from './renderer/types';
import { STORY_ARRIVAL_SETTLE_MS, STORY_MAX_FLIGHT_DURATION_MS } from './storyPlayback';

// A story move onto a frame the camera already holds has nothing to fly. It used to be
// sent to the engine as a timeline of no length, which the engine refuses (CLA-544).
const control = vi.hoisted(() => ({ nowMs: 0, frames: [] as FrameRequestCallback[], transitions: [] as number[], recovered: 0, controller: undefined as NavigationHistoryController | undefined }));
vi.mock('./navigation/historyController', async importOriginal => {
  const original = await importOriginal<typeof import('./navigation/historyController')>();
  return { ...original, createNavigationHistoryController: (...args: Parameters<typeof original.createNavigationHistoryController>) => (control.controller = original.createNavigationHistoryController(...args)) };
});
vi.mock('./renderer/createRenderer', () => {
  const session = (host: HTMLElement, kind: string) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    // Stands in for the engine: it refuses a cinematic timeline with no length.
    const setRenderState = (state: RenderState) => {
      const durationMs = state.cinematicTransition?.durationMs;
      if (durationMs === undefined) return;
      control.transitions.push(durationMs);
      if (!(durationMs > 0)) throw Object.assign(new Error('timeline validation failed: invalid timeline: timeline duration must be greater than zero'), { name: REJECTED_CALL_ERROR_NAME });
    };
    return { canvas, renderer: { kind, setScene() {}, setCamera() {}, setRenderState, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, forgetScene() {}, diagnostics: () => ({ requestedBackend: 'auto', activeBackend: kind, gpuAccelerated: kind === 'webgpu', lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  };
  return {
    createRenderer: async (host: HTMLElement) => session(host, 'webgpu'),
    recoverRenderer: async (host: HTMLElement) => { control.recovered += 1; return session(host, 'webgl2'); },
  };
});
// Each test mounts the whole App and flies several steps; a loaded machine needs the room.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let root: Root;
let host: HTMLDivElement;
let error: ReturnType<typeof vi.spyOn>;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
/** Moves the clock and runs every frame requested so far. */
async function frame(elapsedMs = 100) {
  control.nowMs += elapsedMs;
  const pending = control.frames.splice(0);
  await act(async () => { for (const callback of pending) callback(control.nowMs); });
  await settle();
}
async function until(state: string) {
  for (let count = 0; count < 80 && playback() !== state; count += 1) await frame();
  expect(playback()).toBe(state);
}
async function click(selector: string, index = 0) {
  const button = host.querySelectorAll<HTMLButtonElement>(selector)[index]!;
  await act(async () => button.click());
  await settle();
}
const playback = () => host.querySelector('[data-playback-state]')?.getAttribute('data-playback-state');
const liveMessage = () => host.querySelector('.sr-only[aria-atomic="true"]')!.textContent;
const replay = () => JSON.parse(host.querySelector<HTMLElement>('[data-testid="atlas-app"]')!.dataset.rendererReplayState!) as {
  timeline: { step: number; phase: string; playbackState: string; holdElapsedMs: number };
  camera: { x: number; y: number; zoom: number };
};
const rejections = () => error.mock.calls.filter(call => String(call[0]).includes('renderer rejected a call'));
/** No story move reached the engine as a transition it refuses. */
function expectNoRefusedTimeline() {
  expect(control.transitions.filter(durationMs => !(durationMs > 0))).toEqual([]);
  expect(rejections()).toEqual([]);
  expect(control.recovered).toBe(0);
}
async function restore(state: NavigationState) {
  await act(async () => { window.history.pushState(null, '', canonicalNavigationUrl(state)); window.dispatchEvent(new PopStateEvent('popstate')); });
  await settle(); await settle();
}
/** The URL keeps a camera to three decimals; the live one is exact. */
function expectCamera(actual: { x: number; y: number; zoom: number }, expected: { x: number; y: number; zoom: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 2);
  expect(actual.y).toBeCloseTo(expected.y, 2);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 4);
}
/** Starts the overview tour and waits for step 1 to arrive, playing. */
async function startTour() {
  await click('[data-testid="story-launch-overview"]');
  expect(playback()).toBe('moving');
  await until('playing');
  expect(replay().timeline.step).toBe(0);
}

beforeEach(async () => {
  Object.assign(control, { nowMs: Math.ceil(performance.now()), frames: [], transitions: [], recovered: 0 });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(performance, 'now').mockImplementation(() => control.nowMs);
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
  const module = await import('./App');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  await frame(); await frame();
  error.mockClear();
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('a click on the current step\'s dot sends the engine no timeline of no length, and still pauses and restarts the step (CLA-544)', async () => {
  await startTour();
  // Part of the hold has played.
  await frame(1_000);
  const entries = window.history.length;
  const frameCamera = replay().camera;
  await click('.story-progress button', 0);
  expect(liveMessage()).toContain('Moving to story step 1 of 4');
  const afterClick = playback();
  await until('paused');
  expectNoRefusedTimeline();
  // Nothing to fly: the step was arriving at once, never moving.
  expect(afterClick).toBe('arriving');
  expect(replay().timeline).toMatchObject({ step: 0, phase: 'paused', playbackState: 'paused', holdElapsedMs: 0 });
  expect(replay().camera).toEqual(frameCamera);
  expect(liveMessage()).toContain('Arrived at story step 1');
  expect(liveMessage()).toContain('Paused.');
  expect(window.history.length).toBe(entries);
  expect(control.controller!.current().story).toMatchObject({ step: 0 });
  // A paused step stays paused: the hold does not run on.
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(replay().timeline).toMatchObject({ step: 0, playbackState: 'paused' });
});

/** Leaves the story paused on step 1 with the camera already on step 2's frame. */
async function holdNextStepsFrame() {
  await startTour();
  await click('.story-progress button', 0);
  await until('paused');
  const first = control.controller!.current();
  await click('.story-footer button', 1);
  expect(playback()).toBe('moving');
  await until('paused');
  const second = control.controller!.current();
  expect(second.story!.step).toBe(1);
  expect(second.camera).not.toEqual(first.camera);
  // A history entry for step 1 that carries step 2's camera.
  await restore({ ...second, story: first.story });
  expect(replay().timeline).toMatchObject({ step: 0, playbackState: 'paused' });
  expectCamera(replay().camera, second.camera);
  // Only what follows this setup is judged.
  control.transitions.length = 0;
  error.mockClear();
  return { first, second };
}

it('a click on the current step\'s dot still flies back when the camera is somewhere else', async () => {
  // On step 1 with the camera away from its frame (here, on step 2's).
  const { first, second } = await holdNextStepsFrame();
  const entries = window.history.length;
  await click('.story-progress button', 0);
  expect(playback()).toBe('moving');
  expect(liveMessage()).toContain('Moving to story step 1 of 4');
  await until('paused');
  expect(control.transitions.length).toBeGreaterThan(0);
  expectNoRefusedTimeline();
  expect(replay().timeline).toMatchObject({ step: 0, phase: 'paused', playbackState: 'paused', holdElapsedMs: 0 });
  expectCamera(replay().camera, first.camera);
  expect(replay().camera).not.toEqual(second.camera);
  expect(window.history.length).toBe(entries);
});

it('Next onto a frame the camera already holds changes the step with no flight and stays paused (CLA-544)', async () => {
  const { second } = await holdNextStepsFrame();
  await click('.story-footer button', 1);
  expect(replay().timeline.step).toBe(1);
  const afterClick = playback();
  expect(liveMessage()).toContain('Moving to story step 2 of 4');
  await until('paused');
  expectNoRefusedTimeline();
  expect(afterClick).toBe('arriving');
  expect(control.transitions).toEqual([]);
  expect(replay().timeline).toMatchObject({ step: 1, phase: 'paused', playbackState: 'paused', holdElapsedMs: 0 });
  expectCamera(replay().camera, second.camera);
  expect(control.controller!.current()).toMatchObject({ camera: second.camera, selectedId: second.selectedId, detail: second.detail, story: second.story });
  expect(liveMessage()).toContain('Arrived at story step 2');
});

it('auto-advance and a dot jump onto a frame the camera already holds keep playing or pause as asked (CLA-544)', async () => {
  const { first, second } = await holdNextStepsFrame();
  // Play the hold of step 1 out: the story advances itself, playing.
  await click('.story-play');
  expect(playback()).toBe('playing');
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(replay().timeline.step).toBe(1);
  const afterAdvance = playback();
  await until('playing');
  expectNoRefusedTimeline();
  expect(afterAdvance).toBe('arriving');
  expect(replay().timeline).toMatchObject({ step: 1, phase: 'hold', playbackState: 'playing' });
  // The same move from a dot arrives paused.
  await restore({ ...second, story: first.story });
  expect(replay().timeline.step).toBe(0);
  await click('.story-progress button', 1);
  const afterClick = playback();
  await until('paused');
  expectNoRefusedTimeline();
  expect(afterClick).toBe('arriving');
  expect(replay().timeline).toMatchObject({ step: 1, playbackState: 'paused' });
});

it('a history entry part way through a flight to a frame the camera already holds resumes with a real length', async () => {
  const { second } = await holdNextStepsFrame();
  // Step 2, half way through its flight, with the camera on step 2's frame.
  const midFlightMs = second.story!.positionMs - STORY_ARRIVAL_SETTLE_MS - STORY_MAX_FLIGHT_DURATION_MS / 2;
  await restore({ ...second, story: { ...second.story!, positionMs: midFlightMs } });
  expect(replay().timeline).toMatchObject({ step: 1, playbackState: 'paused' });
  await frame();
  await click('.story-play');
  expect(playback()).toBe('moving');
  await until('paused');
  expect(control.transitions.length).toBeGreaterThan(0);
  expectNoRefusedTimeline();
  expect(replay().timeline).toMatchObject({ step: 1, phase: 'paused' });
});
