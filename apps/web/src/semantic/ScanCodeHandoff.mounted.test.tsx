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
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: mapWidth, height: mapHeight } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
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

it.each(['mouse', 'pinch'] as const)('freezes the cold code reveal window while later %s zoom and pan input continue', async mode => {
  inputMode = mode;
  let resolve!: () => void;
  const original = fixture.createSceneAsync.bind(fixture);
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => { resolve = () => done(fixture.createScene(focus, previous, residency)); }));
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

it('retains published reveal progress on the first outward pinch inside the deadband', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => {
    resolve = () => done(fixture.createScene(focus, previous, residency));
  }));
  await zoomTo(reveal.startZoom * 1.01); await settle();
  const completionZoom = reveal.startZoom * Math.pow(reveal.fullZoom / reveal.startZoom, .9);
  await zoomTo(completionZoom);
  await act(async () => resolve()); await settle();
  const shell = host.querySelector('[data-testid="atlas-app"]')!;
  const published = diagnostic().bridge;
  expect(published.progress).toBeCloseTo(.9, 8);
  expect(shell.getAttribute('data-detail')).toBe('code');
  const lens = new URL(window.location.href).searchParams.getAll('lens');
  expect(lens).toContain('component:web-navigation');
  // No idle callback or further inward sample seeds the bridge's memory.
  await zoomTo(completionZoom * .999);
  expect(diagnostic().bridge.progress).toBeCloseTo(published.progress, 8);
  expect(shell.getAttribute('data-detail')).toBe('code');
  expect(new URL(window.location.href).searchParams.getAll('lens')).toEqual(lens);
});

it('aborts an obsolete cold code compile when input reverses before publication', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  let signal!: AbortSignal;
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency, requestSignal) => {
    signal = requestSignal!;
    return new Promise<AtlasScene>(done => { resolve = () => done(fixture.createScene(focus, previous, residency)); });
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

it('reveals code inside a narrow phone map instead of requiring a desktop-width face', async () => {
  inputMode = 'pinch';
  await act(async () => root.unmount());
  mapWidth = 390; mapHeight = 844;
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
  const source = fixture.createScene('container:web-app');
  const bounds = semanticBounds(source, 'component:web-navigation', 'component')!;
  const expectedFull = mapWidth * .42 * 1.5 / bounds.width;
  const start = mapWidth * .42 * 1.25 / bounds.width;
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=component%3Aweb-navigation&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=${start * .98}`);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  const narrowCompile = vi.spyOn(fixture, 'createSceneAsync');
  await zoomTo(expectedFull * 1.01, { x: mapWidth / 2, y: mapHeight / 2 }); await settle();
  const measured = diagnostic();
  const prepared = narrowCompile.mock.calls.find(call => call[0] === 'component:web-navigation');
  expect(prepared).toBeDefined();
  // The map is390px and every overlay has a zero rectangle in this fixture.
  const safeWidth = prepared![2]!.scanCodeSafeWidth!;
  expect(safeWidth).toBe(mapWidth);
  expect(measured.bridge.fullZoom).toBeCloseTo(Math.min(330, safeWidth * .42) * 1.5 / bounds.width, 8);
  expect(bounds.width * diagnostic().bridge.fullZoom).toBeLessThan(mapWidth);
  const savedFull = measured.bridge.fullZoom;
  await act(async () => root.unmount());
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
  const selected = snapshot.entities.find(entity => entity.kind === 'code' && entity.parentId === 'component:web-navigation')!;
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d&root=component%3Aweb-navigation&sel=${encodeURIComponent(selected.id)}&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&lens=component%3Aweb-navigation&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=${savedFull * 1.01}`);
  setActiveScanFixture(fixture); module.refreshAppScanFixture();
  const coldCompile = vi.spyOn(fixture, 'createSceneAsync');
  root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  const loaded = await coldCompile.mock.results[0]!.value;
  expect(loaded.projection!.semanticTransitionsByEntityId!['component:web-navigation']!.code!.fullZoom).toBeCloseTo(savedFull, 8);
  expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail')).toBe('code');

});

