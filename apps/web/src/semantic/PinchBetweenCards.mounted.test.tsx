// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { scanZoomEntityUnderPointer, semanticBounds } from '../renderer/goldenC4Scene';
import type { Camera, RenderState } from '../renderer/types';

const captured = vi.hoisted(() => ({ camera: { x: 0, y: 0, zoom: 1 } as Camera, state: undefined as RenderState | undefined }));
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera(camera: Camera) { captured.camera = { ...camera }; }, setRenderState(state: RenderState) { captured.state = state; }, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let canvas: HTMLCanvasElement;
let inputMode: 'mouse' | 'pinch' = 'pinch';
let inputTime = 0;
let mapWidth = 1440;
let mapHeight = 900;
let rafFrames = new Map<number, FrameRequestCallback>();
let resizeTargets: Array<{ callback: ResizeObserverCallback; element: Element }> = [];
let rafId = 100000;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  Object.defineProperty(event, 'timeStamp', { value: inputTime += 16 });
  return event;
}
async function zoomTo(zoom: number, pointer = { x: 720, y: 450 }) {
  const deltaY = -Math.log(zoom / captured.camera.zoom) / (inputMode === 'pinch' ? .01 : .0012 * 33);
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: inputMode === 'pinch', deltaMode: inputMode === 'pinch' ? 0 : 1, deltaY, clientX: pointer.x, clientY: pointer.y })));
}
// The first mount also imports the App module, which alone can pass 5s on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });
async function mount(url: string) {
  window.history.replaceState(null, '', url);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
}
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
beforeEach(() => {
  inputTime = 0; mapWidth = 1440; mapHeight = 900;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); localStorage.setItem('okie.devMode', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  rafFrames = new Map(); rafId = 100000;
  const enqueue = (callback: FrameRequestCallback) => { rafFrames.set(++rafId, callback); return rafId; };
  const cancel = (handle: number) => { rafFrames.delete(handle); };
  vi.stubGlobal('requestAnimationFrame', enqueue); vi.spyOn(window, 'requestAnimationFrame').mockImplementation(enqueue);
  vi.stubGlobal('cancelAnimationFrame', cancel); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(cancel);
  resizeTargets = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { resizeTargets.push({ callback: this.callback, element }); this.callback([{ target: element, contentRect: { width: mapWidth, height: mapHeight } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? mapWidth : 0, map ? mapHeight : 0);
  });
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function frames(clock: { now: number }) {
  clock.now += 16;
  const pending = [...rafFrames.values()]; rafFrames.clear();
  await act(async () => { for (const callback of pending) callback(clock.now); }); await settle();
}

it('expands the selected container when the pinch pointer is over the system shell between cards (CLA-416)', async () => {
  inputMode = 'pinch';
  const system = fixture.createScene('system:okie');
  const shellBounds = semanticBounds(system, 'system:okie', 'container')!;
  const viewport = { width: mapWidth, height: mapHeight };
  const pointer = { x: mapWidth / 2, y: mapHeight / 2 };
  // A point of the system shell that no container card covers: the handoff cannot open
  // the shell, so it falls back to the selected container.
  let gap: { x: number; y: number } | undefined;
  for (let row = 1; row < 40 && !gap; row++) for (let column = 1; column < 40 && !gap; column++) {
    const point = { x: shellBounds.x + shellBounds.width * column / 40, y: shellBounds.y + shellBounds.height * row / 40 };
    if (scanZoomEntityUnderPointer(system, { ...point, zoom: 4 }, viewport, pointer, 'container') === 'system:okie') gap = point;
  }
  expect(gap).toBeDefined();
  await mount(`/?fixture=scan&backend=canvas2d&root=system%3Aokie&sel=container%3Aweb-app&detail=context&lens=system%3Aokie&cx=${gap!.x}&cy=${gap!.y}&z=0.6`);
  const clock = { now: 5000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  await frames(clock);
  expect(captured.camera.zoom).toBeCloseTo(.6, 3);
  for (let step = 0; step < 40 && shell().getAttribute('data-detail') !== 'component'; step++) {
    await zoomTo(captured.camera.zoom * 1.1, pointer); await settle(); await frames(clock);
  }
  // Before the fix every inward sample released the bridge and requested it again.
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(shell().getAttribute('data-detail')).toBe('component');
});
