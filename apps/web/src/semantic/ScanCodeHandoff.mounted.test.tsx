// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { semanticBounds } from '../renderer/goldenC4Scene';
import type { AtlasScene, Camera } from '../renderer/types';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

const captured = vi.hoisted(() => ({ camera: { x: 0, y: 0, zoom: 1 } as Camera }));
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera(camera: Camera) { captured.camera = { ...camera }; }, setRenderState() {}, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let canvas: HTMLCanvasElement;
let inputMode: 'mouse' | 'pinch' = 'pinch';
let inputTime = 0;
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
  inputTime = 0;
  // CPU contention must not expire a gesture while its controlled compile is
  // pending. Run the actual publisher/settle callbacks only at explicit steps.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); localStorage.setItem('okie.devMode', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? 1440 : 0, map ? 900 : 0);
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

it.each(['mouse', 'pinch'] as const)('freezes the cold code reveal window while later %s zoom and pan input continue', async mode => {
  inputMode = mode;
  let resolve!: () => void;
  const original = fixture.createSceneAsync.bind(fixture);
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous) => new Promise<AtlasScene>(done => { resolve = () => done(fixture.createScene(focus, previous)); }));
  await zoomTo(reveal.startZoom * 1.01); await settle();
  expect(compile).toHaveBeenCalledTimes(1);
  await zoomTo(reveal.fullZoom * .99);
  await act(async () => canvas.dispatchEvent(wheel({ deltaX: 17.5, deltaY: 4.5, clientX: 720, clientY: 450 })));
  const latest = { ...captured.camera };
  await act(async () => resolve()); await settle();
  const bridge = diagnostic().bridge;
  expect(bridge.startZoom).toBeCloseTo(reveal.startZoom, 8);
  expect(bridge.fullZoom).toBeCloseTo(reveal.fullZoom, 8);
  expect(captured.camera.zoom).toBeCloseTo(latest.zoom, 8);
  expect(captured.camera.x).toBeCloseTo(latest.x, 8);
  expect(captured.camera.y).toBeCloseTo(latest.y, 8);
  compile.mockImplementation(original);
  // A diagonal pan upgrades the wheel stream's device latch. Finish that
  // stream before beginning another mouse-wheel zoom burst.
  await act(async () => { await vi.advanceTimersByTimeAsync(160); });
  inputTime += 160;
  // Complete the measured reveal below the legacy 7.1 global code floor, then
  // allow the real 80ms camera publisher and 120ms wheel-settle timer to run.
  await zoomTo(reveal.fullZoom * 1.01);
  expect(captured.camera.zoom).toBeCloseTo(reveal.fullZoom * 1.01, 8);
  expect(captured.camera.zoom).toBeLessThan(7.1);
  await act(async () => { await vi.advanceTimersByTimeAsync(240); });
  const shell = host.querySelector('[data-testid="atlas-app"]')!;
  expect(shell.getAttribute('data-detail')).toBe('code');
  expect(shell.getAttribute('data-root-entity-id')).toBe('component:web-navigation');
  expect(new URL(window.location.href).searchParams.getAll('lens')).toContain('component:web-navigation');
  expect(diagnostic().bridge).toMatchObject({ focusId: 'component:web-navigation', targetDetail: 'code', progress: 1 });
  expect(diagnostic().bridge.fullZoom).toBeCloseTo(reveal.fullZoom, 8);
});

it('aborts an obsolete cold code compile when input reverses before publication', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  let signal!: AbortSignal;
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, _residency, requestSignal) => {
    signal = requestSignal!;
    return new Promise<AtlasScene>(done => { resolve = () => done(fixture.createScene(focus, previous)); });
  });
  await zoomTo(reveal.startZoom * 1.01); await settle();
  expect(compile).toHaveBeenCalledTimes(1);
  expect(signal.aborted).toBe(false);
  await zoomTo(reveal.leaveStartZoom * .98); await settle();
  expect(signal.aborted).toBe(true);
  const latest = { ...captured.camera };
  const href = window.location.href;
  await act(async () => resolve()); await settle();
  expect(captured.camera).toEqual(latest);
  expect(window.location.href).toBe(href);
  expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-root-entity-id')).toBe('container:web-app');
  // Outward input may reconstruct the existing L2/L3 bridge, but the stale
  // compiled L4 branch must never replace that reached source session.
  expect(diagnostic().bridge).toMatchObject({ focusId: 'container:web-app', sourceDetail: 'container', targetDetail: 'component' });
});

it('keeps a cold reloaded measured code lens through real pan-settle idle below the global code floor', async () => {
  await act(async () => root.unmount());
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
  const selected = snapshot.entities.find(entity => entity.kind === 'code' && entity.parentId === 'component:web-navigation')!;
  const source = fixture.createScene('container:web-app');
  const bounds = semanticBounds(source, 'component:web-navigation', 'component')!;
  const zoom = reveal.fullZoom * 1.01;
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d&root=component%3Aweb-navigation&sel=${encodeURIComponent(selected.id)}&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&lens=component%3Aweb-navigation&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=${zoom}`);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  const coldCompile = vi.spyOn(fixture, 'createSceneAsync');
  root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  const shell = host.querySelector('[data-testid="atlas-app"]')!;
  expect(coldCompile).toHaveBeenCalled();
  const reloadedScene = await coldCompile.mock.results[0]!.value;
  expect(reloadedScene.projection!.semanticTransitionsByEntityId!['component:web-navigation']!.code!.minZoom).toBeCloseTo(reveal.startZoom, 8);
  expect(shell.getAttribute('data-detail')).toBe('code');
  expect(new URL(window.location.href).searchParams.getAll('lens')).toEqual(['system:okie', 'container:web-app', 'component:web-navigation']);
  await act(async () => canvas.dispatchEvent(wheel({ deltaX: 8.5, deltaY: 2.5, clientX: 720, clientY: 450 })));
  await act(async () => { await vi.advanceTimersByTimeAsync(240); });
  expect(shell.getAttribute('data-detail')).toBe('code');
  expect(shell.getAttribute('data-root-entity-id')).toBe('component:web-navigation');
  expect(shell.getAttribute('data-selected-entity-id')).toBe(selected.id);
  expect(captured.camera.zoom).toBeCloseTo(zoom, 3);
  expect(captured.camera.zoom).toBeLessThan(7.1);
  expect(new URL(window.location.href).searchParams.getAll('lens')).toEqual(['system:okie', 'container:web-app', 'component:web-navigation']);
  expect(host.textContent).not.toContain('camera-incoherent semantic lens');
});