it('animates a late code publication through intermediate progress without another wheel and preserves pan', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => {
    resolve = () => done(fixture.createScene(focus, previous, residency));
  }));
  await zoomTo(reveal.startZoom * 1.01); await settle();
  await zoomTo(reveal.fullZoom * 1.2);
  expect(captured.camera.zoom).toBeGreaterThan(reveal.fullZoom);
  await act(async () => canvas.dispatchEvent(wheel({ deltaX: 17.5, deltaY: 4.5, clientX: 720, clientY: 450 })));
  const latest = { ...captured.camera };
  let clock = 8000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const frames = rafFrames;
  async function frame(delta: number) {
    clock += delta;
    const pending = [...frames.values()]; frames.clear();
    await act(async () => { for (const callback of pending) callback(clock); }); await settle();
  }
  await act(async () => resolve()); await settle();
  const initial = diagnostic().bridge.progress;
  expect(initial).toBeGreaterThanOrEqual(0);
  expect(initial).toBeLessThan(1);
  expect(captured.camera).toEqual(latest);
  expect(frames.size).toBeGreaterThan(0);
  await frame(90);
  await frame(0);
  const intermediate = diagnostic().bridge.progress;
  expect(intermediate).toBeGreaterThan(initial);
  expect(intermediate).toBeLessThan(1);
  expect(captured.state?.projectionOverride?.progress).toBeGreaterThan(0);
  expect(captured.state?.projectionOverride?.progress).toBeLessThan(1);
  await frame(100);
  expect(diagnostic().bridge.progress).toBe(1);
  expect(captured.camera).toEqual(latest);
  expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail')).toBe('code');
});

it('stops an owned late reveal when outward input abandons its branch', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => {
    resolve = () => done(fixture.createScene(focus, previous, residency));
  }));
  await zoomTo(reveal.startZoom * 1.01); await settle();
  await zoomTo(reveal.fullZoom * 1.2);
  expect(captured.camera.zoom).toBeGreaterThan(reveal.fullZoom);
  let clock = 8000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const frames = rafFrames;
  await act(async () => resolve()); await settle();
  expect(diagnostic().bridge.progress).toBeLessThan(1);
  await zoomTo(reveal.leaveStartZoom * .98); await settle();
  const reached = { ...captured.camera };
  const href = window.location.href;
  const pending = [...frames.values()]; frames.clear(); clock += 250;
  await act(async () => { for (const callback of pending) callback(clock); }); await settle();
  expect(captured.camera).toEqual(reached);
  expect(window.location.href).toBe(href);
  expect(new URL(window.location.href).searchParams.getAll('lens')).not.toContain('component:web-navigation');
  expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail')).toBe('component');
});

it('does not publish a cancelled late code branch after Escape and a queued RAF callback', async () => {
  inputMode = 'pinch';
  let resolve!: () => void;
  vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => {
    resolve = () => done(fixture.createScene(focus, previous, residency));
  }));
  await zoomTo(reveal.startZoom * 1.01); await settle();
  await zoomTo(reveal.fullZoom * 1.2);
  expect(captured.camera.zoom).toBeGreaterThan(reveal.fullZoom);
  // Below the real clock, so the zoom-assist frame queued before Escape is still inside
  // its window (8000 only did so in a long-running worker).
  let clock = 1;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const frames = rafFrames;
  await act(async () => resolve()); await settle();
  const pending = [...frames.values()];
  expect(pending.length).toBeGreaterThan(0);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle();
  const reachedDetail = host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail');
  const reached = { ...captured.camera };
  const href = window.location.href;
  clock += 250;
  await act(async () => { for (const callback of pending) callback(clock); }); await settle();
  expect(captured.camera).toEqual(reached);
  expect(window.location.href).toBe(href);
  expect(new URL(window.location.href).searchParams.getAll('lens')).not.toContain('component:web-navigation');
  expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail')).toBe(reachedDetail);
});
