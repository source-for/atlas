// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, ScanWorkerUnavailableError, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { semanticBounds } from '../renderer/goldenC4Scene';
import type { AtlasScene, Camera, RenderState } from '../renderer/types';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

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
let reveal: NonNullable<ReturnType<typeof scanCodeRevealWindow>>;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function diagnostic() { return JSON.parse(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-lens-diagnostics')!); }
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
beforeEach(async () => {
  inputTime = 0; mapWidth = 1440; mapHeight = 900;
  // CPU contention must not expire a gesture while its controlled compile is
  // pending. Run the actual publisher/settle callbacks only at explicit steps.
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
  const source = fixture.createScene('container:web-app');
  const bounds = semanticBounds(source, 'component:web-navigation', 'component')!;
  reveal = scanCodeRevealWindow(bounds)!;
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=component%3Aweb-navigation&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&cx=${x}&cy=${y}&z=${reveal.startZoom * .98}`);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });



function z() { return Number(new URL(window.location.href).searchParams.get('z')); }
function loading() { return host.textContent!.includes('Loading view…'); }
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
/** Outward zoom from the container root prepares the view root (its L2 source endpoint),
 * keeping the deep root resident and without a camera tile. Settle handoffs and viewport
 * refreshes of the same root keep only the selection or carry worldBounds. */
function isReverse(focus: string, residency?: Parameters<ScanFixture['createSceneAsync']>[2]) {
  return focus === fixture.navigation.rootEntityId && !residency?.worldBounds && Boolean(residency?.keepEntityIds?.includes('container:web-app'));
}
function reverseCalls(compile: { mock: { calls: Parameters<ScanFixture['createSceneAsync']>[] } }) { return compile.mock.calls.filter(call => isReverse(call[0], call[2])); }
async function zoomOut(steps = 2) { for (let i = 0; i < steps; i++) { await zoomTo(captured.camera.zoom * .8); await settle(); } }
async function idle(ms = 1000) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

it('replays a settle suppressed by a failed outward preparation and backs off instead of re-requesting', async () => {
  let reject!: (error: unknown) => void;
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => isReverse(focus, residency)
    ? new Promise<AtlasScene>((_done, fail) => { reject = fail; })
    : Promise.resolve(fixture.createScene(focus, previous, residency)));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await zoomOut(); await idle();
  expect(reverseCalls(compile)).toHaveLength(1);
  expect(loading()).toBe(true);
  // The gesture settled while preparing; the URL still holds the pre-gesture camera.
  expect(z()).not.toBeCloseTo(captured.camera.zoom, 3);
  await act(async () => reject(new Error('Background scene preparation is unavailable. Keep the current view and try again.'))); await settle();
  expect(loading()).toBe(false);
  expect(z()).toBeCloseTo(captured.camera.zoom, 3);
  await zoomOut(); await idle(200);
  expect(reverseCalls(compile)).toHaveLength(1);
});

it('stops outward preparation and says so once the worker is unavailable', async () => {
  const realNow = performance.now.bind(performance);
  let skew = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skew);
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => isReverse(focus, residency)
    ? Promise.reject(new ScanWorkerUnavailableError())
    : Promise.resolve(fixture.createScene(focus, previous, residency)));
  await zoomTo(captured.camera.zoom * .8); await settle();
  expect(reverseCalls(compile)).toHaveLength(1);
  expect(host.textContent).toContain(new ScanWorkerUnavailableError().message);
  // Further outward ticks of the same gesture, past the transient-failure backoff:
  // only the unavailable latch keeps them from re-requesting.
  skew = 10_000;
  for (let i = 0; i < 3; i++) { await zoomTo(captured.camera.zoom * .9); await settle(); }
  expect(reverseCalls(compile)).toHaveLength(1);
  expect(loading()).toBe(false);
});

it('abandons a stalled outward preparation at its deadline and commits the settled camera', async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency, requestSignal) => {
    if (!isReverse(focus, residency)) return Promise.resolve(fixture.createScene(focus, previous, residency));
    signal = requestSignal;
    return new Promise<AtlasScene>(() => {});
  });
  await zoomOut(); await idle();
  expect(loading()).toBe(true);
  await idle(8_000); await settle();
  expect(signal?.aborted).toBe(true);
  expect(loading()).toBe(false);
  expect(z()).toBeCloseTo(captured.camera.zoom, 3);
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
});

it('cancels a pending outward preparation at real pan start and clears the cue', async () => {
  let signal: AbortSignal | undefined;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency, requestSignal) => {
    if (!isReverse(focus, residency)) return Promise.resolve(fixture.createScene(focus, previous, residency));
    signal = requestSignal;
    return new Promise<AtlasScene>(() => {});
  });
  await zoomOut(1);
  expect(loading()).toBe(true);
  await act(async () => canvas.dispatchEvent(wheel({ deltaX: 17.5, deltaY: 4.5, clientX: 720, clientY: 450 }))); await settle();
  expect(signal?.aborted).toBe(true);
  expect(loading()).toBe(false);
});

it('keeps a stale L4 compile out while the outward preparation is pending, then publishes the bridge', async () => {
  let resolveCode!: () => void;
  let resolveReverse: (() => void) | undefined;
  let codeSignal!: AbortSignal;
  vi.spyOn(fixture, 'createSceneAsync')
    .mockImplementation((focus, previous, residency) => isReverse(focus, residency)
      ? new Promise<AtlasScene>(done => { resolveReverse = () => done(fixture.createScene(focus, previous, residency)); })
      : Promise.resolve(fixture.createScene(focus, previous, residency)))
    .mockImplementationOnce((focus, previous, residency, requestSignal) => {
      codeSignal = requestSignal!;
      return new Promise<AtlasScene>(done => { resolveCode = () => done(fixture.createScene(focus, previous, residency)); });
    });
  await zoomTo(reveal.startZoom * 1.01); await settle();
  await zoomTo(reveal.leaveStartZoom * .98); await settle();
  expect(codeSignal.aborted).toBe(true);
  expect(resolveReverse).toBeDefined();
  await act(async () => resolveCode()); await settle();
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(shell().getAttribute('data-detail')).not.toBe('code');
  await act(async () => resolveReverse!()); await settle();
  expect(diagnostic().bridge).toMatchObject({ focusId: 'container:web-app', sourceDetail: 'container', targetDetail: 'component' });
  expect(loading()).toBe(false);
});
